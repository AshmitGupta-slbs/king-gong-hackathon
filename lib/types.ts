/**
 * THE DATA CONTRACT — the single canonical definition of a segment and a claim.
 *
 * Every part of this pipeline (ingestion, extraction, the citation gate, the transcript
 * viewer, export) depends on these shapes staying identical. Nothing else in this repo may
 * redefine a segment or a claim. If a shape needs to change, change it HERE, in the same
 * commit as the code that needs it.
 *
 * Zod schemas are the source of truth; the TypeScript types are inferred from them, so the
 * runtime validator and the compile-time type can never drift apart.
 */
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Transcript
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `rep` and `prospect` are the two roles we care about. A diarizing provider may hand us a
 * real name instead, so this stays an open string — but our own mappers only ever emit
 * these two literals, derived from the stereo channel index or the diarizer's speaker order.
 */
export const SpeakerSchema = z.string().min(1);

/**
 * The atomic unit every citation points into. One call produces an ordered list of these.
 *
 * `id` is assigned ONCE, at ingestion, from the diarized provider output — `seg_000`,
 * `seg_001`, ... ordered by `start_ms`. It is never reused, never reordered, and never
 * invented by a language model. PyAI hands back an integer index and float seconds; the
 * ingest mapper is what turns that into this shape (see docs/api-truth.md).
 */
/**
 * How speakers were separated. `channel` reads the party off the stereo channel index (exact,
 * model-free); `diarize` asks the model. `auto` is a *request* value only — the upload route
 * resolves it from the audio and never stores or forwards it, so the provider and the DB only
 * ever see a concrete mode. See lib/separation.ts.
 */
export const SeparationModeSchema = z.enum(['channel', 'diarize']);
export const RequestedSeparationSchema = z.enum(['auto', 'channel', 'diarize']);

export const TranscriptSegmentSchema = z.object({
  id: z.string().regex(/^seg_\d{3,}$/, 'segment ids look like seg_000'),
  speaker: SpeakerSchema,
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().nonnegative(),
  /**
   * VERBATIM provider output. This is the citation source of truth: the gate reads this, and
   * any quoted evidence comes from this. PyAI's Hear returns lowercase and unpunctuated text
   * and we deliberately do not clean it up here.
   */
  text: z.string(),
  /**
   * RESERVED, and currently written by nothing. Display rendering happens at the presentation
   * boundary instead — the UI and the Markdown export both call `readableFor(title)` from
   * lib/readability.ts per segment, so the rendered form is derived on demand rather than stored.
   * That is the better default: a stored rendering can go stale against the rules that produced it.
   *
   * Kept because a future ingest-time cache would land here. If you populate it, populate it with
   * `readableFor()` output and nothing else, or the screen and the export will disagree.
   *
   * Either way: NEVER read this in the gate, and never quote it as evidence. `text` is the citation
   * source of truth.
   */
  display_text: z.string().optional(),
  /** Present only for stereo/one-party-per-channel audio. */
  channel: z.number().int().optional(),
});

export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;
export type Speaker = z.infer<typeof SpeakerSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// What the model is asked to produce (a DRAFT — ungated, untrusted)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A claim about the call plus the segments that prove it.
 *
 * `segment_ids` is deliberately NOT constrained to the call's real IDs at the schema level.
 * We could enum-constrain it and make a fabricated citation structurally impossible — but
 * then the citation gate could never fire, and a gate that cannot fire is decoration. We
 * want real rejections, counted and shown. See docs/decisions.md.
 */
export const ClaimSchema = z.object({
  claim: z.string().describe('One specific, self-contained statement about the call.'),
  segment_ids: z
    .array(z.string())
    .min(1)
    .describe('IDs of the transcript segments that prove this claim, e.g. ["seg_014"].'),
});

export const IntentSchema = z.object({
  label: z
    .string()
    .describe('Short intent label, e.g. "high interest", "price-sensitive", "no decision".'),
  segment_ids: z.array(z.string()).min(1),
});

export const FollowUpEmailSchema = z.object({
  subject: z.string(),
  body: z.string().describe('Ready-to-send follow-up email, in the rep\'s voice.'),
  segment_ids: z
    .array(z.string())
    .min(1)
    .describe('Segments that justify what this email commits to.'),
});

export const KeyMomentSchema = z.object({
  type: z.enum(['objection', 'competitor_mention', 'pricing', 'next_step']),
  segment_id: z.string(),
  note: z.string().describe('One short line on why this moment matters.'),
});

/**
 * Exactly what the extraction model returns. Note what is NOT here: `run_status`, and any
 * verdict on whether a citation held up. Those are the GATE's outputs. A model must never be
 * able to declare its own output shipped.
 */
