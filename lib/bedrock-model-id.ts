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
 * The account id that goes into the ARN.
 *
 * DELIBERATE DIVERGENCE FROM THE REFERENCE. Upstream falls back to a one-shot STS
 * `get_caller_identity()` via boto3 when `AWS_ACCOUNT_ID` is unset, and — importantly — returns the
 * *unexpanded* id with only a `logger.warning` when it cannot resolve one. Its own tests cover that
 * path (`test_degrades_when_account_unresolvable`).
 *
 * We do neither. An STS call means adding an AWS SDK to a repo whose entire setup claim is that a
 * clone compiles nothing, and degrading silently means shipping a request we already know will fail
 * with a 404 that looks like a region problem — which is precisely the confusion that cost this
 * project a day. So: read the env var, and throw with the fix in the message if it is missing.
 */
function accountId(): string {
  const fromEnv = process.env.AWS_ACCOUNT_ID?.trim();
  if (fromEnv) return fromEnv;
  throw new BedrockModelIdError(
    'AWS_ACCOUNT_ID is not set, and it is needed to expand a bare application-inference-profile id ' +
      'into an ARN.\n' +
      '  • Set AWS_ACCOUNT_ID to the account that owns the profile, or\n' +
      '  • set LLM_MODEL to the full ARN, a cross-region profile (global.anthropic.…), or a ' +
      'foundation id (claude-sonnet-5).\n' +
      'Sending the bare id through unexpanded would return a 404 indistinguishable from "this ' +
      'region does not serve that model", so this fails here instead.',
  );
}

/**
 * Resolve `LLM_MODEL` to the identifier Bedrock actually accepts.
 *
 * @param model the configured value, any of the four shapes above
 * @param region AWS region the profile lives in; required only for the bare-id case
 */
export function bedrockModelId(model: string, region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION): string {
  const m = (model ?? '').trim();
  if (!m) return m;

  // 4 — bare application-inference-profile id. Checked FIRST, as upstream does, because the test is
  // an absence of characters and every other shape is identified by their presence.
  if (isBareProfileId(m)) {
    // A foundation model named without its prefix (`claude-sonnet-5`) also contains none of
    // `. : /`, so it would be misread as a profile id. Upstream never hits this because its Bedrock
    // path is always given a profile id, but our own default is `claude-opus-5`, so it does. Treat a
    // leading `claude-` as a foundation id and let the prefix rule below apply.
    if (/^claude-/i.test(m)) return foundationId(`anthropic.${m}`);
    const cached = resolved.get(m);
    if (cached) return cached;
    if (!region) {
      throw new BedrockModelIdError(
        `AWS_REGION is not set, and it is needed to expand the application-inference-profile id "${m}" into an ARN.`,
      );
    }
    const arn = `arn:aws:bedrock:${region}:${accountId()}:application-inference-profile/${m}`;
    resolved.set(m, arn);
    return arn;
  }

  // 1 — already an ARN.
  if (m.startsWith('arn:')) return m;

  // 2 — cross-region inference profile.
  if (/^(global|us|eu|apac)\./i.test(m)) return m;

  // 3 — foundation id, routed through a cross-region profile.
  return foundationId(m);
}

/** Test seam: the ARN cache is process-wide, so tests that vary region/account must clear it. */
export function __clearBedrockModelIdCache(): void {
  resolved.clear();
}
