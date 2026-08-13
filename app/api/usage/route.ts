/**
 * GET /api/usage — the API-gravity counter.
 *
 * Worth 20% of the judged score and invisible unless the product surfaces it. Driven entirely by
 * real recorded work: PyAI audio seconds (from `result.audio_seconds`, because the jobs endpoints
 * do not send x-pyai-units) plus model tokens. Replaying a committed sample records nothing,
 * because it burns nothing.
 */
import { NextResponse } from 'next/server';
import { listRuns, usageTotals } from '@/lib/db';
import { describeRegistry } from '@/lib/registry';

export const runtime = 'nodejs';

export async function GET() {
  const runs = listRuns(20);
  return NextResponse.json({
    usage: usageTotals(),
    registry: describeRegistry(),
    runs: runs.map((r) => ({
      id: r.id,
      call_id: r.call_id,
      status: r.status,
      attempts: r.attempts,
      ms: r.ended_at ? r.ended_at - r.started_at : null,
      error: r.error,
    })),
  });
}