export const ExtractionDraftSchema = z.object({
  /** Free prose. A synthesis, not a claim, so it is not required to cite. */
  summary: z.string(),
  intent: IntentSchema,
  objections: z.array(ClaimSchema),
  next_steps: z.array(ClaimSchema),
  follow_up_email: FollowUpEmailSchema,
  key_moments: z.array(KeyMomentSchema),
});

export type ExtractionDraft = z.infer<typeof ExtractionDraftSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type KeyMoment = z.infer<typeof KeyMomentSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// What the gate produces (the only thing allowed to reach a user)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `verified`   — every cited segment exists AND plausibly supports the claim.
 * `unverified` — cited segments exist, but the text does not visibly support the claim.
 *                Ships with a visible warning rather than lying by omission.
 * (Claims whose citations do not resolve at all are DROPPED, not labelled — see the gate.)
 */
export const VerdictSchema = z.enum(['verified', 'unverified']);

/** Resolved evidence. Timestamps and quoted text come from the segment, never from prose. */
export const EvidenceSchema = z.object({
  segment_id: z.string(),
  speaker: SpeakerSchema,
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().nonnegative(),
  text: z.string(),
});

export const CitedClaimSchema = ClaimSchema.extend({
  verdict: VerdictSchema,
  /** Support score in [0,1] from the tier-2 check. Recorded so the threshold is auditable. */
  support: z.number().min(0).max(1),
  evidence: z.array(EvidenceSchema),
});

export const CitedIntentSchema = IntentSchema.extend({
  verdict: VerdictSchema,
  support: z.number().min(0).max(1),
  evidence: z.array(EvidenceSchema),
});

export const CitedEmailSchema = FollowUpEmailSchema.extend({
  verdict: VerdictSchema,
  support: z.number().min(0).max(1),
  evidence: z.array(EvidenceSchema),
});

export const CitedKeyMomentSchema = KeyMomentSchema.extend({
  evidence: EvidenceSchema,
});

/**
 * Why a claim was dropped or flagged. Every rejection is recorded with a reason — a silently
 * discarded claim is indistinguishable from a claim that was never made, which is exactly the
 * failure mode this product exists to prevent.
 */
export const GateRejectionSchema = z.object({
  field: z.string().describe('e.g. "objections[2]"'),
  claim: z.string(),
  reason: z.enum(['unresolvable_citation', 'no_citation', 'unsupported_by_segment']),
  detail: z.string(),
  dropped: z.boolean().describe('true = removed from output; false = shipped but flagged'),
});

/**
 * Every run of the pipeline ends in exactly one of these. No run may trail off without one.
 *
 * shipped  — everything passed the gate clean
 * partial  — some claims dropped or flagged, the rest shipped
 * failed   — the gate rejected the result outright, or a step failed after retries
 * deadline — the budget governor stopped the run before it could finish
 */
export const RunStatusSchema = z.enum(['shipped', 'partial', 'failed', 'deadline']);

export const ExtractionResultSchema = z.object({
  summary: z.string(),
  intent: CitedIntentSchema,
  objections: z.array(CitedClaimSchema),
  next_steps: z.array(CitedClaimSchema),
  follow_up_email: CitedEmailSchema,
  key_moments: z.array(CitedKeyMomentSchema),
  run_status: RunStatusSchema,
  rejections: z.array(GateRejectionSchema),
  /**
   * PROVENANCE — which registry provider produced the draft ('claude', 'bedrock',
   * 'stub-heuristic'). Persisted into samples/*.result.json so `check:ship` can refuse to ship
   * keyword-stub output dressed as model output, and so the UI can say plainly what made this.
   */
  extracted_by: z.string().optional(),
});

export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
export type CitedClaim = z.infer<typeof CitedClaimSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type GateRejection = z.infer<typeof GateRejectionSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type Verdict = z.infer<typeof VerdictSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Call
// ─────────────────────────────────────────────────────────────────────────────

export const CallSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Path under /public or /samples that the audio player loads. */
  audio_path: z.string(),
  duration_ms: z.number().int().nonnegative(),
  /** How speakers were separated — recorded so the UI can be honest about provenance. */
  separation: z.enum([...SeparationModeSchema.options, 'fixture']),
  created_at: z.number().int(),
  share_id: z.string().nullable(),
});

export type Call = z.infer<typeof CallSchema>;

/** A whole processed call: what the API returns and what export renders. */
export type CallBundle = {
  call: Call;
  segments: TranscriptSegment[];
  extraction: ExtractionResult | null;
};
