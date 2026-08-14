/**
 * Which model ids does this AWS account actually accept?
 *
 *   npm run check:model
 *
 * WHY THIS EXISTS. A live upload failed with `404 not_found_error`, and two sessions then argued
 * from documentation about whether Bedrock ids are bare or `anthropic.`-prefixed. Neither position
 * was right: Bedrock takes four different shapes of identifier and the answer depends on which one
 * you hold (see lib/bedrock-model-id.ts). Reading the working reference implementation settled in
 * minutes what the argument could not — and this script exists so the next such question is asked of
 * the API instead of debated.
 *
 * For each candidate it resolves the id exactly as the provider would, prints `input → resolved` so
 * a mangled id is visible rather than inferred, and sends the smallest possible request. A mangled id
 * was the original bug: `3s3wyt6beb2x` used to leave as `anthropic.3s3wyt6beb2x`, and the resulting
 * 404 was indistinguishable from "this region does not serve that model".
 *
 * The two failure modes are deliberately distinguished, because they look alike and mean opposite
 * things:
 *   • not_found  — the id string is wrong for this endpoint (a naming problem)
 *   • denied     — the id is right, the account/region cannot use it (a console/IAM problem)
 *
 * Deliberately does NOT reuse `extractParams`: effort and adaptive thinking are exactly the sort of
 * parameter an endpoint might reject, and that would confound a model-resolution test. Client
 * construction is kept identical to the provider so the credential path cannot drift.
 */
import { c } from './_ui';
import { loadEnv } from './_env';

/**
 * Env first, then the modules that read it.
 *
 * This script used to tell the user, in its own failure message, that "a .env.local file does NOT work
 * here" — documenting the trap instead of removing it. It works now. The imports must be dynamic and
 * inside main(): `REGISTRY_CONFIG` resolves `LLM_MODEL` at module level, ES imports hoist above any
 * loader call, and `tsx` compiles to CJS so a top-level await is rejected.
 */
type RegistryModule = typeof import('@/lib/registry');
type ModelIdModule = typeof import('@/lib/bedrock-model-id');
type BedrockModule = typeof import('@/lib/registry/providers/bedrock-extract');

/** The configured model first, then the ones most likely to be enabled. */
/** The configured model first, then the ones most likely to be enabled. */
const candidates = (configured: string) =>
  Array.from(
    new Set([configured, 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5']),
  );

async function main() {
  const envFile = loadEnv().file;
  const { REGISTRY_CONFIG }: RegistryModule = await import('@/lib/registry');
  const { bedrockModelId }: ModelIdModule = await import('@/lib/bedrock-model-id');
  const { probeBedrockModel }: BedrockModule = await import(
    '@/lib/registry/providers/bedrock-extract'
  );
  const CANDIDATES = candidates(REGISTRY_CONFIG.extractModel);
  if (envFile) console.log(c.dim(`\n  env file: ${envFile}`));
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!region) {
    console.error(c.bad('\nAWS_REGION is not set. Export it (and your AWS keys) first.\n'));
    process.exit(1);
  }
  const hasCreds = Boolean(
    (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
      process.env.AWS_BEARER_TOKEN_BEDROCK ||
      process.env.AWS_PROFILE,
  );
  if (!hasCreds) {
    console.error(
      c.bad('\nNo AWS credentials in the environment.') +
        c.dim(
          '\n  export AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… AWS_REGION=…' +
            '\n  These are also read from .env.local, so either place works.\n',
        ),
    );
    process.exit(1);
  }

  console.log(c.b(`\nProbing model ids on Bedrock · region ${region}`));
  console.log(c.dim(`  configured: LLM_MODEL=${REGISTRY_CONFIG.extractModel}`));
  console.log(
    c.dim(
      `  account: ${process.env.AWS_ACCOUNT_ID?.trim() || '(unset — a bare profile id cannot be expanded)'}`,
    ),
  );
  console.log(c.dim('  one 1-token request per id, sent as resolved\n'));

  const resolved: string[] = [];
  let sawNotFound = false;
  let sawDenied = false;

  /**
   * Probe what the provider would ACTUALLY send. The id is resolved by shape first, and both forms
   * are printed, because a mangled id was the whole original bug: `3s3wyt6beb2x` used to leave here
   * as `anthropic.3s3wyt6beb2x`, and the 404 that came back was indistinguishable from a region
   * problem. Showing input → resolved makes that class of failure visible instead of inferred.
   */
  for (const candidate of CANDIDATES) {
    let model: string;
    try {
      model = bedrockModelId(candidate, region);
    } catch (err) {
      console.log(`  ${c.bad('unresolvable')} ${candidate}`);
      console.log(c.dim(`             ${(err instanceof Error ? err.message : String(err)).split('\n')[0]}`));
      continue;
    }
    const shown = model === candidate ? candidate : `${candidate} ${c.dim('→')} ${model}`;
    const { outcome, detail } = await probeBedrockModel(region, model);
    if (outcome === 'resolved') {
      resolved.push(candidate);
      console.log(`  ${c.ok('RESOLVED')}  ${shown}`);
    } else if (outcome === 'not_found') {
      sawNotFound = true;
      console.log(`  ${c.dim('not found')} ${shown}`);
    } else if (outcome === 'denied') {
      sawDenied = true;
      console.log(`  ${c.warn('DENIED')}    ${shown}  ${c.dim('— id valid, account/region cannot use it')}`);
      console.log(c.dim(`             ${detail}`));
    } else {
      console.log(`  ${c.bad('error')}     ${shown}`);
      console.log(c.dim(`             ${detail}`));
    }
  }

  console.log('');
  if (resolved.length > 0) {
    console.log(c.ok(c.b(`${resolved.length} model id(s) resolved.`)));
    console.log(c.dim(`  Use:  export LLM_MODEL=${resolved[0]}\n`));
    process.exit(0);
  }

  console.log(c.bad(c.b('No model id resolved.')));
  if (sawDenied && !sawNotFound) {
    console.log(
      c.dim(
        '  Ids are being recognised but refused, so this is model ACCESS, not naming:\n' +
          `  enable Anthropic model access in the Bedrock console for ${region}, and confirm the\n` +
          '  IAM principal can invoke it.\n',
      ),
    );
  } else if (sawNotFound && !sawDenied) {
    console.log(
      c.dim(
        `  Every id was rejected as non-existent rather than refused, so ${region} appears to serve\n` +
          '  none of them. Check the resolved values printed above are the shape you expect, then try\n' +
          '  a region where the model or inference profile actually lives. A bare profile id resolves\n' +
          '  against AWS_ACCOUNT_ID + AWS_REGION, so a wrong region silently produces a valid-looking\n' +
          '  ARN pointing at nothing.\n',
      ),
    );
  } else {
    console.log(c.dim('  Mixed results above — read the per-id detail lines.\n'));
  }
  process.exit(1);
}

main().catch((e) => {
  console.error(c.bad(`\ncheck:model crashed: ${e instanceof Error ? e.stack : String(e)}\n`));
  process.exit(1);
});
