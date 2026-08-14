/**
 * THE CAPABILITY REGISTRY — harness part 5.
 *
 * ★ This is the one file you edit to swap a provider. ★
 *
 * Which model or API each step calls is config, not code. Steps ask the registry for "the
 * current STT provider"; they never import a vendor SDK. That is what makes the PyAI swap (or
 * the swap away from it) a one-line change, and it is also how the zero-setup demo works: the
 * `fixture` STT provider replays committed sample results with no network at all.
 *
 * If you ever find yourself importing a vendor SDK inside ingestion or extraction, stop and
 * route it through here instead.
 */
import { describeExtractor, isRealModelExtractor } from '@/lib/provenance';
import type { ExtractProvider, STTProvider, TTSProvider } from './types';

/**
 * Pick an extraction engine from whatever credentials exist. First-party wins over Bedrock only
 * because it needs less setup; either is a real model. The stub is the last resort and is loudly
 * flagged everywhere it is used.
 */
type ExtractProviderName = 'claude' | 'bedrock' | 'recap' | 'stub-heuristic';

/**
 * `recap` is deliberately NOT auto-detected.
 *
 * A PyAI key exists on effectively every machine that runs this — `lib/pyai.ts` mints a sandbox one
 * on first use — so detecting Recap from credential presence would silently move every install off
 * Claude and onto an engine that cannot honour `skills/` or account context. Recap is opt-in, by
 * `LLM_PROVIDER` or the per-upload picker, and never by accident.
 */
