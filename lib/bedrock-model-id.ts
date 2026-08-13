/**
 * Normalise a Bedrock model id before it reaches the client.
 *
 * Ported from the reference implementation this deployment shares with its sibling services —
 * dwight's `_bedrock_invoke_model_id` (`agent-service/app/llm_client.py:1131`), re-verified against
 * the same logic in `org-agent/agent/engine/llm_client.py:87`, which is itself a port of it. Both
 * carry an executable spec (`tests/test_bedrock_model_id.py`) that the tests here mirror.
 *
 * WHY THIS IS NOT A ONE-LINER, and why the previous one-liner was wrong. Bedrock accepts four
 * different shapes of model identifier and the correct handling differs for each:
 *
 *   1. `arn:aws:bedrock:…:application-inference-profile/<id>` — a full ARN. Pass through.
 *   2. `global.` / `us.` / `eu.` / `apac.` prefixed — a cross-region inference profile. Pass through.
 *   3. `anthropic.claude-…` — a foundation id. Pass through, except for the two that newer models
 *      reject with a 400 demanding a cross-region profile; those are remapped.
 *   4. A bare 12-character-ish token like `3s3wyt6beb2x` — an **application inference profile id**.
 *      This is what a team is handed for per-project cost attribution, and it must be expanded into
 *      the full ARN of shape 1 before it will resolve.
 *
 * The old code did `model.startsWith('anthropic.') ? model : 'anthropic.' + model` for every input,
 * which turned a profile id into `anthropic.3s3wyt6beb2x` — a shape Bedrock has no way to interpret,
 * producing a 404 that reads exactly like "this region does not serve that model". Two sessions then
 * argued from documentation about whether ids are prefixed or bare. Neither position was right: it
 * depends on which of the four shapes you hold, and reading the working implementation settled in
 * minutes what the argument could not.
 *
 * Nothing here knows which Claude model sits behind a profile id — that is chosen by whoever created
 * the profile in AWS, which is the point of the indirection.
 */

/**
 * Explicit foundation-id remaps, copied from the reference. The upstream comment records why:
 * "newer Anthropic models reject bare `anthropic.…` with a 400 asking for a `global.…` / `us.…`
 * profile".
 *
 * Kept as an exact-match table so a future one-off mapping has somewhere to live, but note that
 * `foundationId()` below now generalises the same rule to every `anthropic.claude-*` id — both of
 * these entries are simply `global.` + the input.
 */
const FOUNDATION_REMAP: Record<string, string> = {
  'anthropic.claude-opus-4-6-v1': 'global.anthropic.claude-opus-4-6-v1',
  'anthropic.claude-sonnet-4-6': 'global.anthropic.claude-sonnet-4-6',
};

/**
 * A foundation id, routed through a cross-region inference profile.
 *
 * The generalisation beyond the reference's two-entry table was forced by a live 400:
 *
 *   Invocation of model ID anthropic.claude-opus-5 with on-demand throughput isn't supported.
 *   Retry your request with the ID or ARN of an inference profile that contains this model.
 *
 * Which is the same failure the upstream comment describes, on a model its table does not list. A
 * `global.` / `us.` prefixed id IS an inference profile, so the fix the API asks for is exactly the
 * mapping the table was already performing — it was just enumerated rather than expressed. Anything
 * that is not an `anthropic.claude-*` id is left alone, so the reference's
 * "unknown foundation id passes through unchanged" behaviour is preserved.
 */
function foundationId(m: string): string {
  const explicit = FOUNDATION_REMAP[m];
  if (explicit) return explicit;
  return /^anthropic\.claude-/i.test(m) ? `global.${m}` : m;
}

/**
 * Characters whose absence marks a value as a BARE application-inference-profile id: foundation ids
 * and cross-region profiles contain `.`, ARNs contain `:` and `/`.
 */
const BARE_PROFILE_ID_DISALLOWED = ['.', ':', '/'];

