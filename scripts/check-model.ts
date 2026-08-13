/**
 * Which model ids does this AWS account actually accept?
 *
 *   npm run check:model
 *
 * WHY THIS EXISTS. A live upload failed with
 * `404 not_found_error: The model 'anthropic.claude-opus-5' does not exist`, and two people then
 * disagreed about the cause from documentation alone — one reading the SDK's own types and the
 * bundled API reference as saying Mantle ids are BARE, the other reading it as saying they carry an
 * `anthropic.` prefix and that the 404 meant the region cannot serve the model.
 *
 * Both readings are plausible and the question is cheap to settle by asking. So this asks: for each
 * candidate model it sends the smallest possible request in BOTH forms — bare (`claude-opus-5`) and
 * prefixed (`anthropic.claude-opus-5`) — and reports which the endpoint resolves.
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
import { REGISTRY_CONFIG } from '@/lib/registry';
import { probeBedrockModel } from '@/lib/registry/providers/bedrock-extract';

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

/** The configured model first, then the ones most likely to be enabled. */
const CANDIDATES = Array.from(
  new Set([
    REGISTRY_CONFIG.extractModel.replace(/^anthropic\./, ''),
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-opus-4-8',
    'claude-haiku-4-5',
  ]),
);

async function main() {
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
            '\n  (a .env.local file does NOT work here — tsx scripts read only the real shell)\n',
        ),
    );
    process.exit(1);
  }

  console.log(c.b(`\nProbing model ids on bedrock-mantle · region ${region}`));
  console.log(c.dim(`  configured: OPENGONG_MODEL=${REGISTRY_CONFIG.extractModel}`));
  console.log(c.dim('  one 1-token request per cell; bare vs anthropic.-prefixed\n'));

  const resolved: string[] = [];
  let sawNotFound = false;
  let sawDenied = false;

  for (const base of CANDIDATES) {
    for (const model of [base, `anthropic.${base}`]) {
      const { outcome, detail } = await probeBedrockModel(region, model);
      if (outcome === 'resolved') {
        resolved.push(model);
        console.log(`  ${c.ok('RESOLVED')}  ${model}`);
      } else if (outcome === 'not_found') {
        sawNotFound = true;
        console.log(`  ${c.dim('not found')} ${model}`);
      } else if (outcome === 'denied') {
        sawDenied = true;
        console.log(`  ${c.warn('DENIED')}    ${model}  ${c.dim('— id valid, account/region cannot use it')}`);
        console.log(c.dim(`             ${detail}`));
      } else {
        console.log(`  ${c.bad('error')}     ${model}`);
        console.log(c.dim(`             ${detail}`));
      }
    }
  }

  console.log('');
  if (resolved.length > 0) {
    console.log(c.ok(c.b(`${resolved.length} model id(s) resolved.`)));
    const bare = resolved.filter((m) => !m.startsWith('anthropic.'));
    const prefixed = resolved.filter((m) => m.startsWith('anthropic.'));
    console.log(
      c.dim(
        `  This endpoint wants ${
          bare.length && !prefixed.length
            ? 'BARE ids — no "anthropic." prefix'
            : prefixed.length && !bare.length
              ? 'PREFIXED ids — "anthropic." required'
              : 'either form'
        }.`,
      ),
    );
    console.log(c.dim(`  Use:  export OPENGONG_MODEL=${resolved[0]}\n`));
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
        '  Every id was rejected as non-existent rather than refused, which points at the\n' +
          `  endpoint or region rather than permissions. Try a different AWS_REGION (us-east-1 /\n` +
          '  us-west-2), or the Claude-Platform-on-AWS surface (@anthropic-ai/aws-sdk, which also\n' +
          '  needs ANTHROPIC_AWS_WORKSPACE_ID).\n',
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
