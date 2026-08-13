/**
 * Commitments, carried from the call that made them to the call that settles them.
 *
 * The ledger in `lib/learnings.ts` already records what each call ESTABLISHED. This records what
 * each call PROMISED, which is a different question with a different lifecycle: a learning is true
 * forever once it is true, whereas a commitment is open until something happens. That is why this
 * is its own table and its own module rather than a flag on a learning.
 *
 * FOUR RULES, and they are the whole design:
 *
 * 1. **Born only from a verified claim.** An item comes from a `next_steps` claim that already
 *    passed the citation gate, and inherits that claim's evidence. A commitment nobody can point
 *    at a line for is not a commitment worth chasing.
 *
 * 2. **Settled only with a citation, or by a person.** The model may mark an item done only by
 *    quoting a line from a LATER call that says so. A human may mark it done with no citation at
 *    all — that is what a human assertion is — and the two are stored distinguishably, because a
 *    percentage that mixes them without saying so is a worse number than either alone.
 *
 * 3. **Silence resolves nothing.** An item nobody mentioned stays open and comes back next time.
 *    That costs one line in a prompt; wrongly closing it costs the rep the follow-up.
 *
 * 4. **Never edited except to settle.** No rewording, no re-dating. The text is what the call
 *    agreed to, and it keeps pointing at the line where it was agreed.
 */
import { randomBytes } from 'node:crypto';
import { store } from './db';
import type { ExtractionResult, TranscriptSegment } from './types';
import type { ActionItem, FollowThrough } from './action-item-types';

export type { ActionItem, FollowThrough };

export const openActionItems = (companyId: string) => store().openActionItems(companyId);
export const actionItemsForCompany = (companyId: string) => store().actionItemsForCompany(companyId);

/** Short, stable, and pronounceable back by a model that has to quote it exactly. */
const newId = () => `ai_${randomBytes(4).toString('hex')}`;

/**
 * Grouping key for dedupe — the same six-word rule the learnings ledger uses for objections.
 *
 * Shared deliberately: "did we already agree this?" and "have we heard this objection before?" are
 * the same question about two kinds of sentence, and two different answers to it would be a bug
 * nobody would notice until an account showed the same commitment twice.
 */
const groupKey = (text: string) => text.toLowerCase().split(/\s+/).slice(0, 6).join(' ');

/**
 * Turn this call's verified next steps into open commitments.
 *
 * Only verified ones. An unverified next step ships in the notes with a visible warning because
 * hiding it would be lying by omission — but promoting it to something the account is measured
 * against would be treating an unconfirmed claim as a fact, which is the one thing this product
 * refuses to do.
 *
 * Idempotent against re-analysis: an item whose leading words already exist as an OPEN item for
 * this account is not added again. Deliberately not deduped against closed ones — the same
 * commitment made again after being fulfilled is a genuinely new commitment.
 */
export async function recordActionItems(
  companyId: string,
  callId: string,
  ex: ExtractionResult,
): Promise<number> {
  const existing = await store().openActionItems(companyId);
  const seen = new Set(existing.map((i) => groupKey(i.text)));

  const rows: ActionItem[] = [];
  for (const c of ex.next_steps) {
    if (c.verdict !== 'verified') continue;
    const key = groupKey(c.claim);
    if (seen.has(key)) continue;
    seen.add(key);

    const ev = c.evidence[0];
    rows.push({
      id: newId(),
      company_id: companyId,
      origin_call_id: callId,
      created_at: Date.now(),
      text: c.claim,
      segment_id: ev?.segment_id ?? null,
      start_ms: ev?.start_ms ?? null,
      speaker: ev?.speaker ?? null,
      quote: ev?.text ?? null,
      status: 'open',
      resolved_call_id: null,
      resolved_segment_id: null,
      resolved_start_ms: null,
      resolved_quote: null,
      resolved_note: null,
      resolved_by: null,
      resolved_at: null,
    });
  }

  await store().insertActionItems(rows);
  return rows.length;
}

/**
 * The block handed to the next call's extraction.
 *
 * Ids are the point. Without them the model would have to identify an item by restating it, and
 * matching on restated wording is exactly the fuzzy join this design exists to avoid — two
 * commitments about the same document would be indistinguishable, and the gate could not tell which
 * one a citation belonged to.
 *
 * Origin dates are included so "agreed three weeks ago" reads differently from "agreed yesterday".
 * The evidence quote is NOT, deliberately: it is wording from an earlier call, and putting it in
 * front of the model invites it back out in a claim about this one.
 */
export function renderOpenActionItems(items: ActionItem[]): string | null {
  if (items.length === 0) return null;
  return items
    .map((i) => {
      const when = new Date(i.created_at).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
      });
      return `- [${i.id}] agreed ${when}: ${i.text}`;
    })
    .join('\n');
}

/** Convenience for the harness, which holds a company rather than an id. */
export async function renderOpenForCompany(
  company: { id: string } | null,
): Promise<{ text: string | null; items: ActionItem[] }> {
  if (!company) return { text: null, items: [] };
  const items = await store().openActionItems(company.id);
  return { text: renderOpenActionItems(items), items };
}

/**
 * Apply the gate's surviving outcome judgements.
 *
 * Runs AFTER the gate, over what the gate let through, so a judgement citing a line that does not
 * exist has already been deleted and cannot close anything. `not_discussed` is a no-op by design:
 * it is the model reporting that this call did not settle the item, which leaves it exactly as it
 * was.
 */
export async function applyOutcomes(
  callId: string,
  ex: ExtractionResult,
  segments: TranscriptSegment[],
): Promise<number> {
  const byId = new Map(segments.map((s) => [s.id, s]));
  let closed = 0;

  for (const o of ex.outcomes ?? []) {
    if (o.status !== 'done') continue;
    /*
      Only a VERIFIED done closes anything.

      The gate ships an unverified judgement rather than deleting it, so the rejection card can show
      what was claimed and why it did not hold — the same treatment an unverified objection gets.
      But shipping it into the notes and acting on it are different things: a judgement whose cited
      line does not visibly say the thing happened must leave the commitment open, or the gate's
      verdict would be decoration.
    */
    if (o.verdict !== 'verified') continue;
    const ev = o.evidence[0];
    if (!ev) continue;
    const seg = byId.get(ev.segment_id);

    await store().resolveActionItem(o.item_id, {
      status: 'done',
      resolved_call_id: callId,
      resolved_segment_id: ev.segment_id,
      resolved_start_ms: ev.start_ms,
      resolved_quote: seg?.text ?? ev.text,
      resolved_note: o.note,
      resolved_by: 'model',
      resolved_at: Date.now(),
    });
    closed++;
  }
  return closed;
}

/**
 * How well an account keeps its word.
 *
 * `pct` is null rather than 0 when nothing has ever been agreed, because "no commitments" and "no
 * commitments kept" are different facts and rendering both as 0% would libel the first. Dropped
 * items leave the denominator: a commitment somebody consciously cancelled is not a failure to
 * follow through, and counting it as one would push reps toward leaving dead items open.
 */
export function followThrough(items: ActionItem[]): FollowThrough {
  const done = items.filter((i) => i.status === 'done').length;
  const open = items.filter((i) => i.status === 'open').length;
  const dropped = items.filter((i) => i.status === 'dropped').length;
  const total = done + open;
  return { done, open, dropped, total, pct: total === 0 ? null : Math.round((done / total) * 100) };
}
