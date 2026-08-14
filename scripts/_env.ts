/**
 * Make a script read the same environment the app reads.
 *
 * `next dev` loads `.env.local` automatically; a `tsx` script does not. Five scripts had already
 * copy-pasted a loader loop to fix that for themselves, and four had not — so `npm run check:key` and
 * `npm run check:model` reported "no credentials" for keys that were sitting in `.env.local` and
 * working fine in the app. `scripts/check-model.ts` even documented the trap in its own error text
 * rather than fixing it.
 *
 * That inconsistency is worse than either behaviour alone: a diagnostic that reads a different
 * environment from the app answers a different question, and the user cannot tell which.
 *
 * ── ORDERING MATTERS, and it is not obvious ──
 *
 * Some modules read `process.env` at MODULE level, not per call:
 *   lib/pyai.ts:14        `PYAI_BASE_URL`
 *   lib/registry/index.ts `LLM_PROVIDER`, `LLM_MODEL`, and the rest of REGISTRY_CONFIG
 *
 * ES imports are hoisted above every statement in the file, so a static
 * `import { getPyaiKey } from '@/lib/pyai'` runs BEFORE any `loadEnv()` call placed at the top of the
 * body — and snapshots the wrong value. Any script that needs env-dependent modules must therefore
 * `await import()` them after calling `loadEnv()`. `scripts/probe/recap-probe.ts` and
 * `scripts/extract-samples.ts` both do this, with a comment saying why.
 */
import { existsSync } from 'node:fs';

export type LoadedEnv = { file: string | null };

/**
 * Load the first env file that exists, in the same precedence Next.js uses: `.env.local` wins over
 * `.env`. Returns which file was read so a caller can print it — "where did this value come from?"
 * is the first question when a credential misbehaves.
 *
 * Deliberately does NOT throw on a malformed file. A broken `.env.local` should not stop `doctor`
 * from telling you the rest of what is wrong; the missing value will surface as its own failure with a
 * remedy attached.
 */
export function loadEnv(): LoadedEnv {
  for (const file of ['.env.local', '.env']) {
    if (!existsSync(file)) continue;
    try {
      process.loadEnvFile(file);
      return { file };
    } catch {
      // Malformed. Keep going: `.env` may still be readable, and a partial environment with a clear
      // downstream error beats a stack trace here.
    }
  }
  return { file: null };
}

/**
 * Which credentials are present, without revealing any of them.
 *
 * One place to ask "what can this machine actually do?", so `setup.sh`, `./kg doctor` and the README's
 * claims cannot drift apart. Mirrors `detectExtractProvider()` in lib/registry/index.ts — note it
 * deliberately does NOT report a PyAI key as a notes credential, because `recap` is opt-in only and
 * inferring it from key presence would silently move every install off Claude.
 */
export function credentialSummary() {
  const anthropic = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const awsRegion = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  const awsCreds = Boolean(
    (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
      process.env.AWS_BEARER_TOKEN_BEDROCK ||
      process.env.AWS_PROFILE,
  );
  return {
    anthropic,
    bedrock: Boolean(awsRegion && awsCreds),
    pyai: Boolean(process.env.PYAI_API_KEY?.trim()),
    /** Set explicitly, so `recap` and a deliberate `stub` are distinguishable from auto-detection. */
    llmProvider: process.env.LLM_PROVIDER?.trim() || null,
    mongo: Boolean(process.env.MONGODB_URI?.trim()),
  };
}
