/**
 * POST /api/calls — ingest a call: multipart upload, or a pasted https URL.
 * GET  /api/calls — list processed calls.
 *
 * `node:sqlite` and the filesystem mean this must run on the Node runtime, not Edge.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listCalls, medianRecentRunMs } from '@/lib/db';
import { processCall } from '@/lib/harness/loop';
import { resolveSeparation } from '@/lib/separation';
import { uploadDir } from '@/lib/uploads';
import { RequestedSeparationSchema } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Streamed progress is opt-in by Accept header, so `curl`, scripts and the export tooling keep
 * getting exactly the JSON object they got before. `OPENGONG_STREAM_PROGRESS=0` forces everyone
 * back onto that path — a kill switch that needs no redeploy if a proxy turns out to buffer.
 */
const NDJSON = 'application/x-ndjson';
const streamingEnabled = () => process.env.OPENGONG_STREAM_PROGRESS !== '0';

const NDJSON_HEADERS = {
  'Content-Type': `${NDJSON}; charset=utf-8`,
  // no-transform stops an intermediary re-encoding the body; no-store stops a CDN ever treating
  // a 70-second run as a cacheable response.
  'Cache-Control': 'no-store, no-transform',
  'X-Content-Type-Options': 'nosniff',
  // nginx-class proxies buffer streamed responses by default; this opts out.
  'X-Accel-Buffering': 'no',
} as const;

/** A validation failure that still deserves a real HTTP status, because nothing has streamed yet. */
class BadUpload extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function GET() {
  return NextResponse.json({ calls: await listCalls() });
}

/**
 * Everything that can still fail with a real HTTP status.
 *
 * Kept lexically in this file rather than extracted to `lib/`: `scripts/check-ship.ts` reads this
 * route as TEXT and asserts that it contains `resolveSeparation` and does not contain
 * `as SeparationMode`. Moving this out would turn a shipping gate red for a cosmetic refactor.
 */
async function prepareUpload(req: Request) {
  const form = await req.formData();
  const file = form.get('audio');
  const url = String(form.get('url') ?? '').trim();
  const title = String(form.get('title') ?? '').trim() || 'Untitled call';
  // Validated, not cast. The previous `as SeparationMode` let any string through to
  // pyai-jobs.ts's bare `else`, where everything that wasn't exactly 'channel' silently
  // diarized — so a typo'd mode was indistinguishable from a deliberate one.
  const requested = RequestedSeparationSchema.safeParse(form.get('mode') ?? 'auto');
  if (!requested.success) throw new BadUpload('mode must be one of: auto, channel, diarize');

  // Validated, not cast — same rule as `mode` above. Empty means "no account", which is allowed:
  // a quick one-off upload must never be blocked waiting for someone to fill in a CRM record.
  const companyField = form.get('companyId');
  const company = z
    .string()
    .trim()
    .min(1)
    .optional()
    .safeParse(companyField ? String(companyField) : undefined);
  if (!company.success) throw new BadUpload('companyId must be a non-empty string when provided.');

  let bytes: Uint8Array;
  let filename: string;

  if (file instanceof File && file.size > 0) {
    bytes = new Uint8Array(await file.arrayBuffer());
    filename = file.name || 'upload.wav';
  } else if (url) {
    if (!url.startsWith('https://')) {
      throw new BadUpload('Only https URLs are accepted for pasted links.');
    }
    const res = await fetch(url);
    if (!res.ok) throw new BadUpload(`Could not fetch that URL (HTTP ${res.status}).`);
    bytes = new Uint8Array(await res.arrayBuffer());
    filename = url.split('/').pop() || 'linked.wav';
  } else {
    throw new BadUpload('Provide either an audio file or an https url.');
  }

  /**
   * Persist the audio first so the player has something to load even if analysis fails.
   *
   * This deliberately does NOT write into `public/`. Next serves `public/` from the build, so a
   * file written there at runtime is invisible in production — measured: `next start` returns 404
   * for it while `next dev` serves it happily. That combination is the worst kind of bug, because
   * every local test passes and the hosted demo plays silence. Uploads therefore live under
   * `data/` (already gitignored as runtime state) and are streamed back by /api/audio.
   */
  const callId = randomUUID().slice(0, 8);
  const dir = uploadDir();
  mkdirSync(dir, { recursive: true });
  const stored = `${callId}.wav`;
  writeFileSync(join(dir, stored), bytes);

  /**
   * Decide separation from the audio, not from a form default.
   *
   * This is the fix for a real bug: a stereo two-party recording was transcribed with
   * `diarize: true` because the radio defaulted to mono and nothing read the file. Resolving
   * HERE rather than inside the provider is deliberate — `loop.ts` persists `input.mode`
   * verbatim, so handing it the resolved value makes `Call.separation` a fact about the audio
   * instead of a record of what a form happened to post, with no change to the harness.
   */
  const separation = resolveSeparation(bytes, requested.data);

  return {
    separation,
    bytes: bytes.byteLength,
    input: {
      callId,
      companyId: company.data,
      title,
      audio: bytes,
      filename,
      audioPath: `/api/audio/${stored}`,
      mode: separation.mode,
      numerals: true,
    },
  };
}

