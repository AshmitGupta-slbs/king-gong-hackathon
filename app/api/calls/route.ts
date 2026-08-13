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
import { listCalls } from '@/lib/db';
import { processCall } from '@/lib/harness/loop';
import { resolveSeparation } from '@/lib/separation';
import { RequestedSeparationSchema } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET() {
  return NextResponse.json({ calls: listCalls() });
}

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get('audio');
    const url = String(form.get('url') ?? '').trim();
    const title = String(form.get('title') ?? '').trim() || 'Untitled call';
    // Validated, not cast. The previous `as SeparationMode` let any string through to
    // pyai-jobs.ts's bare `else`, where everything that wasn't exactly 'channel' silently
    // diarized — so a typo'd mode was indistinguishable from a deliberate one.
    const requested = RequestedSeparationSchema.safeParse(form.get('mode') ?? 'auto');
    if (!requested.success) {
      return NextResponse.json(
        { error: 'mode must be one of: auto, channel, diarize' },
        { status: 400 },
      );
    }

    let bytes: Uint8Array;
    let filename: string;

    if (file instanceof File && file.size > 0) {
      bytes = new Uint8Array(await file.arrayBuffer());
      filename = file.name || 'upload.wav';
    } else if (url) {
      if (!url.startsWith('https://')) {
        return NextResponse.json(
          { error: 'Only https URLs are accepted for pasted links.' },
          { status: 400 },
        );
      }
      const res = await fetch(url);
      if (!res.ok) {
        return NextResponse.json(
          { error: `Could not fetch that URL (HTTP ${res.status}).` },
          { status: 400 },
        );
      }
      bytes = new Uint8Array(await res.arrayBuffer());
      filename = url.split('/').pop() || 'linked.wav';
    } else {
      return NextResponse.json(
        { error: 'Provide either an audio file or an https url.' },
        { status: 400 },
      );
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
    const dir = join(process.cwd(), 'data', 'uploads');
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

    const outcome = await processCall({
      callId,
      title,
      audio: bytes,
      filename,
      audioPath: `/api/audio/${stored}`,
      mode: separation.mode,
      numerals: true,
    });

    // A failed or deadlined run is still a 200 with a status — the client needs the run record,
    // not an exception. Every run leaves a trace; that is the whole point of the invariant.
    return NextResponse.json({ ...outcome, separation });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
