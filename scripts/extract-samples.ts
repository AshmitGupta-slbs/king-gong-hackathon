/**
 * Re-run extraction over the already-transcribed sample calls.
 *
 *   npm run extract:samples
 *
 * Deliberately separate from `npm run samples`: this reuses the committed transcripts, so it costs
 * no TTS and burns no PyAI minutes. It is the command to run the moment a real model credential
 * appears — swapping keyword-stub output for model output without touching the audio.
 *
 * Provider is auto-detected: ANTHROPIC_API_KEY -> claude, AWS creds + AWS_REGION -> bedrock,
 * PYAI key with recap:read -> LLM_PROVIDER=recap (never auto-detected), otherwise the keyword stub.
 *
 * ⚠ THIS COMMAND OVERWRITES `samples/*.result.json`, which are the committed demo notes. It used to
 * do that unconditionally and print "these are KEYWORD STUB extractions" AFTERWARDS — so running it
 * on a machine with no credential destroyed five real extractions and replaced them with keyword
 * output, and the only signal was a dim line after the fact. It now refuses up front unless
 * `--allow-stub` is passed. See the guard in main().
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TranscriptSegment } from '@/lib/types';

/*
  `next dev` loads .env.local; a tsx script does not — and `REGISTRY_CONFIG` reads `LLM_PROVIDER` at
  MODULE level, so a static import would snapshot the environment before this ran. Same pattern as
  check-store.ts, with the extra constraint that the registry imports have to be dynamic.
*/
for (const f of ['.env.local', '.env']) {
  if (!existsSync(f)) continue;
  try {
    process.loadEnvFile(f);
    break;
  } catch {
    /* a malformed env file should not stop us reporting which provider resolved */
  }
}

const SAMPLES = join(process.cwd(), 'samples');
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

async function main() {
  // Imported here, not at the top, so the env file above is already loaded when REGISTRY_CONFIG
  // evaluates `LLM_PROVIDER`.
  const { getExtractor, isRealModelExtractor, REGISTRY_CONFIG } = await import('@/lib/registry');
  const { runCitationGate } = await import('@/lib/harness/gate');
  const { sampleManifest } = await import('@/lib/samples');

  const manifest = sampleManifest();
  if (manifest.length === 0) {
    console.error(c.bad('\nNo samples/index.json — run `npm run samples` first.\n'));
    process.exit(1);
  }

  const extractor = await getExtractor();
  const real = isRealModelExtractor(extractor.name);
  const allowStub = process.argv.includes('--allow-stub');

  /*
    REFUSE BEFORE WRITING ANYTHING.

    The five committed `*.result.json` files are the zero-setup demo. Overwriting them with keyword
    output is not a degraded result, it is data loss — and it is the exact thing this script did by
    default, with a warning printed after the files were already gone. Nothing below this point runs
    unless a real model is resolved or the caller has explicitly said they want the stub.
  */
  if (!real && !allowStub) {
    console.error(
      c.bad(`\nRefusing to run: the resolved extractor is "${extractor.name}", not a model.\n`) +
        c.dim(
          '  This command OVERWRITES samples/*.result.json — the committed demo notes — so running\n' +
            '  it without a model credential would replace five real extractions with keyword output.\n\n',
        ) +
        '  Set one of:\n' +
        c.dim('    ANTHROPIC_API_KEY=…                          ') +
        'first-party Claude\n' +
        c.dim('    AWS_REGION=… + AWS credentials               ') +
        'Claude on Bedrock\n' +
        c.dim('    PYAI_API_KEY=… LLM_PROVIDER=recap            ') +
        'PyAI Recap writes the notes\n\n' +
        c.dim('  Or pass --allow-stub if you really do want keyword-stub samples.\n'),
    );
    process.exit(1);
  }

  console.log(c.b('\nExtracting sample calls'));
  console.log(
    c.dim(
      `  provider=${extractor.name}` +
        (real ? ` · model=${REGISTRY_CONFIG.extractModel} · effort=${REGISTRY_CONFIG.extractEffort}` : ' · KEYWORD STUB, not a model'),
    ) + '\n',
  );

  let failures = 0;
  const updated: typeof manifest = [];

  for (const entry of manifest) {
    process.stdout.write(`  ${entry.id.padEnd(20)} `);
    const sttPath = join(SAMPLES, `${entry.id}.stt.json`);
    if (!existsSync(sttPath)) {
      console.log(c.bad('no transcript'));
      failures++;
      updated.push(entry);
      continue;
    }
    const { segments } = JSON.parse(readFileSync(sttPath, 'utf8')) as {
      segments: TranscriptSegment[];
    };

    try {
      const started = Date.now();
      const { draft, usage } = await extractor.extract({
        callTitle: entry.title,
        segments,
      });
      const { result } = runCitationGate(draft, segments, extractor.name);
      writeFileSync(join(SAMPLES, `${entry.id}.result.json`), JSON.stringify(result, null, 2));

      const status =
        result.run_status === 'shipped' ? c.ok(result.run_status) : c.warn(result.run_status);
      const tok = usage.input_tokens
        ? c.dim(` · ${usage.input_tokens}in/${usage.output_tokens}out tok`)
        : '';
      console.log(
        `${status} ${c.dim(
          `${result.objections.length} obj · ${result.next_steps.length} next · ` +
            `${result.key_moments.length} moments · ${result.rejections.length} rejected · ` +
            `${((Date.now() - started) / 1000).toFixed(1)}s`,
        )}${tok}`,
      );
      updated.push({ ...entry, run_status: result.run_status, extracted_by: extractor.name });
    } catch (err) {
      console.log(c.bad(`FAILED: ${err instanceof Error ? err.message : String(err)}`));
      failures++;
      updated.push(entry);
    }
  }

  writeFileSync(join(SAMPLES, 'index.json'), JSON.stringify(updated, null, 2));

  if (!real) {
    console.log(
      c.warn('\n  These are KEYWORD STUB extractions, not model output.') +
        '\n  ' +
        c.dim('`npm run check:ship` will fail until they are regenerated with a real credential.\n'),
    );
  } else if (failures === 0) {
    console.log(c.ok(`\n  All ${updated.length} extractions produced by ${extractor.name}.\n`));
  }

  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(c.bad(`\nextract-samples failed: ${e instanceof Error ? e.stack : String(e)}\n`));
  process.exit(1);
});
