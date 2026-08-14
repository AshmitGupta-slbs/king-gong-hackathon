/**
 * STT provider: PyAI Hear batch jobs, chunked for long mono audio.
 *
 * Validated locally against a real 13-minute mono call: the single-job path failed twice in a
 * row with `job_failed: stt: HTTP 500: Internal Server Error` — PyAI's own backend, not ours,
 * see docs/api-truth.md. Splitting the identical bytes into ~200s chunks succeeded 5/5. This
 * wraps pyaiJobsSTT() rather than reimplementing PyAI's wire format — only pyai-jobs.ts is
 * allowed to know that shape; this file only ever sees our own TranscriptSegment[] contract.
 *
 * Scope, deliberately: only mono 16-bit WAV over the threshold is chunked. `channel:true`
 * (stereo) calls already skip the flaky diarize stage entirely (docs/api-truth.md) and are left
 * on the single-job path unchanged — no evidence yet that they need this, and chunking them
 * would need its own silence detector tuned for interleaved stereo. Non-WAV/compressed uploads
 * also pass through unchanged, since duration can't be read locally without decoding. So no
 * input can come out worse than it does today; only long mono calls change behaviour.
 */
import { pyaiJobsSTT, segId } from './pyai-jobs';
import { readWavHeader, buildWav } from '@/lib/wav';
import type { TranscriptSegment } from '@/lib/types';
import type { STTProvider, STTRequest, STTResult } from '../types';

/** Below this, send as one job — this is the untouched, already-working path. */
const CHUNK_THRESHOLD_SECONDS = 360; // 6 min: comfortable margin above the validated 200s chunks
const TARGET_CHUNK_SECONDS = 200; // the exact size validated against the real failing file
/** How far around the target boundary to look for a quiet moment to cut on. */
const SPLIT_SEARCH_SECONDS = 5;
const SPLIT_WINDOW_MS = 50;
/** A gap this short at a chunk boundary is assumed to be the same speaker continuing across it. */
const CONTINUITY_GAP_MS = 2000;

function windowRms(view: DataView, byteOffset: number, frames: number): number {
  let sumSq = 0;
  for (let f = 0; f < frames; f++) {
    const s = view.getInt16(byteOffset + f * 2, true);
    sumSq += s * s;
  }
  return frames ? Math.sqrt(sumSq / frames) : 0;
}

/**
 * Nearest quiet point to `targetFrame`, searched +/- SPLIT_SEARCH_SECONDS, so a chunk boundary
 * lands in a pause rather than cutting a word or a sentence in half. Mono 16-bit only — the frame
 * math here assumes one sample per frame.
 */
