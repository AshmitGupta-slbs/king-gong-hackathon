/**
 * Build the five committed sample calls.
 *
 *   npm run samples              # audio + transcripts (+ extraction if ANTHROPIC_API_KEY is set)
 *   OPENGONG_TTS=pyai-speak npm run samples    # once PyAI Speak stops 503ing
 *
 * Output, all committed to the repo so the demo needs no setup and no keys:
 *   public/samples/<id>.wav      stereo, rep on the LEFT channel, prospect on the RIGHT
 *   samples/<id>.stt.json        diarized transcript in our data contract
 *   samples/<id>.result.json     gated extraction
 *   samples/index.json           manifest the UI reads
 *
 * The rep-on-left convention is what makes `channel: true` deterministic: PyAI reports
 * channel 0/1 and lib/registry/providers/pyai-jobs.ts maps 0 -> rep. Change it in both places
 * or neither.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getExtractor,
  getSTT,
  getTTS,
  isRealModelExtractor,
  REGISTRY_CONFIG,
} from '@/lib/registry';
import { runCitationGate } from '@/lib/harness/gate';
import { retryAimed } from '@/lib/harness/retry';
import { PyaiError } from '@/lib/pyai';
import { buildWav, concat, durationMs, interleaveStereo, silence } from '@/lib/wav';
import { SAMPLE_SCRIPTS, type SampleScript } from './sample-scripts';

const SAMPLES = join(process.cwd(), 'samples');
const PUBLIC = join(process.cwd(), 'public', 'samples');
const GAP_MS = 260;
/**
 * Pace between synthesis calls. A sandbox key returns 429 daily_cap_exceeded after roughly
 * thirty rapid Speak calls and then recovers within minutes — it is a burst limit, not an
 * exhausted day. Pacing plus a backoff that honours Retry-After keeps a 50-turn regeneration
 * inside it. See docs/api-truth.md.
 */
const SYNTH_PACE_MS = Number(process.env.OPENGONG_SYNTH_PACE_MS ?? 250);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

/**
 * Lay the two speakers onto separate channels: while one talks, the other is digital silence.
 * That is what one-party-per-channel means, and it gives exact speaker attribution with no
 * diarization model involved at all.
 */
async function buildStereo(script: SampleScript) {
  const tts = await getTTS();
  const left: Uint8Array[] = [];
  const right: Uint8Array[] = [];
  let rate = 16000;

  for (const [i, turn] of script.turns.entries()) {
    const voice = turn.speaker === 'rep' ? tts.voices.rep : tts.voices.prospect;
    if (i > 0) await sleep(SYNTH_PACE_MS);

    // Bounded retry with server-guided backoff, so one burst limit does not lose a whole run.
    const { value } = await retryAimed({
      attempts: 6,
      run: () => tts.synthesize({ text: turn.text, voice }),
      isFatal: (e) => e instanceof PyaiError && !e.retryable,
      // Speak's rate-limit window is seconds, not milliseconds: honour Retry-After when the
      // server sends it, otherwise back off hard rather than hammering a closed door.
      backoffMs: (attempt, err) =>
        (err instanceof PyaiError && err.retryAfterSec ? err.retryAfterSec * 1000 : 0) ||
        Math.min(30_000, 4_000 * attempt),
      onRetry: async (attempt, reason) => {
        process.stdout.write(c.warn(`[retry ${attempt}] `));
        console.error(c.dim(`\n    ${reason}`));
      },
    });
    const { pcm16, sampleRate } = value;
    rate = sampleRate;
    const gap = silence(GAP_MS, sampleRate);
    const quiet = new Uint8Array(pcm16.length);
    if (turn.speaker === 'rep') {
      left.push(pcm16, gap);
      right.push(quiet, gap);
    } else {
      left.push(quiet, gap);
      right.push(pcm16, gap);
    }
  }
  const stereo = interleaveStereo(concat(left), concat(right));
  return { bytes: buildWav({ pcm16: stereo, sampleRate: rate, channels: 2 }), sampleRate: rate };
}

