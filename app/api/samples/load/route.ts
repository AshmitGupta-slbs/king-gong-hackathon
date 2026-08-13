/**
 * POST /api/samples/load — load (or reload) the committed sample calls into the database.
 *
 * The zero-setup path: no PyAI call, no model call, no credential, no network. Called
 * automatically on first page load; exposed as a route so a demo can re-seed on demand.
 */
import { NextResponse } from 'next/server';
import { loadSamples } from '@/lib/samples';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const force = new URL(req.url).searchParams.get('force') === '1';
  return NextResponse.json(loadSamples(force));
}
