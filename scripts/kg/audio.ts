/**
 * Play exactly the moment a claim cites.
 *
 * "Click a claim, hear the line" is this product's signature interaction, and it is the one thing a
 * terminal port could most easily lose. It does not have to.
 *
 * ── Why we slice instead of seeking ──
 *
 * `afplay` ships on every Mac, which is why it is the right tool here — no install step, nothing to
 * document. But it has NO seek: the only positional flag is `-t`, a duration, always measured from the
 * start of the file. Checked rather than assumed, along with the alternatives: there is no `ffplay`, no
 * `ffmpeg` and no `sox` on the machine this was built on, and docs/api-truth.md records that ffmpeg is
 * deliberately not a dependency of this project.
 *
 * So instead of asking the player to start at 14.2s, we cut a 6-second WAV that begins there and hand
 * that to the player. Everything needed already exists in `lib/wav.ts`, which the sample generator has
 * been using to build stereo WAVs from raw PCM since the beginning: `parseWav` to get at the samples,
 * `buildWav` to write a valid header back. No dependency, no transcode, and the cut is frame-exact.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildWav, parseWav } from '@/lib/wav';
import { uploadDir } from '@/lib/uploads';
import { c } from '../_ui';

/**
 * Where a call's audio actually lives, which depends on how the call got here.
 *
 * Uploads are written under `data/uploads/` and served by `/api/audio/<file>` — deliberately NOT into
 * `public/`, because Next serves that from the build and a file written there at runtime 404s in
 * production. The five bundled samples are committed under `public/samples/` instead. `audio_path` is
 * the URL the browser uses, so it has to be mapped back to a filesystem path here.
 */
export function resolveAudioPath(audioPath: string): string | null {
  const apiMatch = audioPath.match(/^\/api\/audio\/([0-9a-zA-Z._-]+)$/);
  if (apiMatch) {
    const p = join(uploadDir(), apiMatch[1]);
    return existsSync(p) ? p : null;
  }
  // A committed sample, referenced as a public URL like /samples/clean-close.wav
  const p = join(process.cwd(), 'public', audioPath.replace(/^\//, ''));
  return existsSync(p) ? p : null;
}

export type PlayResult = { ok: true; ms: number } | { ok: false; reason: string };

/** Padding around the cited moment, so a clip does not start mid-syllable. */
const LEAD_MS = 250;
const TAIL_MS = 250;

/**
 * Cut [start_ms, end_ms] out of a WAV and play it.
 *
 * Returns rather than throws: failing to play audio should never end a browsing session, and the
 * reasons a reader would care about (no audio file, not a Mac) are answers, not errors.
 */
export function playSegment(
  audioPath: string,
  startMs: number,
  endMs: number,
): PlayResult {
  if (process.platform !== 'darwin') {
    // Following the precedent in lib/registry/providers/macos-say.ts: a platform guard that explains
    // itself, rather than a command-not-found from deep inside a child process.
    return {
      ok: false,
      reason:
        'Playback uses afplay, which is macOS-only. Everything else in the terminal UI works here; ' +
        'open the call in the web app to listen.',
    };
  }

  const file = resolveAudioPath(audioPath);
  if (!file) {
    return { ok: false, reason: `No audio file on disk for ${audioPath}` };
  }

  let pcm;
  try {
    pcm = parseWav(new Uint8Array(readFileSync(file)));
  } catch (err) {
    return { ok: false, reason: `Could not read ${file}: ${err instanceof Error ? err.message : err}` };
  }

  const { pcm16, sampleRate, channels } = pcm;
  /*
    Byte offset of a moment, rounded DOWN to a frame boundary.

    A frame is one sample for every channel, so 4 bytes for 16-bit stereo. Slicing at an offset that is
    not frame-aligned shifts the channels against each other, which on a one-party-per-channel call
    means the two speakers drift apart — audible, and exactly the kind of bug that would make the
    citation feel wrong rather than sound wrong.
  */
  const bytesPerFrame = 2 * channels;
  const at = (ms: number) => {
    const frame = Math.max(0, Math.round((ms / 1000) * sampleRate));
    return Math.min(pcm16.byteLength, frame * bytesPerFrame);
  };

  const from = at(Math.max(0, startMs - LEAD_MS));
  const to = at(endMs + TAIL_MS);
  if (to <= from) return { ok: false, reason: 'That moment is outside the audio.' };

  const clip = buildWav({ pcm16: pcm16.slice(from, to), sampleRate, channels });
  const dir = mkdtempSync(join(tmpdir(), 'kg-clip-'));
  const out = join(dir, 'clip.wav');
  writeFileSync(out, clip);

  const ms = Math.round(((to - from) / bytesPerFrame / sampleRate) * 1000);
  try {
    // Synchronous on purpose: the caller is a prompt loop, and returning before the audio finishes
    // would let the next menu redraw scroll the line you are listening to off the screen.
    execFileSync('afplay', [out], { stdio: 'ignore' });
    return { ok: true, ms };
  } catch (err) {
    return { ok: false, reason: `afplay failed: ${err instanceof Error ? err.message : err}` };
  }
}

/** One-line report, so both the interactive loop and `show --play` say the same thing. */
export function reportPlay(result: PlayResult, label: string) {
  if (result.ok) console.log(c.dim(`  played ${label} (${(result.ms / 1000).toFixed(1)}s)`));
  else console.log(`  ${c.warn(result.reason)}`);
}
