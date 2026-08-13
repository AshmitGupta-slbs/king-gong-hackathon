/**
 * Which model ids does this AWS account actually accept?
 *
 *   npm run check:model
 *
 * WHY THIS EXISTS. A live upload failed with
 * `404 not_found_error: The model 'anthropic.claude-opus-5' does not exist`, and two readings of the
 * documentation disagreed about the cause — one that Mantle ids are bare, one that the prefix is
 * required and the region simply cannot serve the model. The second was right (see
 * `bedrock-extract.ts`), but only after a round of confident argument in both directions, which is
 * the case for having a tool that just asks.
 *
 * For each candidate model this sends the smallest possible request in BOTH forms — bare
 * (`claude-opus-5`) and prefixed (`anthropic.claude-opus-5`) — and reports which the endpoint
 * resolves. The prefixed form is the expected-correct one on Bedrock; the bare form is probed
 * anyway, because a tool that only tests the answer you already believe cannot correct you.
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
      c.warn('  This result says NOTHING about which id form is correct.'),
    );
    console.log(
      c.dim(
        `  Every candidate came back not-found in BOTH forms, so ${region} appears to serve none of\n` +
          '  them — the prefix cells only carry information in a region that serves at least one\n' +
          '  model. Re-run with AWS_REGION=us-east-1 (or us-west-2) and Anthropic model access\n' +
          '  enabled there before drawing any conclusion about naming.\n',
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
