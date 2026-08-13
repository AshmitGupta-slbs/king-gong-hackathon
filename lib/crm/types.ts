import { z } from 'zod';
/**
 * The CRM contract.
 *
 * Everything the call page knows about the account, the people and the deal comes through this
 * interface — never from a vendor payload directly. That is the same rule `lib/registry/` enforces
 * for models, and for the same reason: swapping the fixture for HubSpot should be one new file and
 * zero UI changes.
 *
 * Note what is NOT here: nothing derived from the transcript. Talk ratio, competitor mentions and
 * the rest are computed from segments in `lib/analytics.ts` and are clearly separated in the UI,
 * because those are measurements of a real recording while everything below is CRM record-keeping.
 */

/** Which side of the table someone sits on. Drives colour and grouping, never logic. */
export type Side = 'internal' | 'external';

export type Person = {
  id: string;
  name: string;
  title: string;
  email: string;
  side: Side;
  /** Optional — rendered as a phone row on the contact card when present. */
  phone?: string;
};

/**
 * A person who actually spoke on this call, tied back to the transcript's speaker label.
 *
 * `speaker` is the literal role that `segments.speaker` carries ('rep' | 'prospect'). Keeping the
 * mapping here — rather than renaming speakers in the data — is deliberate: `stub-heuristic.ts`,
 * `app/api/demo/gate-check/route.ts` and `scripts/test-harness.ts` all branch on
 * `speaker !== 'rep'`, so renaming in the data would quietly change what counts as an objection.
 */
export type Participant = Person & { speaker: string };

export type Account = {
  id: string;
  name: string;
  domain: string;
  industry: string;
  employees: string;
  location: string;
};

/**
 * A zod enum rather than a bare union: `stage` now arrives from a user-submitted form, and it feeds
 * a badge-tone lookup and (later) a kanban grouping, so an unrecognised value must fail at the
 * boundary instead of rendering as an unstyled column. `DealStageSchema.options` is also the single
 * list the /setup dropdown is built from, so the UI cannot drift from what the API accepts.
 */
export const DealStageSchema = z.enum([
  'Discovery',
  'Evaluation',
  'Negotiation',
  'Closed Won',
  'Closed Lost',
  'Stalled',
]);

export type DealStage = z.infer<typeof DealStageSchema>;

export type Deal = {
  id: string;
  name: string;
  stage: DealStage;
  /** Minor units avoided on purpose — this is display data, never arithmetic. */
  amount: number;
  currency: 'USD';
  close_date: string;
  owner: string;
  /** Days the deal has sat in its current stage. */
  days_in_stage: number;
};

export type Meeting = {
  id: string;
  /** ISO date. Fixed strings, never `Date.now()`-relative, so the demo reads the same tomorrow. */
  date: string;
  title: string;
  kind: 'call' | 'meeting' | 'email' | 'note';
  summary: string;
  /** Set when this activity is one of the calls in this app, so it can link. */
  call_id?: string;
};

/** Everything the UI can show around one call. */
export type CallContext = {
  account: Account;
  deal: Deal;
  /** People on THIS call, keyed back to transcript speaker labels. */
  participants: Participant[];
  /** People on the account who were not on this call. */
  associated: Person[];
  /** Prior activity, newest first. */
  history: Meeting[];
  /** Null when nothing is scheduled — a real and meaningful state for a stalled deal. */
  next_meeting: { date: string; title: string } | null;
};

export interface CrmProvider {
  readonly name: string;
  /**
   * Null when this call has no CRM record — the UI must degrade, not crash.
   *
   * Async because a provider may be a database or, later, an authenticated HubSpot call. The
   * fixture resolves immediately and simply returns a resolved promise.
   */
  forCall(callId: string): Promise<CallContext | null> | CallContext | null;
}
