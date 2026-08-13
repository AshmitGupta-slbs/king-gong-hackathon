/**
 * What each call taught us about an account, and where that leaves the account now.
 *
 * The problem this solves: an account's context was written once, before the first call, and never
 * moved again. Every call after that discovered something — a blocker, a commitment, a competitor —
 * and none of it survived anywhere a human or the next extraction could see.
 *
 * THREE RULES, and they are the whole design:
 *
 * 1. **A learning is derived, never authored.** Every row comes from a claim that already passed the
 *    citation gate, and it carries that claim's own evidence — segment id, timestamp, the quoted
 *    line. So "we learned they need year one under $5k" is clickable back to the moment somebody
 *    actually said it. Nothing is derived from `summary`, which is explicitly uncited synthesis.
 *
 * 2. **It never touches `notes`.** That field is what a human typed, and the extraction prompt
 *    presents it as "typed by the user, NOT said on this call". Writing model output into it would
 *    make that banner false, and would feed the model's own inference back to it next time as
 *    though a person had asserted it. Promotion into notes exists, but only as a deliberate click.
 *
 * 3. **Append-only.** A row records what a specific call established. Re-analysing a call replaces
 *    that call's rows and nothing else, so the account's history stays honest about when it learned
 *    what.
 */
import { db } from './db';
import type { ExtractionResult } from './types';

export type LearningKind = 'objection' | 'next_step' | 'intent' | 'competitor';

export type Learning = {
  id: number;
  company_id: string;
  call_id: string;
  created_at: number;
  kind: LearningKind;
  text: string;
  /** The proof, inherited from the gated claim. Null only for claims the gate left uncited. */
  segment_id: string | null;
  start_ms: number | null;
  speaker: string | null;
  quote: string | null;
  support: number | null;
  verdict: string | null;
  /** Which extractor produced the claim — a stub-derived learning must be distinguishable. */
  extracted_by: string | null;
  /** Has a human copied this into the account's own notes? */
  promoted: boolean;
};

/** `node:sqlite` returns null-prototype rows that RSCs refuse to serialize. Rebuild explicitly. */
function toLearning(r: Record<string, unknown>): Learning {
  return {
    id: r.id as number,
    company_id: r.company_id as string,
    call_id: r.call_id as string,
    created_at: r.created_at as number,
    kind: r.kind as LearningKind,
    text: r.text as string,
    segment_id: (r.segment_id as string | null) ?? null,
    start_ms: (r.start_ms as number | null) ?? null,
    speaker: (r.speaker as string | null) ?? null,
    quote: (r.quote as string | null) ?? null,
    support: (r.support as number | null) ?? null,
    verdict: (r.verdict as string | null) ?? null,
    extracted_by: (r.extracted_by as string | null) ?? null,
    promoted: Boolean(r.promoted),
  };
}

