/**
 * Serve uploaded call audio from `data/uploads/`.
 *
 * WHY THIS ROUTE EXISTS. Uploaded audio used to be written to `public/uploads/` and served as a
 * static path. That works in `next dev` and returns **404 in production**: Next serves `public/`
 * as it existed at build time, so a file written there afterwards does not exist as far as the
 * production server is concerned. Measured directly — `next start`, file written post-build,
 * `GET /uploads/x.wav` → 404, while the committed samples under `/samples/` → 200.
 *
 * The symptom would have been an uploaded call that transcribes correctly, shows its citations, and
 * plays nothing when you click one. On a hosted demo, with every local test green.
 *
 * Range support is not optional here: the built-in samples get it from Next automatically (verified,
 * 206), audio seeking is the core interaction of this product, and Safari will not seek — sometimes
 * will not play at all — without it. So this route matches what static serving already provided.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ReadableOptions } from 'node:stream';
import { NextResponse } from 'next/server';
import { uploadDir } from '@/lib/uploads';

// Reading from disk and streaming means this cannot run on Edge.
export const runtime = 'nodejs';

// Resolved per request rather than captured at module load: the env var is not reliably
// populated at import time, and a stale path here serves 404s for files that exist.
const dir = () => uploadDir();

/** Node stream → web ReadableStream, so the response can be streamed rather than buffered. */
function toWebStream(path: string, opts: ReadableOptions & { start?: number; end?: number }) {
  const node = createReadStream(path, opts);
  return new ReadableStream({
    start(controller) {
      node.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk as Buffer)));
      node.on('end', () => controller.close());
      node.on('error', (err) => controller.error(err));
    },
    cancel() {
      node.destroy();
    },
  });
}

export async function GET(req: Request, ctx: { params: Promise<{ file: string }> }) {
  const { file } = await ctx.params;

  /**
   * The filename is generated server-side as `<8-hex>.wav`, so anything else is not ours. Matching
   * that shape exactly is a whitelist rather than a traversal blacklist — `..`, encoded separators
   * and absolute paths all simply fail to match.
   */
  if (!/^[0-9a-f]{8}\.wav$/.test(file)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const path = join(dir(), file);
  if (!existsSync(path)) {
    /**
     * Expected after a redeploy: the container filesystem is ephemeral, so uploads from a previous
     * instance are gone while their rows survive only if the database is on a volume. Say which it
     * is rather than returning a bare 404 that looks like a bug.
     */
    return NextResponse.json(
      { error: 'That audio is no longer on disk. Uploads do not survive a redeploy; the bundled sample calls always work.' },
      { status: 404 },
    );
  }

  const { size } = statSync(path);
  const range = req.headers.get('range');

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (Number.isFinite(start) && start <= end && start < size) {
        return new NextResponse(toWebStream(path, { start, end }), {
          status: 206,
          headers: {
            'Content-Type': 'audio/wav',
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Accept-Ranges': 'bytes',
          },
        });
      }
      return new NextResponse(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` },
      });
    }
  }

  return new NextResponse(toWebStream(path, {}), {
    status: 200,
    headers: {
      'Content-Type': 'audio/wav',
      'Content-Length': String(size),
      'Accept-Ranges': 'bytes',
    },
  });
}