async function main() {
  mkdirSync(SAMPLES, { recursive: true });
  mkdirSync(PUBLIC, { recursive: true });

  const tts = await getTTS();
  const stt = await getSTT('pyai-jobs'); // always transcribe for real; fixtures are the output
  const extractor = await getExtractor();
  const canExtract = true; // the registry always resolves something (stub is the fallback)
  const realModel = isRealModelExtractor(extractor.name);

  console.log(c.b('\nBuilding sample calls'));
  console.log(
    c.dim(
      `  tts=${tts.name}  stt=${stt.name}  extract=${extractor.name}` +
        (realModel ? ` (${REGISTRY_CONFIG.extractModel})` : ''),
    ) + '\n',
  );
  if (!realModel) {
    console.log(
      c.warn('  ⚠  No model credential found — extraction will use the KEYWORD STUB.') +
        '\n' +
        c.dim(
          '     Fine for building the UI. NOT shippable: `npm run check:ship` will fail until\n' +
          '     these are regenerated with ANTHROPIC_API_KEY or AWS Bedrock creds set.\n',
        ),
    );
  }

  // Rebuild only the calls named on the command line, if any. Lets a partial run be finished
  // without re-burning quota on the calls that already succeeded.
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const scripts = only.length ? SAMPLE_SCRIPTS.filter((s) => only.includes(s.id)) : SAMPLE_SCRIPTS;
  if (only.length) console.log(c.dim(`  building only: ${scripts.map((s) => s.id).join(', ')}\n`));

  const manifest: Record<string, unknown>[] = [];

  for (const script of scripts) {
    process.stdout.write(`  ${script.id.padEnd(20)} `);

    // 1. audio
    const { bytes, sampleRate } = await buildStereo(script);
    writeFileSync(join(PUBLIC, `${script.id}.wav`), bytes);
    // Use the provider's actual rate: macOS `say` gives 16kHz, PyAI Speak gives 24kHz, and
    // hardcoding 16k here reported a 50% longer call than the audio actually was.
    const ms = durationMs({ pcm16: bytes.subarray(44), sampleRate, channels: 2 });
    process.stdout.write(c.dim(`audio ${(ms / 1000).toFixed(0)}s `));

    // 2. transcript — real PyAI Hear, stereo channel separation
    let sttOut;
    try {
      sttOut = await stt.transcribe({
        audio: bytes,
        filename: `${script.id}.wav`,
        mode: 'channel',
        numerals: true,
      });
    } catch (err) {
      console.log(c.bad(`STT FAILED: ${err instanceof Error ? err.message : String(err)}`));
      continue;
    }
    writeFileSync(
      join(SAMPLES, `${script.id}.stt.json`),
      JSON.stringify(
        { segments: sttOut.segments, audio_seconds: sttOut.audio_seconds, speakers: sttOut.speakers },
        null,
        2,
      ),
    );
    process.stdout.write(c.dim(`${sttOut.segments.length} segs/${sttOut.speakers} spk `));

    // 3. extraction + gate (optional — needs a Claude key)
    let runStatus = 'not-extracted';
    if (canExtract) {
      try {
        const { draft } = await extractor.extract({
          callTitle: script.title,
          segments: sttOut.segments,
        });
        const { result } = runCitationGate(draft, sttOut.segments, extractor.name);
        writeFileSync(join(SAMPLES, `${script.id}.result.json`), JSON.stringify(result, null, 2));
        runStatus = result.run_status;
        const flag = result.run_status === 'shipped' ? c.ok(runStatus) : c.warn(runStatus);
        process.stdout.write(
          `${flag} ${c.dim(`${result.objections.length} obj / ${result.next_steps.length} next / ${result.rejections.length} rej`)}`,
        );
      } catch (err) {
        process.stdout.write(c.bad(`extract failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
    console.log();

    manifest.push({
      id: script.id,
      title: script.title,
      audio_path: `/samples/${script.id}.wav`,
      duration_ms: Math.round(sttOut.audio_seconds * 1000),
      segments: sttOut.segments.length,
      speakers: sttOut.speakers,
      separation: 'channel',
      run_status: runStatus,
      extracted_by: extractor.name,
    });
  }

  if (only.length) {
    console.log(
      c.dim('\n  partial build — run `npm run reindex:samples` to rebuild the manifest from disk\n'),
    );
  } else {
    writeFileSync(join(SAMPLES, 'index.json'), JSON.stringify(manifest, null, 2));
    console.log(c.ok(`\n  wrote samples/index.json (${manifest.length} calls)\n`));
  }
  if (!realModel) {
    console.log(
      c.warn('  Extractions above are KEYWORD STUB output, not model output.') +
        '\n  ' +
        c.dim('Re-run with a credential set to replace them before the demo.\n'),
    );
  }
}

main().catch((e) => {
  console.error(c.bad(`\nmake-samples failed: ${e instanceof Error ? e.stack : String(e)}\n`));
  process.exit(1);
});
