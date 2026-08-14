/**
 * STT provider: PyAI Hear batch transcription jobs.
 *
 * This adapter is the ONLY place that knows PyAI's response shape. It converts the vendor
 * payload into our data contract and nothing downstream can tell where the segments came from.
 *
 * Every shape decision below is a probed fact, recorded in docs/api-truth.md:
 *   • POST /v1/transcription/jobs returns 202 {job_id, status}; poll GET .../{id}
 *   • segments[].id is an INTEGER index; start/end are FLOAT SECONDS
 *   • speaker is "speaker_1" / "speaker_2"; `channel` appears only when channel:true
 *   • the jobs endpoints do NOT send x-pyai-units, so usage comes from result.audio_seconds
 *   • large results are offloaded to result_url instead of being inlined
 */
import type { TranscriptSegment } from '@/lib/types';
import { PyaiError, pyaiGet, pyaiPostMultipart, pyaiPreflight } from '@/lib/pyai';
import { audioUploadIdentity } from '@/lib/wav';
import type { STTProvider, STTRequest, STTResult } from '../types';

type PyaiSegment = {
  id: number;
  start: number;
  end: number;
  text: string;
  speaker?: string;
  channel?: number;
};

type PyaiJobResult = {
  text?: string;
  speakers?: number;
  audio_seconds?: number;
  segments?: PyaiSegment[];
  words?: { word: string; start: number; end: number; speaker?: string }[];
};

type PyaiJob = {
  job_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  result?: PyaiJobResult;
  result_url?: string;
  error?: string;
};

const POLL_INTERVAL_MS = 1_200;
/** The size at which the server starts rejecting mid-body instead of answering cleanly. */
const PREFLIGHT_BYTES = 1_000_000;
const POLL_TIMEOUT_MS = 180_000;

/**
 * seg_000, seg_001, ... Zero-padded so lexical order matches temporal order.
 * Exported so a chunked caller (pyai-jobs-chunked.ts) can re-number ids across a merged,
 * multi-job transcript the same way a single job numbers its own — one function, so the two
 * can never disagree on the format.
 */
export const segId = (i: number) => `seg_${String(i).padStart(3, '0')}`;

/**
 * Map provider speaker labels onto our two roles.
 *
 * `channel` mode is deterministic: we generate our sample stereo with the rep on the left, so
 * channel 0 is the rep. That is a convention we control, documented in scripts/make-samples.ts.
 *
 * `diarize` mode has no ground truth, so we use a stated heuristic: whoever speaks first is
 * the rep, because the rep opens the call. It is right on essentially every real sales call and
 * wrong on some — which is why `Call.separation` is persisted and shown in the UI, so nobody
 * mistakes a heuristic for a fact.
 */
/**
 * One key function, used by the map builder AND the lookup, so the two can never disagree.
 *
 * They did disagree: the diarize branch keyed a missing speaker as `'speaker_1'` while the lookup
 * computed `` `channel_${s.channel}` `` — and diarize mode returns no `channel`, so the key became
 * the literal string `"channel_undefined"`, missed the map, and the segment came out as
 * `'unknown'`: a speaker the UI cannot render as either role and the extractor cannot reason
 * about. Two expressions of "the same key" in two places is the bug; one function is the fix.
 */
const labelOf = (s: PyaiSegment) => s.speaker ?? (s.channel !== undefined ? `channel_${s.channel}` : 'speaker_1');

/**
 * Map provider speaker labels onto our two roles — diarize mode only.
 *
 * `diarize` has no ground truth, so we use a stated heuristic: whoever speaks first is the rep,
 * because the rep opens the call. It is right on essentially every real sales call and wrong on
 * some — which is why `Call.separation` is persisted and shown in the UI, so nobody mistakes a
 * heuristic for a fact.
 *
 * `channel` mode does NOT go through here. See `roleFromChannel`.
 */
function buildSpeakerMap(segs: PyaiSegment[]): Map<string, string> {
  const map = new Map<string, string>();
  const order: string[] = [];
  for (const s of [...segs].sort((a, b) => a.start - b.start)) {
    const label = labelOf(s);
    if (!order.includes(label)) order.push(label);
  }
  order.forEach((label, i) => map.set(label, i === 0 ? 'rep' : i === 1 ? 'prospect' : label));
  return map;
}