function isBareProfileId(m: string): boolean {
  return Boolean(m) && !m.startsWith('arn:') && !BARE_PROFILE_ID_DISALLOWED.some((c) => m.includes(c));
}

/** Resolved ARNs are cached so a repeated lookup is free and logs once. */
const resolved = new Map<string, string>();

export class BedrockModelIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BedrockModelIdError';
  }
}

/**
 * THIS MODULE IS PURE. It reads no environment, opens no socket, and imports no vendor SDK.
 *
 * Only a bare application-inference-profile id needs an AWS account id, and learning that account
 * means AWS credentials and a signed STS call — which belongs with the Bedrock provider, behind the
 * boundary `check:ship` enforces, not in a string-normalisation module. So the account arrives as an
 * argument and the caller decides where it came from.
 *
 * The practical benefit is that every shape rule here is testable with no network and no mocking.
 */

/**
 * True when this value needs the AWS account id — i.e. it is a bare profile id, not a foundation
 * model that merely looks like one.
 *
 * A foundation model named without its prefix (`claude-sonnet-5`) also contains none of `. : /`, so
 * it would be misread as a profile id and expanded into a nonsense ARN. The reference never hits
 * this because its Bedrock path is always handed a profile id.
 *
 * Exported so a caller can tell whether it is worth resolving an account at all — that is what keeps
 * the STS call off every other code path.
 */
export function needsAccountId(model: string): boolean {
  const m = (model ?? '').trim();
  return isBareProfileId(m) && !/^claude-/i.test(m);
}

/** Every shape that resolves without knowing the account. */
function resolveWithoutAccount(m: string): string {
  if (isBareProfileId(m)) return foundationId(`anthropic.${m}`); // a bare `claude-*` name
  if (m.startsWith('arn:')) return m; // 1 — already an ARN
  if (/^(global|us|eu|apac)\./i.test(m)) return m; // 2 — cross-region inference profile
  return foundationId(m); // 3 — foundation id, routed through a cross-region profile
}

/**
 * Resolve `LLM_MODEL` to the identifier Bedrock accepts.
 *
 * @param model the configured value, any of the four shapes above
 * @param region needed only to build an inference-profile ARN
 * @param accountId needed only for a BARE profile id. Pass `needsAccountId(model)` first to decide
 *        whether resolving one is worth the effort.
 */
export function bedrockModelId(model: string, region?: string, accountId?: string | null): string {
  const m = (model ?? '').trim();
  if (!m) return m;
  if (!needsAccountId(m)) return resolveWithoutAccount(m);

  const cached = resolved.get(m);
  if (cached) return cached;
  if (!region) {
    throw new BedrockModelIdError(
      `AWS_REGION is not set, and it is needed to expand the application-inference-profile id "${m}" into an ARN.`,
    );
  }
  /**
   * No account, no ARN. The reference sends the bare id through with a warning here; Bedrock then
   * rejects it with a 404 that reads exactly like "this region does not serve that model" — the most
   * misleading failure in this whole integration. Fail with the remedy instead.
   */
  if (!accountId) {
    throw new BedrockModelIdError(
      `Could not determine the AWS account id, needed to expand the application-inference-profile ` +
        `id "${m}" into an ARN.\n` +
        `  • AWS_ACCOUNT_ID is unset and sts:GetCallerIdentity in ${region} did not answer.\n` +
        '  • Set AWS_ACCOUNT_ID, or set LLM_MODEL to the full profile ARN, or leave LLM_MODEL unset ' +
        'to use the cross-region default — which needs no account id at all.',
    );
  }
  const arn = `arn:aws:bedrock:${region}:${accountId}:application-inference-profile/${m}`;
  resolved.set(m, arn);
  return arn;
}

/** Test seam: the ARN cache is process-wide, so tests that vary region/account must clear it. */
export function __clearBedrockModelIdCache(): void {
  resolved.clear();
}