export function learningsForCompany(companyId: string, limit = 100): Learning[] {
  return (
    db()
      .prepare(
        `SELECT * FROM company_learnings WHERE company_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(companyId, limit) as Record<string, unknown>[]
  ).map(toLearning);
}

export function markLearningPromoted(id: number): void {
  db().prepare(`UPDATE company_learnings SET promoted = 1 WHERE id = ?`).run(id);
}

export function getLearning(id: number): Learning | null {
  const r = db().prepare(`SELECT * FROM company_learnings WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? toLearning(r) : null;
}

/**
 * Record what one call established about an account.
 *
 * Re-analysing the same call replaces only that call's rows — otherwise a second run would double
 * every learning and the account would look like it heard the same objection twice.
 */
export function recordLearnings(
  companyId: string,
  callId: string,
  ex: ExtractionResult,
): number {
  const d = db();
  d.prepare(`DELETE FROM company_learnings WHERE call_id = ?`).run(callId);

  const ins = d.prepare(
    `INSERT INTO company_learnings
       (company_id,call_id,created_at,kind,text,segment_id,start_ms,speaker,quote,support,verdict,extracted_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const now = Date.now();
  let n = 0;

  const add = (
    kind: LearningKind,
    text: string,
    ev: { segment_id: string; start_ms: number; speaker: string; text: string } | undefined,
    support: number | null,
    verdict: string | null,
  ) => {
    ins.run(
      companyId,
      callId,
      now,
      kind,
      text,
      ev?.segment_id ?? null,
      ev?.start_ms ?? null,
      ev?.speaker ?? null,
      ev?.text ?? null,
      support,
      verdict,
      ex.extracted_by ?? null,
    );
    n++;
  };

  /**
   * Objections and next steps are the two fields the gate scores for content overlap, so they are
   * the claims with the strongest proof behind them. Unverified ones are still recorded — the
   * account's history should show what was heard but not confirmed — and are marked as such so the
   * rollup can leave them out of the context block.
   */
  for (const c of ex.objections) add('objection', c.claim, c.evidence[0], c.support, c.verdict);
  for (const c of ex.next_steps) add('next_step', c.claim, c.evidence[0], c.support, c.verdict);

  add('intent', `Read on this call: ${ex.intent.label}`, ex.intent.evidence[0], ex.intent.support, ex.intent.verdict);

  for (const m of ex.key_moments) {
    if (m.type === 'competitor_mention') {
      add('competitor', m.note, m.evidence, null, 'verified');
    }
  }
  return n;
}

// ── where the account currently stands ───────────────────────────────────────

export type AccountState = {
  /** The most recent read on where the deal is. */
  latestIntent: Learning | null;
  /** Commitments made, newest first. */
  openNextSteps: Learning[];
  /** Concerns raised on more than one call — the ones that are actually blocking. */
  recurringObjections: { text: string; times: number; learning: Learning }[];
  competitors: string[];
  callsAnalysed: number;
};

/**
 * Derived on read rather than stored.
 *
 * A stored summary would be a fourth thing to keep in sync with the ledger and would go stale the
 * moment a call was re-analysed. The ledger is the source of truth; this is a view of it.
 */
export function accountState(companyId: string): AccountState {
  const all = learningsForCompany(companyId, 500);
  const verified = all.filter((l) => l.verdict !== 'unverified');

  const objections = verified.filter((l) => l.kind === 'objection');
  const seen = new Map<string, { text: string; times: number; learning: Learning }>();
  for (const o of objections) {
    // Group on the leading content of the claim: the same concern rarely comes back word for word.
    const key = o.text.toLowerCase().split(/\s+/).slice(0, 6).join(' ');
    const hit = seen.get(key);
    if (hit) hit.times++;
    else seen.set(key, { text: o.text, times: 1, learning: o });
  }

  return {
    latestIntent: verified.find((l) => l.kind === 'intent') ?? null,
    openNextSteps: verified.filter((l) => l.kind === 'next_step').slice(0, 6),
    recurringObjections: [...seen.values()]
      .filter((o) => o.times > 1)
      .sort((a, b) => b.times - a.times),
    competitors: [...new Set(verified.filter((l) => l.kind === 'competitor').map((l) => l.text))],
    callsAnalysed: new Set(all.map((l) => l.call_id)).size,
  };
}

/**
 * The block appended to the extraction prompt for the NEXT call with this account.
 *
 * Kept separate from the user's own notes and separately banner'd, because the two are different
 * kinds of true: one is a person's assertion, the other is this system's inference from an earlier
 * call. Only verified learnings are included — shipping an unconfirmed claim back in as background
 * would launder it into a fact.
 */
export function renderLearnedContext(companyId: string): string | null {
  const s = accountState(companyId);
  if (s.callsAnalysed === 0) return null;

  const lines: string[] = [];
  if (s.latestIntent) lines.push(`- ${s.latestIntent.text}`);
  for (const o of s.recurringObjections.slice(0, 4)) {
    lines.push(`- raised on ${o.times} calls: ${o.text}`);
  }
  for (const n of s.openNextSteps.slice(0, 4)) lines.push(`- agreed previously: ${n.text}`);
  if (s.competitors.length) lines.push(`- competitors named previously: ${s.competitors.join('; ')}`);

  return lines.length ? lines.join('\n') : null;
}