function detectExtractProvider(): ExtractProviderName {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return 'claude';
  const awsRegion = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  const awsCreds =
    (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
    process.env.AWS_BEARER_TOKEN_BEDROCK ||
    process.env.AWS_PROFILE;
  if (awsRegion && awsCreds) return 'bedrock';
  return 'stub-heuristic';
}

/**
 * `LLM_PROVIDER` → our provider name.
 *
 * These two variable names (`LLM_PROVIDER`, `LLM_MODEL`) are deliberately the ones used across the
 * other services this is deployed alongside, so one Railway configuration works everywhere. The
 * accepted spellings are generous — case is ignored and any run of non-alphanumerics folds to `_`,
 * so `anthropic_bedrock`, `anthropic-bedrock` and `ANTHROPIC BEDROCK` all land in the same place.
 */
const PROVIDER_ALIASES: Record<string, ExtractProviderName> = {
  anthropic_bedrock: 'bedrock',
  aws_bedrock: 'bedrock',
  bedrock: 'bedrock',
  anthropic: 'claude',
  anthropic_api: 'claude',
  claude: 'claude',
  recap: 'recap',
  pyai_recap: 'recap',
  pyai: 'recap',
  stub: 'stub-heuristic',
  stub_heuristic: 'stub-heuristic',
  heuristic: 'stub-heuristic',
  none: 'stub-heuristic',
};

/**
 * Resolve `LLM_PROVIDER`, or null when it is unset.
 *
 * THROWS on an unrecognised value rather than falling back to auto-detection. That is the whole
 * point: with a silent fallback, `LLM_PROVIDER=antropic_bedrock` would quietly resolve to the
 * keyword stub on a machine with no other credentials, and the app would then produce
 * stub-generated notes that look like model output. This repo has already shipped that exact bug
 * once in another guise — the upload route cast an unvalidated form value, so anything that was not
 * literally 'channel' fell into a bare `else` and diarized, making a typo indistinguishable from a
 * deliberate choice. Validate, never coerce.
 */
function providerFromEnv(): ExtractProviderName | null {
  const raw = process.env.LLM_PROVIDER?.trim();
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const resolved = PROVIDER_ALIASES[key];
  if (!resolved) {
    throw new Error(
      `LLM_PROVIDER="${raw}" is not recognised. Accepted values: ` +
        `${Object.keys(PROVIDER_ALIASES).join(', ')}.\n` +
        'Leave it unset to auto-detect from whichever credentials are present.',
    );
  }
  return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG — swap providers here (or via env, so a demo can flip without a rebuild)
// ─────────────────────────────────────────────────────────────────────────────

export const REGISTRY_CONFIG = {
  /**
   * 'pyai-jobs-chunked' — PyAI Hear batch jobs, auto-chunked for long mono calls. Default.
   *                       Falls through to the plain single-job path, unchanged, for anything
   *                       under 6 minutes or not mono 16-bit WAV — see pyai-jobs-chunked.ts for
   *                       why: a 13-minute real call reliably 500'd on PyAI's own stt/diarize
   *                       stage as one job and succeeded every time split into ~200s chunks.
   * 'pyai-jobs'         — the plain single-job path, with no chunking. Still available via
   *                       OPENGONG_STT=pyai-jobs for anyone who wants it.
   * 'fixture'           — replay committed sample JSON. No network. Powers the zero-setup demo.
   */
  stt: (process.env.OPENGONG_STT ?? 'pyai-jobs-chunked') as
    | 'pyai-jobs-chunked'
    | 'pyai-jobs'
    | 'fixture',

  /**
   * 'claude'         — first-party Anthropic API. Needs ANTHROPIC_API_KEY.
   * 'bedrock'        — Claude on AWS Bedrock. Needs AWS creds + AWS_REGION + model access.
   * 'recap'          — PyAI Recap. Needs a PYAI_API_KEY with `recap:read`, and Recap enabled on the
   *                    org. A real model writes the notes, but it takes no prompt, so `skills/` and
   *                    account context cannot reach it and citations are resolved by us rather than
   *                    asserted by it. Opt-in only — see detectExtractProvider.
   * 'stub-heuristic' — deterministic keyword stub. NOT a model, never demo it.
   *
   * Auto-detected from available credentials so a fresh clone works with whatever you have;
   * `LLM_PROVIDER` overrides (and an unrecognised value throws — see providerFromEnv). A single
   * upload can override it again via the picker, without changing this default.
   */
  extract: providerFromEnv() ?? detectExtractProvider(),

  /**
   * Sample-call generation only — never on the request path.
   * 'macos-say'  — macOS built-in `say`. Works today.
   * 'pyai-speak' — PyAI Speak. Preferred, but returned 503 upstream_error all through H0;
   *                see docs/api-truth.md. Flip this the moment it recovers.
   */
  tts: (process.env.OPENGONG_TTS ?? 'macos-say') as 'macos-say' | 'pyai-speak',

  /**
   * Claude model + effort for extraction. `LLM_MODEL` names the model.
   *
   * THE DEFAULT IS A CROSS-REGION INFERENCE PROFILE, deliberately, and it has to be. An AWS account
   * without provisioned throughput cannot invoke a *foundation* model on-demand at all — Bedrock
   * answers "Invocation of model ID … with on-demand throughput isn't supported. Retry with the ID
   * or ARN of an inference profile". A `global.`-prefixed id IS an inference profile, so it works
   * with nothing else configured: no account id, no region arithmetic, no provisioned capacity.
   *
   * This exact value is the sibling services' own remap target, so it is known-good in this AWS org.
   * It is written out in full rather than leaning on the `claude-*` → `global.anthropic.*` rule in
   * lib/bedrock-model-id.ts, so the value that ships is the value that gets sent.
   *
   * A previous version defaulted to `claude-opus-5` — correct for the first-party API, rejected by
   * Bedrock — and then, when that failed, refused to start at all unless LLM_MODEL was set. Both
   * were wrong: a default the platform rejects is a bug, and refusing to start over an unset
   * optional variable is a worse one.
   *
   * See lib/bedrock-model-id.ts for the four id shapes and how each is resolved.
   */
  extractModel: process.env.LLM_MODEL?.trim() || 'global.anthropic.claude-sonnet-4-6',
  extractEffort: (process.env.OPENGONG_EFFORT ?? 'high') as
    | 'low'
    | 'medium'
    | 'high'
    | 'xhigh'
    | 'max',

  /**
   * BUDGET GOVERNOR caps — harness part 7. Enforced BEFORE each model call, not logged after.
   * A run that would exceed any of these stops and exits with run_status 'deadline'.
   */
  budget: {
    maxInputTokens: Number(process.env.OPENGONG_MAX_INPUT_TOKENS ?? 180_000),
    maxOutputTokens: Number(process.env.OPENGONG_MAX_OUTPUT_TOKENS ?? 16_000),
    maxWallClockMs: Number(process.env.OPENGONG_MAX_WALL_MS ?? 180_000),
    maxUsd: Number(process.env.OPENGONG_MAX_USD ?? 1.0),
  },

  /**
   * Tier-2 citation support threshold. A claim whose cited segments score below this still
   * ships, but flagged `unverified`. Tuned in docs/decisions.md; kept here so it is one edit.
   */
  supportThreshold: Number(process.env.OPENGONG_SUPPORT_THRESHOLD ?? 0.18),

  /** Bounded aimed retry: total attempts per step, including the first. */
  maxAttempts: Number(process.env.OPENGONG_MAX_ATTEMPTS ?? 2),
} as const;

/** Claude Opus 5 list price, for the budget governor's USD estimate. */
export const PRICING_USD_PER_MTOK = { input: 5, output: 25 } as const;

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

const sttFactories: Record<string, () => Promise<STTProvider>> = {
  'pyai-jobs-chunked': async () =>
    (await import('./providers/pyai-jobs-chunked')).pyaiJobsChunkedSTT(),
  'pyai-jobs': async () => (await import('./providers/pyai-jobs')).pyaiJobsSTT(),
  fixture: async () => (await import('./providers/fixture')).fixtureSTT(),
};

const extractFactories: Record<string, () => Promise<ExtractProvider>> = {
  claude: async () => (await import('./providers/claude-extract')).claudeExtractor(),
  bedrock: async () => (await import('./providers/bedrock-extract')).bedrockExtractor(),
  recap: async () => (await import('./providers/recap-extract')).recapExtractor(),
  'stub-heuristic': async () =>
    (await import('./providers/stub-heuristic')).stubHeuristicExtractor(),
};

/**
 * The engine names a request may ask for by name.
 *
 * Exported so `app/api/calls/route.ts` can validate an uploaded form value against the real table
 * rather than keeping a second hand-maintained list that could drift out of sync with it. The stub
 * is excluded on purpose: it is a fallback for a machine with no credentials, never something a user
 * should be able to select and be shown non-model notes from.
 */
export const SELECTABLE_EXTRACTORS = ['claude', 'bedrock', 'recap'] as const;

const ttsFactories: Record<string, () => Promise<TTSProvider>> = {
  'macos-say': async () => (await import('./providers/macos-say')).macosSayTTS(),
  'pyai-speak': async () => (await import('./providers/pyai-speak')).pyaiSpeakTTS(),
};

function resolve<T>(
  kind: string,
  table: Record<string, () => Promise<T>>,
  name: string,
): Promise<T> {
  const factory = table[name];
  if (!factory) {
    throw new Error(
      `Registry: no ${kind} provider named "${name}". Available: ${Object.keys(table).join(', ')}. ` +
        `Fix REGISTRY_CONFIG in lib/registry/index.ts.`,
    );
  }
  return factory();
}

export const getSTT = (override?: string) =>
  resolve('stt', sttFactories, override ?? REGISTRY_CONFIG.stt);

/**
 * `override` lets a single upload choose its notes engine without changing the deployment's default,
 * matching what `getSTT` has always allowed. It is a NAME, already validated by the caller — this
 * function does not coerce, and `resolve` throws on anything it does not recognise.
 */
export const getExtractor = (override?: string) =>
  resolve('extract', extractFactories, override ?? REGISTRY_CONFIG.extract);

export const getTTS = (override?: string) =>
  resolve('tts', ttsFactories, override ?? REGISTRY_CONFIG.tts);

/**
 * Providers whose output is genuinely model-generated. The UI banner and `check:ship` both read
 * this, so there is exactly one definition of "is this real output?".
 */
export { REAL_MODEL_EXTRACTORS, isRealModelExtractor } from '@/lib/provenance';

import { enabledSkills, loadSkills } from '@/lib/skills';

/** Shown in the UI footer so a judge can see what actually ran. Honesty as a feature. */
export function describeRegistry() {
  const extract = REGISTRY_CONFIG.extract;
  return {
    stt: REGISTRY_CONFIG.stt,
    extract,
    /**
     * Describes the CONFIGURED extractor — i.e. what a new upload would be analysed by. It says
     * nothing about the provenance of notes already on screen, which can differ (a committed
     * sample may have been produced by something else entirely). That distinction is drawn in the
     * UI rather than blurred here.
     */
    /**
     * `recap` is a real model but not OUR model: `LLM_MODEL` and `OPENGONG_EFFORT` do not reach it,
     * so printing them here would describe a configuration that had no effect on the notes.
     */
    extractDetail:
      extract === 'recap'
        ? `recap · PyAI Recap${
            process.env.OPENGONG_RECAP_PACK_ID
              ? ` · pack=${process.env.OPENGONG_RECAP_PACK_ID}`
              : " · org's default pack"
          } · takes no prompt, so skills are not applied`
        : isRealModelExtractor(extract)
          ? `${extract} · ${REGISTRY_CONFIG.extractModel} · effort=${REGISTRY_CONFIG.extractEffort}`
          : `${extract} · ${describeExtractor(extract).detail}`,
    extractIsRealModel: isRealModelExtractor(extract),
    /**
     * Whether the configured engine can be given instructions at all. The home page reads this to
     * stop the "Skills loaded" row implying a corpus that a prompt-blind engine never receives.
     */
    extractTakesPrompt: extract !== 'recap',
    tts: REGISTRY_CONFIG.tts,
    supportThreshold: REGISTRY_CONFIG.supportThreshold,
    budget: REGISTRY_CONFIG.budget,
    /**
     * The skills a new upload COULD be read under — the whole enabled corpus, not the subset a
     * given call selects, since `applies_to` is only resolvable once there is a company. Same
     * distinction the extractor line draws: this describes the configuration, not any call's notes.
     *
     * Never throws: a malformed SKILL.md must fail the extraction that would have used it, loudly,
     * not take down the home page that merely wants to describe the setup.
     */
    skills: (() => {
      try {
        return enabledSkills(loadSkills()).map((s) => s.id);
      } catch {
        return [];
      }
    })(),
  };
}
