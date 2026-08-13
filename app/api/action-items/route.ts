/**
 * POST /api/action-items — a person settles a commitment, or reopens one.
 *
 * The human half of the design. The model may only close an item by citing a line from a later
 * call; a person may close it because they know it happened, with no citation at all. That is the
 * same distinction the app draws everywhere else between what was said on a recording and what
 * someone asserts — and it is recorded rather than blurred, so a completion rate can say how much
 * of it is evidenced.
 *
 * `node:sqlite` means the Node runtime, not Edge.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { store } from '@/lib/db';

export const runtime = 'nodejs';

/**
 * Validated, never cast — the rule the upload and company routes already follow. `status` reaches a
 * completion percentage and a badge, so an arbitrary string would render as an unstyled item and a
 * silently wrong denominator rather than fail.
 */
const Input = z.object({
  id: z.string().min(1),
  status: z.enum(['open', 'done', 'dropped']),
});

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const parsed = Input.safeParse({
      id: form.get('id')?.toString() ?? '',
      status: form.get('status')?.toString() ?? '',
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues.map((i) => i.message).join(' ') },
        { status: 400 },
      );
    }
    const { id, status } = parsed.data;

    const item = await store().getActionItem(id);
    if (!item) return NextResponse.json({ error: 'No such action item.' }, { status: 404 });

    if (status === 'open') {
      /*
        Reopening CLEARS the resolution rather than leaving it in place.

        A stale citation on an open item would be worse than none: the UI would show a line
        "proving" something the user has just said did not happen, and the evidence trail is the
        one thing here that must never lie.
      */
      await store().resolveActionItem(id, {
        status: 'open',
        resolved_call_id: null,
        resolved_segment_id: null,
        resolved_start_ms: null,
        resolved_quote: null,
        resolved_note: null,
        resolved_by: null,
        resolved_at: null,
      });
    } else {
      // A person's judgement carries no citation, and says so by carrying no evidence at all.
      await store().resolveActionItem(id, {
        status,
        resolved_call_id: null,
        resolved_segment_id: null,
        resolved_start_ms: null,
        resolved_quote: null,
        resolved_note: null,
        resolved_by: 'human',
        resolved_at: Date.now(),
      });
    }

    return NextResponse.json({ item: await store().getActionItem(id) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
