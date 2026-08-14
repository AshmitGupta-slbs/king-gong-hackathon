/**
 * Can a notes engine work on this machine, right now? Answered with NO network call.
 *
 * ── Why this is its own module, and not inside the providers ──
 *
 * Two consumers need the same answer, and one of them must not touch a provider file:
 *
 *   - `lib/harness/loop.ts` asks before spending anything, so a run that cannot succeed fails first.
 *   - `describeRegistry()` asks so the upload picker can grey out an impossible engine.
 *
 * `describeRegistry()` runs on every render of the home page. `lib/registry/providers/bedrock-extract.ts`
 * imports `@anthropic-ai/bedrock-sdk` at line 31, so reaching into it for a credential predicate would
 * pull the Bedrock SDK into module init on every render — and `scripts/check-ship.ts:459` fails the build
 * for exactly that, counting dynamic `import()` too. `lib/provenance.ts` exists for the same reason and
 * says so in its header.
 *
 * So the predicates live here, dependency-free apart from `describeKey` (which is plain fetch + node:fs),
 * and the providers delegate to them. One definition, so the picker and the harness cannot disagree
 * about whether an engine is usable — a disagreement would show up as a greyed-out option that works, or
 * a selectable one that cannot.
 *
 * ── Why this exists at all ──
 *
 * A tester chose PyAI Recap with a self-minted sandbox key. The run transcribed her audio and THEN failed
 * on a 403 for `recap:read`, a scope sandbox keys are never issued. She did it six times: 3.2 minutes of
 * Hear bought nothing. The error message was already accurate about the cause and the fix — it just
 * arrived after the money.
 */
import { describeKey } from '@/lib/pyai';

/**
 * `'unknown'` is a real answer, not a hedge.
 *
 * Whether a `pyai_live_` key carries `recap:read` can only be settled by asking PyAI, and whether an AWS
 * account can invoke a given Bedrock model likewise. Refusing something that would have worked is the
 * same class of mistake as accepting something that cannot, so only a CERTAIN no is enforced.
 */
export type EngineAvailability =
  | { available: true }
  | { available: 'unknown'; note: string }
  | { available: false; code: string; message: string; remedy: string };

/**
 * The Anthropic credential test, in one place.
 *
 * This boolean was open-coded in four files (`claude-extract.ts`, `lib/registry/index.ts`,
 * `lib/scoring/score.ts`, `scripts/_env.ts`). They agreed, which is luck rather than design.
 */
export const hasAnthropicCredential = () =>
  Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

/**
 * The AWS credential test, in one place — and the BROADEST of the three copies that existed.
 *
 * `bedrock-extract.ts` accepted ECS and IRSA variables that `detectExtractProvider()` and
 * `credentialSummary()` both omitted, so the same machine could be told it had Bedrock by one code path
 * and not by another. This is the union, which is the one that matches what the SDK will actually try.
 */
export const hasAwsCredential = () =>
  Boolean(
    (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
      process.env.AWS_BEARER_TOKEN_BEDROCK ||
      process.env.AWS_PROFILE ||
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
      process.env.AWS_WEB_IDENTITY_TOKEN_FILE,
  );

export const awsRegion = () => process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;

/** Shared by the precheck and by every doc that explains the sandbox limitation. */
export const RECAP_SCOPE_REMEDY =
  'PyAI Recap needs a key with the `recap:read` scope and Recap enabled for the organisation. A ' +
  'self-minted sandbox key has neither. Set PYAI_API_KEY to a pyai_live_ key from ' +
  'https://console.pyai.com, check it with `npx tsx scripts/probe/recap-probe.ts`, or pick Claude ' +
  'instead (LLM_PROVIDER=anthropic, or the engine picker on the upload form).';

function claudeAvailable(): EngineAvailability {
  if (hasAnthropicCredential()) return { available: true };
  return {
    available: false,
    code: 'no_anthropic_credential',
    message: 'No Anthropic credential is set, so Claude cannot write the notes.',
    remedy:
      'Set ANTHROPIC_API_KEY (from https://console.anthropic.com), or choose a different engine: ' +
      'Bedrock with AWS credentials, or PyAI Recap with a pyai_live_ key that has recap:read.',
  };
}

function bedrockAvailable(): EngineAvailability {
  if (!hasAwsCredential()) {
    return {
      available: false,
      code: 'no_aws_credentials',
      message: 'No AWS credentials are set, so Claude on Bedrock cannot write the notes.',
      remedy:
        'Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (or AWS_PROFILE), plus AWS_REGION. Then ' +
        '`npm run check:model` reports which model ids this account actually accepts.',
    };
  }
  if (!awsRegion()) {
    return {
      available: false,
      code: 'no_aws_region',
      message: 'AWS credentials are set but AWS_REGION is not, and Bedrock cannot be addressed without one.',
      remedy:
        'Set AWS_REGION (for example us-east-1). Note this is not read from ~/.aws/config. Then run ' +
        '`npm run check:model`.',
    };
  }
  // Credentials and a region exist. Whether this account can invoke the MODEL is a network fact, which
  // is what `npm run check:model` is for -- and getting it wrong yields a 404 that reads like a naming
  // problem, so it is not worth guessing at.
  return { available: 'unknown', note: 'model access in this region can only be confirmed by a probe' };
}

/**
 * Recap, decided from the key's PREFIX.
 *
 * Read off the minted key on the development machine rather than inferred: a sandbox key carries
 * `hear:transcribe hear:stream transcribe:jobs voice:synthesize omni:session nova:run amd:* cast:render`
 * and no `recap:*` at all. So sandbox, or no key yet, is a certain no — and it is worth saying in the
 * message that the same key transcribes perfectly well, because otherwise "your key does not work" reads
 * as broader than it is.
 */
function recapAvailable(): EngineAvailability {
  const key = describeKey();
  if (key.source === 'none') {
    return {
      available: false,
      code: 'no_pyai_key',
      message:
        'No PyAI key is set. A free sandbox key mints itself for transcription, but sandbox keys are ' +
        'never issued with recap:read, so Recap cannot write the notes.',
      remedy: RECAP_SCOPE_REMEDY,
    };
  }
  if (key.sandbox) {
    return {
      available: false,
      code: 'sandbox_key_no_recap',
      message:
        'This is a sandbox key (pyai_test_). It transcribes fine, but sandbox keys are never issued ' +
        'with the recap:read scope, so Recap cannot write the notes.',
      remedy: RECAP_SCOPE_REMEDY,
    };
  }
  return {
    available: 'unknown',
    note: 'a live key usually carries recap:read, but only PyAI can confirm the scope and the org add-on',
  };
}

/**
 * Availability by engine NAME, so a caller can ask without resolving the provider.
 *
 * Deliberately name-based: resolving the provider means a dynamic import of its vendor SDK, and the
 * whole point is to answer before doing any work. An unrecognised name is reported rather than thrown,
 * because the harness would otherwise only discover a bad `--engine` value after transcription.
 */
export function engineAvailability(name: string): EngineAvailability {
  switch (name) {
    case 'claude':
      return claudeAvailable();
    case 'bedrock':
      return bedrockAvailable();
    case 'recap':
      return recapAvailable();
    case 'stub-heuristic':
      // Needs nothing, which is the entire reason it exists as the last resort.
      return { available: true };
    default:
      return {
        available: false,
        code: 'unknown_engine',
        message: `"${name}" is not a notes engine this build knows about.`,
        remedy: 'Choose one of: claude, bedrock, recap.',
      };
  }
}