type Prepared = Awaited<ReturnType<typeof prepareUpload>>;

/**
 * The run, narrated as NDJSON.
 *
 * Note what this cannot do: the HTTP status is committed the moment the first byte is written, so
 * a failure part-way through a 70-second run cannot be a 500. It is a terminal `error` event
 * instead, and a stream that ends without a terminal event is itself a failure the client detects.
 */
function runStream(prepared: Prepared): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const t0 = Date.now();
  let sink: ReadableStreamDefaultController<Uint8Array> | null = null;

  const send = (ev: Record<string, unknown>) => {
    if (!sink) return; // client gone — drop it, never throw
    try {
      sink.enqueue(enc.encode(JSON.stringify(ev) + '\n'));
    } catch {
      sink = null; // closed underneath us
    }
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      sink = controller;

      /**
       * A kilobyte of padding on the first line, deliberately.
       *
       * WebKit buffers a streamed response until 1024 bytes have arrived. The entire payload here
       * is ~2KB spread over a minute, so without this the first few rows would land in one lump —
       * in Safari only, which is the kind of bug you meet on stage rather than in dev.
       */
      send({ t: 'open', pad: '-'.repeat(1024) });
      send({ t: 'stage', stage: 'upload', state: 'done', at: 0, ms: 0,
             detail: `${(prepared.bytes / 1e6).toFixed(1)} MB · ${prepared.separation.mode}` });
      send({ t: 'expect', totalMs: await medianRecentRunMs() });

      /**
       * Liveness. The extract call can sit silent for a minute, which is long enough for an
       * idle-timeout proxy to cut the connection — and the client would then report a failure on a
       * run that actually succeeded.
       */
      const beat = setInterval(() => send({ t: 'tick', at: Date.now() - t0 }), 5_000);

      try {
        const outcome = await processCall({
          ...prepared.input,
          onStage: (e) => send({ ...e, at: Date.now() - t0 }),
        });
        send({
          t: 'result',
          at: Date.now() - t0,
          outcome: { ...outcome, separation: prepared.separation },
        });
      } catch (err) {
        // processCall records its own failures, so reaching here means the harness itself threw.
        send({ t: 'error', at: Date.now() - t0, message: msg(err) });
      } finally {
        clearInterval(beat);
        const c = sink;
        sink = null;
        if (c) {
          try {
            c.close();
          } catch {
            /* already closed */
          }
        }
      }
    },

    cancel() {
      /**
       * The client disconnected. The run deliberately continues: `openRun` has already written a
       * row and only the `finally` in processCall resolves it, so abandoning the work here would
       * leave exactly what the failure invariant forbids — a run stuck in 'running'.
       */
      sink = null;
    },
  });
}

export async function POST(req: Request) {
  // ── Phase 1 — a real HTTP status is still possible ──────────────────────────
  let prepared: Prepared;
  try {
    prepared = await prepareUpload(req);
  } catch (err) {
    return NextResponse.json(
      { error: msg(err) },
      { status: err instanceof BadUpload ? err.status : 500 },
    );
  }

  const wantsStream = req.headers.get('accept')?.includes(NDJSON) && streamingEnabled();
  if (!wantsStream) {
    const outcome = await processCall(prepared.input);
    // A failed or deadlined run is still a 200 with a status — the client needs the run record,
    // not an exception. Every run leaves a trace; that is the whole point of the invariant.
    return NextResponse.json({ ...outcome, separation: prepared.separation });
  }

  // ── Phase 2 — committed to 200. Every further outcome is an event. ─────────
  return new Response(runStream(prepared), { headers: NDJSON_HEADERS });
}
