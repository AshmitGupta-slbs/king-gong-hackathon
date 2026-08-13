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
import type { ExtractProvider, STTProvider, TTSProvider } from './types';

/**
 * Pick an extraction engine from whatever credentials exist. First-party wins over Bedrock only
 * because it needs less setup; either is a real model. The stub is the last resort and is loudly
 * flagged everywhere it is used.
 */
type ExtractProviderName = 'claude' | 'bedrock' | 'stub-heuristic';

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
   * 'pyai-jobs' — PyAI Hear batch jobs. Real transcription, burns Hear minutes. Default.
   * 'fixture'   — replay committed sample JSON. No network. Powers the zero-setup demo.
   */
  stt: (process.env.OPENGONG_STT ?? 'pyai-jobs') as 'pyai-jobs' | 'fixture',

  /**
   * 'claude'         — first-party Anthropic API. Needs ANTHROPIC_API_KEY.
   * 'bedrock'        — Claude on AWS Bedrock. Needs AWS creds + AWS_REGION + model access.
   * 'stub-heuristic' — deterministic keyword stub. NOT a model, never demo it.
   *
   * Auto-detected from available credentials so a fresh clone works with whatever you have;
   * `LLM_PROVIDER` overrides (and an unrecognised value throws — see providerFromEnv).
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
   * Claude model + effort for extraction.
   *
   * `LLM_MODEL` names the model. On Bedrock the provider adds the required `anthropic.` prefix if
   * it is absent, so either form works here — but the value must be a REAL model id. An opaque
   * handle from a gateway that maps model names (`3s3wyt6beb2x` and the like) has nothing in this
   * path to resolve it and will come back as `404 not_found_error`.
   */
  extractModel: process.env.LLM_MODEL ?? 'claude-opus-5',
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
  'pyai-jobs': async () => (await import('./providers/pyai-jobs')).pyaiJobsSTT(),
  fixture: async () => (await import('./providers/fixture')).fixtureSTT(),
};

const extractFactories: Record<string, () => Promise<ExtractProvider>> = {
  claude: async () => (await import('./providers/claude-extract')).claudeExtractor(),
  bedrock: async () => (await import('./providers/bedrock-extract')).bedrockExtractor(),
  'stub-heuristic': async () =>
    (await import('./providers/stub-heuristic')).stubHeuristicExtractor(),
};

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

export const getExtractor = () =>
  resolve('extract', extractFactories, REGISTRY_CONFIG.extract);

export const getTTS = (override?: string) =>
  resolve('tts', ttsFactories, override ?? REGISTRY_CONFIG.tts);

/**
 * Providers whose output is genuinely model-generated. The UI banner and `check:ship` both read
 * this, so there is exactly one definition of "is this real output?".
 */
export const REAL_MODEL_EXTRACTORS = ['claude', 'bedrock'] as const;
export const isRealModelExtractor = (provider: string) =>
  (REAL_MODEL_EXTRACTORS as readonly string[]).includes(provider);

/** Shown in the UI footer so a judge can see what actually ran. Honesty as a feature. */
export function describeRegistry() {
  const extract = REGISTRY_CONFIG.extract;
  return {
    stt: REGISTRY_CONFIG.stt,
    extract,
    extractDetail: isRealModelExtractor(extract)
      ? `${extract} · ${REGISTRY_CONFIG.extractModel} · effort=${REGISTRY_CONFIG.extractEffort}`
      : `${extract} · deterministic keywords, NOT a model`,
    extractIsRealModel: isRealModelExtractor(extract),
    tts: REGISTRY_CONFIG.tts,
    supportThreshold: REGISTRY_CONFIG.supportThreshold,
    budget: REGISTRY_CONFIG.budget,
  };
}
