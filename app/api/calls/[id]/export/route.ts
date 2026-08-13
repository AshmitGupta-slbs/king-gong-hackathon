/**
 * GET /api/calls/[id]/export?format=md|json
 *
 * Served as a real download with a sensible filename, because "export" that dumps text into a
 * browser tab is not an export.
 */
import { NextResponse } from 'next/server';
import { getCall, getExtraction, getSegments } from '@/lib/db';
import { toMarkdown } from '@/lib/export';
import type { CallBundle } from '@/lib/types';

export const runtime = 'nodejs';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const call = await getCall(id);
  if (!call) return NextResponse.json({ error: 'No such call' }, { status: 404 });

  const bundle: CallBundle = {
    call,
    segments: await getSegments(id),
    extraction: await getExtraction(id),
  };

  const format = new URL(req.url).searchParams.get('format') ?? 'md';
  const slug = call.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || id;

  if (format === 'json') {
    return new NextResponse(JSON.stringify(bundle, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${slug}.json"`,
      },
    });
  }
  if (format === 'md') {
    return new NextResponse(toMarkdown(bundle), {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${slug}.md"`,
      },
    });
  }
  return NextResponse.json({ error: 'format must be md or json' }, { status: 400 });
}
