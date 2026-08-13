/**
 * A commitment made on one call, tracked until a later call settles it.
 *
 * Its own table rather than a column on `company_learnings`, for two independent reasons. The
 * schema has no migration system, so a new column is a silent no-op on every database that already
 * exists and then throws at INSERT time, mid-run. And `promoted` on a learning already means
 * something else — "a human copied this into notes" — so completion cannot borrow it: a commitment
 * can be in the notes and still not done, or done and never written down.
 *
 * Kept dependency-free so client components can import the type without pulling the store in.
 */

/**
 * `open`    — agreed, not yet settled. Carries into the next call with this account.
 * `done`    — a later call said it happened, or a person said so.
 * `dropped` — a person decided it is no longer wanted. Never set by the model.
 */
export type ActionItemStatus = 'open' | 'done' | 'dropped';

/** Who settled it. A model resolution always carries a citation; a human's never does. */
export type ResolvedBy = 'model' | 'human';

export type ActionItem = {
  /**
   * `ai_<8 hex>`, generated here rather than by the backend.
   *
   * A string in both stores on purpose. Learnings are an autoincrement integer in SQLite and a UUID
   * in Mongo, and that split already produced one live bug where an endpoint coerced with `Number`
   * and silently did nothing on the deployed backend. It is also the id the MODEL quotes back, so
   * it has to be short, stable, and identical wherever the app runs.
   */
  id: string;
  company_id: string;
  /** The call that created it. */
  origin_call_id: string;
  created_at: number;
  text: string;

  /** The evidence the commitment was gated on, inherited from the next_steps claim. */
  segment_id: string | null;
  start_ms: number | null;
  speaker: string | null;
  quote: string | null;

  status: ActionItemStatus;

  /** How it was settled. All null while open. */
  resolved_call_id: string | null;
  resolved_segment_id: string | null;
  resolved_start_ms: number | null;
  resolved_quote: string | null;
  /** The later call's own words for what happened — never the original commitment's wording. */
  resolved_note: string | null;
  resolved_by: ResolvedBy | null;
  resolved_at: number | null;
};

/**
 * How an account is doing at keeping its commitments.
 *
 * `total` is the denominator the UI must always show alongside the percentage. "67%" on its own is
 * a claim about an account; "2 of 3" is a fact about three specific items, and the difference
 * matters when the number is small — which, on a real deal, it always is.
 */
export type FollowThrough = {
  done: number;
  open: number;
  dropped: number;
  total: number;
  /** null rather than 0 when nothing has been agreed yet: no commitments is not 0% kept. */
  pct: number | null;
};
