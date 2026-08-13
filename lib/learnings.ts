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
 * 2. **It never touches `notes` by itself.** That field is what a human typed, and the extraction
 *    prompt presents it as "typed by the user, NOT said on this call". Writing model output into it
 *    would make that banner false. The one bridge is `suggestedNotes` — a DRAFT the user reads,
 *    edits and accepts, which is what makes the text theirs and the banner true again.
 *
 * 3. **Append-only.** A row records what a specific call established. Re-analysing a call replaces
 *    that call's rows and nothing else, so the account's history stays honest about when it learned
 *    what.
 */
import { store } from './db';
import type { ExtractionResult } from './types';
import type { Learning, LearningKind } from './learning-types';

export type { Learning, LearningKind };

export const learningsForCompany = (companyId: string, limit = 100) =>
  store().learningsForCompany(companyId, limit);

export const markLearningPromoted = (id: number | string) => store().markLearningPromoted(id);

export const getLearning = (id: number | string) => store().getLearning(id);

/**
 * Record what one call established about an account.
 *
 * Re-analysing the same call replaces only that call's rows — otherwise a second run would double
 * every learning and the account would look like it heard the same objection twice.
 */
export async function recordLearnings(
  companyId: string,
  callId: string,
  ex: ExtractionResult,
): Promise<number> {
  const now = Date.now();
  const rows: Omit<Learning, 'id'>[] = [];

  const add = (
    kind: LearningKind,
    text: string,
    ev: { segment_id: string; start_ms: number; speaker: string; text: string } | undefined,
    support: number | null,
    verdict: string | null,
  ) => {
    rows.push({
      company_id: companyId,
      call_id: callId,
      created_at: now,
      kind,
      text,
      segment_id: ev?.segment_id ?? null,
      start_ms: ev?.start_ms ?? null,
      speaker: ev?.speaker ?? null,
      quote: ev?.text ?? null,
      support,
      verdict,
      extracted_by: ex.extracted_by ?? null,
      promoted: false,
    });
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
    if (m.type === 'competitor_mention') add('competitor', m.note, m.evidence, null, 'verified');
  }

  // Replacing by call id is what makes a re-analysis idempotent: only THIS call's rows are
  // rewritten, so the account cannot end up looking like it heard the same objection twice.
  return store().replaceLearningsForCall(callId, rows);
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
export async function accountState(companyId: string): Promise<AccountState> {
  return stateFrom(await learningsForCompany(companyId, 500));
}

/** Group on the leading content of the claim: the same concern rarely comes back word for word. */
const groupKey = (text: string) => text.toLowerCase().split(/\s+/).slice(0, 6).join(' ');

/**
 * The rollup, over whatever slice of the ledger is passed in.
 *
 * Split out from `accountState` so the notes suggestion can run the same logic over only the rows
 * it is allowed to draw on, rather than re-deriving a second, slightly different idea of where an
 * account stands.
 */
function stateFrom(all: Learning[]): AccountState {
  const verified = all.filter((l) => l.verdict !== 'unverified');

  const seen = new Map<string, { text: string; times: number; learning: Learning }>();
  for (const o of verified.filter((l) => l.kind === 'objection')) {
    const hit = seen.get(groupKey(o.text));
    if (hit) hit.times++;
    else seen.set(groupKey(o.text), { text: o.text, times: 1, learning: o });
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
export async function renderLearnedContext(companyId: string): Promise<string | null> {
  /*
    PROMOTED ROWS ARE EXCLUDED, and that is the point of the flag rather than a UI detail.

    Once a person has accepted a learning into `notes`, that text already reaches the prompt — under
    the banner that says a human asserted it. Emitting it here as well would put the same sentence
    in front of the model twice under two different claims about where it came from. Worse, the
    prompt tells the model not to reuse background wording and the gate scores a claim by its
    overlap with the line it cites, so duplicated background makes a genuine claim look weaker.
  */
  const s = stateFrom((await learningsForCompany(companyId, 500)).filter((l) => !l.promoted));
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

// ── the one thing there is to accept ─────────────────────────────────────────

export type NotesSuggestion = {
  /** The draft, ready to be edited. */
  text: string;
  /** Exactly the rows this draft speaks for — the ones marked promoted if it is accepted. */
  learningIds: (number | string)[];
};

const INTENT_PREFIX = /^Read on this call:\s*/i;

/**
 * ONE editable draft per account, composed from everything the calls established that is not
 * already in the notes.
 *
 * This replaces a per-learning "Promote to notes" button, which was wrong in three ways at once.
 * It asked the same question eight times; it pasted model prose verbatim into a field the prompt
 * describes as human-typed; and because promoted rows were still emitted in the learned block, it
 * duplicated the text under two different claims of origin.
 *
 * It covers EVERYTHING outstanding, with no per-kind cap, because a cap is what turns one ask into
 * two: rows left out stay pending and surface as another suggestion the moment the first is
 * accepted. One accept has to settle the account or this is the old problem in fewer clicks.
 *
 * Length is handled by the person, not by truncation — the draft arrives in a textarea precisely so
 * it can be cut down. That matters more than it looks: notes are fed to the next extraction as
 * background, the model is told not to echo them, and the gate scores each claim by how much of it
 * appears in the line it cites. Bloated background is a way to make true claims fail, so the copy
 * asks for an edit rather than pretending the default is final.
 *
 * Nothing is written by this function. It returns a proposal; a person edits and accepts it, and
 * that acceptance is what makes the resulting notes theirs.
 */
export async function suggestedNotes(companyId: string): Promise<NotesSuggestion | null> {
  const pending = (await learningsForCompany(companyId, 500)).filter(
    (l) => !l.promoted && l.verdict !== 'unverified',
  );
  if (pending.length === 0) return null;

  const lines: string[] = [];
  const ids: (number | string)[] = [];

  // Every row that reaches the draft is collected, including the duplicates a grouped line speaks
  // for. Accepting marks all of them, so the account is settled in one action.
  const take = (l: Learning, line: string, alsoRepresents: Learning[] = []) => {
    lines.push(line);
    ids.push(l.id, ...alsoRepresents.map((o) => o.id));
  };

  const intent = pending.find((l) => l.kind === 'intent');
  if (intent) take(intent, `Where it stands: ${intent.text.replace(INTENT_PREFIX, '')}`);

  // Every distinct objection, not only the recurring ones: a blocker raised once is still worth
  // carrying into the next call. Repeats collapse into one line that says how often it came up.
  const objections = new Map<string, Learning[]>();
  for (const o of pending.filter((l) => l.kind === 'objection')) {
    const k = groupKey(o.text);
    objections.set(k, [...(objections.get(k) ?? []), o]);
  }
  for (const group of [...objections.values()].sort((a, b) => b.length - a.length)) {
    const [first, ...rest] = group;
    take(first, `Blocker${group.length > 1 ? ` (raised on ${group.length} calls)` : ''}: ${first.text}`, rest);
  }

  for (const n of pending.filter((l) => l.kind === 'next_step')) take(n, `Agreed: ${n.text}`);

  // These rows hold the model's NOTE about a competitor mention, not a company name, so they read as
  // sentences and overlap with the blockers above by their nature. Left in for the user to cut.
  for (const m of pending.filter((l) => l.kind === 'competitor')) take(m, `Competition: ${m.text}`);

  // More than one intent row is just the same question answered on each call; the most recent is
  // the only current one, and the rest are marked so they do not queue up as a second suggestion.
  const staleIntents = pending.filter((l) => l.kind === 'intent' && l.id !== intent?.id);
  ids.push(...staleIntents.map((l) => l.id));

  return lines.length ? { text: lines.join('\n'), learningIds: ids } : null;
}
