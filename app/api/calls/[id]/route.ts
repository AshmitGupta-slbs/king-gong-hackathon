/** GET /api/calls/[id] — the full bundle: call, segments, gated extraction. */
/** DELETE /api/calls/[id] — remove the call and everything scoped to it. See lib/db.ts's deleteCall. */
import { NextResponse } from 'next/server';
import { deleteCall, getCall, getExtraction, getSegments } from '@/lib/db';
import { deleteUpload } from '@/lib/uploads';
import type { CallBundle } from '@/lib/types';

export const runtime = 'nodejs';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const call = await getCall(id);
  if (!call) return NextResponse.json({ error: 'No such call' }, { status: 404 });

  const bundle: CallBundle = {
    call,
    segments: await getSegments(id),
    extraction: await getExtraction(id),
  };
  return NextResponse.json(bundle);
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const call = await getCall(id);
  if (!call) return NextResponse.json({ error: 'No such call' }, { status: 404 });

  await deleteCall(id);
  // Only unlinks an actual uploaded file; a no-op for a bundled sample's /samples/*.wav.
  deleteUpload(call.audio_path);

  return NextResponse.json({ ok: true });
}
