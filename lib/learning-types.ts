/**
 * The Learning shape, in its own module — same cycle-breaking reason as `company-types.ts`.
 */
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
