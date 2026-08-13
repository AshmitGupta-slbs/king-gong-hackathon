/**
 * POST /api/demo/gate-check  { callId }
 *
 * The live gate demonstration — beat 5 of the demo script.
 *
 * It feeds a HAND-WRITTEN draft through the REAL citation gate. Three of its claims cite genuine
 * segments from the selected call; two cite segments that do not exist. Nothing here is mocked:
 * `runCitationGate` is the same function the production path calls, and the rejections it returns
 * are recorded to the same table.
 *
 * Being explicit about what this is: it does NOT invoke a model, and it is not pretending a model
 * hallucinated. Waiting for a real hallucination on stage would be a bad bet, and inventing one
 * while implying the model produced it would be dishonest. So we state plainly that these are
 * injected claims, and let the audience watch the gate do its job on them.
 */
import { NextResponse } from 'next/server';
import { getSegments, recordRejections } from '@/lib/db';
import { runCitationGate } from '@/lib/harness/gate';
import type { ExtractionDraft } from '@/lib/types';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const { callId } = (await req.json().catch(() => ({}))) as { callId?: string };
  if (!callId) return NextResponse.json({ error: 'callId required' }, { status: 400 });

  const segments = await getSegments(callId);
  if (segments.length === 0) {
    return NextResponse.json({ error: 'No such call, or it has no transcript' }, { status: 404 });
  }

  const real = segments.filter((s) => s.speaker !== 'rep').slice(0, 2);
  const first = real[0] ?? segments[0];
  const second = real[1] ?? segments[Math.min(1, segments.length - 1)];

  // A plausible-looking set of notes. Two of these claims are ungrounded.
  const draft: ExtractionDraft = {
    summary: 'Injected demonstration draft — three grounded claims, two fabricated citations.',
    intent: { label: 'price-sensitive', segment_ids: [first.id] },
    objections: [
      {
        claim: `Prospect raised a concern in their own words: ${first.text.split(/\s+/).slice(0, 12).join(' ')}…`,
        segment_ids: [first.id], // ← resolves
      },
      {
        claim: 'The prospect said their legal team has already blocked the purchase',
        segment_ids: ['seg_412'], // ← does not exist. Must be DROPPED.
      },
      {
        claim: 'The prospect confirmed a signed purchase order is in place',
        segment_ids: [second.id], // ← resolves, but the segment does not support this. FLAGGED.
      },
    ],
    next_steps: [
      {
        claim: 'Follow up on what was agreed at the end of the call',
        segment_ids: [segments[segments.length - 1].id], // ← resolves
      },
      {
        claim: 'Schedule the security review for next Tuesday',
        segment_ids: ['seg_999'], // ← does not exist. Must be DROPPED.
      },
    ],
    follow_up_email: {
      subject: 'Following up',
      body: 'Short recap of what we agreed.',
      segment_ids: [segments[segments.length - 1].id],
    },
    key_moments: [{ type: 'pricing', segment_id: 'seg_888', note: 'Fabricated moment' }], // DROPPED
  };

  const { result, rejections } = runCitationGate(draft, segments, 'injected-demo');

  // Same table the production path writes to, so the "claims blocked" counter moves for real.
  await recordRejections(callId, `demo-${Date.now()}`, rejections);

  return NextResponse.json({
    note:
      'Hand-written claims fed through the real citation gate. No model was called — this ' +
      'demonstrates the gate, it does not simulate a hallucination.',
    submitted: {
      objections: draft.objections.length,
      next_steps: draft.next_steps.length,
      key_moments: draft.key_moments.length,
    },
    survived: {
      objections: result.objections.length,
      next_steps: result.next_steps.length,
      key_moments: result.key_moments.length,
    },
    run_status: result.run_status,
    rejections,
    result,
  });
}
