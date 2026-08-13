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
import { pyaiGet, pyaiPostMultipart, PyaiError } from '@/lib/pyai';
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
const POLL_TIMEOUT_MS = 180_000;

/** seg_000, seg_001, ... Zero-padded so lexical order matches temporal order. */
const segId = (i: number) => `seg_${String(i).padStart(3, '0')}`;

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
function buildSpeakerMap(segs: PyaiSegment[], mode: 'channel' | 'diarize'): Map<string, string> {
  const map = new Map<string, string>();
  if (mode === 'channel') {
    for (const s of segs) {
      const label = s.speaker ?? `channel_${s.channel}`;
      if (s.channel === 0) map.set(label, 'rep');
      else if (s.channel === 1) map.set(label, 'prospect');
      else map.set(label, label);
    }
    return map;
  }
  const order: string[] = [];
  for (const s of [...segs].sort((a, b) => a.start - b.start)) {
    const label = s.speaker ?? 'speaker_1';
    if (!order.includes(label)) order.push(label);
  }
  order.forEach((label, i) => map.set(label, i === 0 ? 'rep' : i === 1 ? 'prospect' : label));
  return map;
}

function mapSegments(segs: PyaiSegment[], mode: 'channel' | 'diarize'): TranscriptSegment[] {
  const speakers = buildSpeakerMap(segs, mode);
  return [...segs]
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((s, i) => ({
      // IDs are assigned HERE, once, at ingestion — never by a model, never regenerated.
      id: segId(i),
      speaker: speakers.get(s.speaker ?? `channel_${s.channel}`) ?? s.speaker ?? 'unknown',
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

      const submitted = await pyaiPostMultipart<PyaiJob>('/transcription/jobs', fields, {
        field: 'audio',
        filename: req.filename,
        bytes: req.audio,
        contentType: 'audio/wav',
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
