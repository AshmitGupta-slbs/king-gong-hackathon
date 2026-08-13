/** GET /api/calls/[id] — the full bundle: call, segments, gated extraction. */
import { NextResponse } from 'next/server';
import { getCall, getExtraction, getSegments } from '@/lib/db';
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