/**
 * In channel mode the channel integer IS the ground truth, so read the role off it per segment.
 *
 * This replaces a label-keyed map, and the map was the defect — not merely a collision risk.
 * `buildSpeakerMap` used to do `map.set(s.speaker, role)` once per segment in channel mode, so if
 * PyAI ever returned the same speaker label on both channels (entirely possible: in channel mode
 * separation is BY CHANNEL and the label is incidental) the last write won and **every segment
 * collapsed onto whichever role was written last**. That is exactly the reported symptom — a
 * stereo call arriving with nearly every line attributed to one speaker — and it would have
 * survived fixing the mode selection, because it is a second, independent cause.
 *
 * Keying on a label the vendor chooses, when we hold the deterministic key, was the mistake.
 * We generate our sample stereo with the rep on the left, so channel 0 is the rep — a convention
 * we control, documented in scripts/make-samples.ts. Change it in both places or neither.
 */
const roleFromChannel = (s: PyaiSegment) =>
  s.channel === 0 ? 'rep' : s.channel === 1 ? 'prospect' : labelOf(s);

export function mapSegments(segs: PyaiSegment[], mode: 'channel' | 'diarize'): TranscriptSegment[] {
  const speakers = mode === 'diarize' ? buildSpeakerMap(segs) : null;
  return [...segs]
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((s, i) => ({
      // IDs are assigned HERE, once, at ingestion — never by a model, never regenerated.
      id: segId(i),
      speaker: speakers ? (speakers.get(labelOf(s)) ?? labelOf(s)) : roleFromChannel(s),
      start_ms: Math.round(s.start * 1000),
      end_ms: Math.round(s.end * 1000),
      text: s.text.trim(), // verbatim: no casing or punctuation "fixes"
      ...(s.channel !== undefined ? { channel: s.channel } : {}),
    }));
}

export function pyaiJobsSTT(): STTProvider {
  return {
    name: 'pyai-jobs',

    async transcribe(req: STTRequest): Promise<STTResult> {
      const fields: Record<string, string> = { output_formats: 'json' };
      if (req.mode === 'channel') fields.channel = 'true';
      else fields.diarize = 'true';
      if (req.numerals) fields.numerals = 'true';

      /**
       * Declare what the bytes actually are, not what the filename claims.
       *
       * This used to send `audio/wav` for every upload unconditionally. A real dialer export
       * arrived named `recording.mp3` while actually being RIFF/WAVE 16-bit stereo — mislabelled
       * files are the normal case, not the edge case, and the endpoint accepts compressed audio
       * directly so there is nothing to transcode either way.
       */
      const id = audioUploadIdentity(req.audio, req.filename);

      /**
       * Ask before shouting.
       *
       * An over-quota key rejects a multipart upload MID-BODY at roughly 1MB and closes the socket,
       * so the client sees a broken pipe rather than the 429 that actually happened — a 40-line
       * network error where the answer was "you are out of quota" (measured, docs/api-truth.md).
       * One cheap GET first turns that into the real message. Only for uploads big enough to hit
       * the failure, because the preflight itself costs a request against the same daily cap.
       */
      if (req.audio.byteLength > PREFLIGHT_BYTES) {
        const pre = await pyaiPreflight();
        if (!pre.ok) throw pre.error;
      }

      const submitted = await pyaiPostMultipart<PyaiJob>('/transcription/jobs', fields, {
        field: 'audio',
        filename: id.filename,
        bytes: req.audio,
        contentType: id.mime,
      });

      const jobId = submitted.data.job_id;
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let job: PyaiJob = submitted.data;

      while (job.status === 'queued' || job.status === 'running') {
        if (Date.now() > deadline) {
          throw new PyaiError(504, 'poll_timeout', `Job ${jobId} still ${job.status} after 180s`);
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        job = (await pyaiGet<PyaiJob>(`/transcription/jobs/${jobId}`)).data;
      }

      if (job.status !== 'completed') {
        throw new PyaiError(502, `job_${job.status}`, job.error ?? `Job ${jobId} ${job.status}`);
      }

      // Large results are offloaded rather than inlined.
      let result = job.result ?? {};
      if (!result.segments && job.result_url) {
        result = (await pyaiGet<PyaiJobResult>(job.result_url)).data;
      }

      const raw = result.segments ?? [];
      if (raw.length === 0) {
        throw new PyaiError(502, 'empty_transcript', `Job ${jobId} returned no segments`);
      }

      return {
        segments: mapSegments(raw, req.mode),
        audio_seconds: result.audio_seconds ?? 0,
        speakers: result.speakers ?? new Set(raw.map((s) => s.speaker)).size,
        // No x-pyai-units on this endpoint — audio_seconds is the real meter.
        usage: { audio_seconds: result.audio_seconds ?? 0, units: submitted.units ?? undefined },
      };
    },
  };
}