function findQuietSplit(
  pcm16: Uint8Array,
  sampleRate: number,
  targetFrame: number,
  totalFrames: number,
): number {
  const view = new DataView(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
  const searchFrames = SPLIT_SEARCH_SECONDS * sampleRate;
  const windowFrames = Math.max(1, Math.round((sampleRate * SPLIT_WINDOW_MS) / 1000));
  const lo = Math.max(0, targetFrame - searchFrames);
  const hi = Math.min(totalFrames, targetFrame + searchFrames);

  let best = targetFrame;
  let bestRms = Infinity;
  for (let f = lo; f + windowFrames <= hi; f += windowFrames) {
    const level = windowRms(view, f * 2, windowFrames);
    if (level < bestRms) {
      bestRms = level;
      best = f;
    }
  }
  return best;
}

type Chunk = { wav: Uint8Array; durationMs: number };

function splitIntoChunks(bytes: Uint8Array): Chunk[] {
  const header = readWavHeader(bytes);
  if (!header) throw new Error('pyai-jobs-chunked: expected a readable WAV header');

  const bytesPerFrame = (header.bits / 8) * header.channels;
  const totalFrames = Math.floor(header.dataLength / bytesPerFrame);
  const pcm16 = bytes.subarray(header.dataOffset, header.dataOffset + header.dataLength);

  const chunks: Chunk[] = [];
  let start = 0;
  while (start < totalFrames) {
    const targetEnd = start + TARGET_CHUNK_SECONDS * header.sampleRate;
    const end =
      targetEnd >= totalFrames ? totalFrames : findQuietSplit(pcm16, header.sampleRate, targetEnd, totalFrames);
    const clampedEnd = Math.max(end, start + 1); // never emit a zero-length chunk
    const slice = new Uint8Array(pcm16.subarray(start * bytesPerFrame, clampedEnd * bytesPerFrame));
    chunks.push({
      wav: buildWav({ pcm16: slice, sampleRate: header.sampleRate, channels: header.channels }),
      durationMs: Math.round(((clampedEnd - start) / header.sampleRate) * 1000),
    });
    start = clampedEnd;
  }
  return chunks;
}

/**
 * Reconcile speaker identity across a chunk boundary.
 *
 * Each chunk is diarized independently by PyAI, so pyai-jobs.ts's own "whoever speaks first is
 * the rep" heuristic runs fresh per chunk — chunk 2's "rep" has no guaranteed relationship to
 * chunk 1's. That is not solvable exactly without voice-embedding matching (out of scope), so
 * this uses the same kind of stated heuristic the rest of this codebase already applies to
 * diarize mode: if the gap at the boundary is short, assume the same person is still talking, and
 * flip this chunk's rep/prospect labels when that assumption disagrees with the chunk's own
 * first-speaker guess. A longer gap (a real pause) leaves the heuristic no better than a coin
 * flip, so it is left alone rather than pretending otherwise — same asymmetry as
 * lib/separation.ts: only strong signal changes the label.
 */
function reconcileSpeakers(
  prevLastSpeaker: string | null,
  prevLastEndMs: number,
  chunkSegments: TranscriptSegment[],
): TranscriptSegment[] {
  if (!prevLastSpeaker || chunkSegments.length === 0) return chunkSegments;
  const first = chunkSegments[0];
  if (Math.abs(first.start_ms - prevLastEndMs) > CONTINUITY_GAP_MS) return chunkSegments;
  if (first.speaker === prevLastSpeaker) return chunkSegments;

  const flip = (s: string) => (s === 'rep' ? 'prospect' : s === 'prospect' ? 'rep' : s);
  return chunkSegments.map((s) => ({ ...s, speaker: flip(s.speaker) }));
}

export function pyaiJobsChunkedSTT(): STTProvider {
  const single = pyaiJobsSTT();

  return {
    name: 'pyai-jobs-chunked',

    async transcribe(req: STTRequest): Promise<STTResult> {
      const header = readWavHeader(req.audio);
      const estimatedSeconds =
        header && header.bits === 16
          ? header.dataLength / ((header.bits / 8) * header.channels) / header.sampleRate
          : null;

      // Unchanged path: short calls, stereo, or anything we can't safely chunk (non-WAV,
      // non-16-bit) go straight to the single-job provider exactly as before.
      if (
        !header ||
        header.channels !== 1 ||
        header.bits !== 16 ||
        !estimatedSeconds ||
        estimatedSeconds <= CHUNK_THRESHOLD_SECONDS
      ) {
        return single.transcribe(req);
      }

      const chunks = splitIntoChunks(req.audio);
      const merged: TranscriptSegment[] = [];
      let offsetMs = 0;
      let totalAudioSeconds = 0;
      let prevLastSpeaker: string | null = null;
      let prevLastEndMs = 0;
      const stem = req.filename.replace(/\.[^./\\]+$/, '') || 'upload';

      for (let i = 0; i < chunks.length; i++) {
        const result = await single.transcribe({
          audio: chunks[i].wav,
          filename: `${stem}.chunk${i}.wav`,
          mode: req.mode,
          numerals: req.numerals,
        });

        let segs = result.segments.map((s) => ({
          ...s,
          start_ms: s.start_ms + offsetMs,
          end_ms: s.end_ms + offsetMs,
        }));
        if (req.mode === 'diarize') {
          segs = reconcileSpeakers(prevLastSpeaker, prevLastEndMs, segs);
        }

        merged.push(...segs);
        if (segs.length > 0) {
          prevLastSpeaker = segs[segs.length - 1].speaker;
          prevLastEndMs = segs[segs.length - 1].end_ms;
        }
        totalAudioSeconds += result.audio_seconds;
        offsetMs += chunks[i].durationMs;
      }

      merged.sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
      // Re-numbered once, across the merged call, the same way a single job numbers its own.
      const reIded = merged.map((s, i) => ({ ...s, id: segId(i) }));

      return {
        segments: reIded,
        audio_seconds: totalAudioSeconds,
        speakers: new Set(reIded.map((s) => s.speaker)).size,
        usage: { audio_seconds: totalAudioSeconds },
      };
    },
  };
}
