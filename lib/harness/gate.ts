/**
 * THE CITATION GATE — harness part 2, and the reason this product exists.
 *
 * A blocking check that can and does reject output. Not a comment saying TODO: validate.
 *
 * Two tiers, both deliberate. The reference spec flags "does the cited segment actually
 * SUPPORT the claim?" as a real design decision with several valid answers and says to pick
 * one openly rather than defaulting to whatever is easiest to code. Our answer:
 *
 *   Tier 1 — DOES THE CITATION RESOLVE?  Hard block. Every segment_id must exist in THIS
 *            call's transcript. This is exact, and failure means the claim is removed.
 *
 *   Tier 2 — DOES THE SEGMENT SUPPORT IT?  Soft flag. Deterministic content-word overlap
 *            between the claim and its cited segments. Below threshold the claim still ships
 *            but is marked `unverified` and rendered with a visible warning.
 *
 * Why overlap and not an LLM judge: it is free, instant, reproducible, and explainable to a
 * judge watching a demo ("here is the score, here is the threshold"). An LLM judge would be
 * more semantically accurate and is the obvious upgrade, but it adds a second model call to
 * every extraction and it cannot be shown to be deterministic on stage.
 *
 * Drop-vs-flag asymmetry, stated openly:
 *   • LIST claims (objections, next_steps, key_moments) with unresolvable citations are DROPPED.
 *     There is always a coherent output without them.
 *   • SINGLETON deliverables (intent, follow_up_email) are never silently dropped — removing
 *     them leaves a hole a reader would misread as "no objections found". They ship marked
 *     `unverified` with their unresolvable ids stripped, and they force run_status to 'partial'.
 * Either way, nothing ships as if it were grounded when it is not, and every decision is logged.
 */
import type {
  CitedClaim,
  Claim,
  Evidence,
  ExtractionDraft,
  ExtractionResult,
  GateRejection,
  RunStatus,
  TranscriptSegment,
  Verdict,
} from '@/lib/types';
import { REGISTRY_CONFIG } from '@/lib/registry';

// ── text normalisation (shared with the readability check) ────────────────────

const STOPWORDS = new Set(
  ('a an and are as at be been but by for from had has have he her his i if in into is it its me my of on or our ' +
    'she so than that the their them then there they this to was we were what when which who will with you your ' +
    'am do does did doing would could should will shall can may might must not no yes just really very')
    .split(' '),
);

/** Lowercase, strip punctuation, split. Hear already gives us lowercase unpunctuated text. */
export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Crude suffix stemmer. Enough to make `price`/`pricing` and `seat`/`seats` match, which is the
 * difference between a useful support score and a noisy one. Deliberately not a real stemmer —
 * this has to stay explainable on stage.
 */
function stem(t: string): string {
  for (const suf of ['ing', 'ed', 'es', 'ly', 's']) {
    if (t.length > suf.length + 2 && t.endsWith(suf)) return t.slice(0, -suf.length);
  }
  return t;
}

export function contentTokens(s: string): Set<string> {
  return new Set(
    tokenize(s)
      .filter((t) => !STOPWORDS.has(t) && t.length > 2)
      .map(stem),
  );
}

/**
 * Recall of the claim's content words in the cited evidence, in [0,1].
 *
 * Recall (not F1 or Jaccard) is the right measure: evidence is allowed to say much MORE than
 * the claim — a segment is usually longer than the sentence summarising it — but a claim
 * should not assert content that appears nowhere in what it cites.
 */
export function supportScore(claim: string, evidenceText: string): number {
  const want = contentTokens(claim);
  if (want.size === 0) return 1;
  const have = contentTokens(evidenceText);
  let hit = 0;
  for (const t of want) if (have.has(t)) hit++;
  return hit / want.size;
}

// ── the gate ─────────────────────────────────────────────────────────────────

type Verified = {
  segment_ids: string[];
  evidence: Evidence[];
  missing: string[];
  verdict: Verdict;
  support: number;
};

/**
 * @param tier2 Apply the support check to this field?
 *
 * TRUE for assertions about what was said (objections, next_steps) — those restate the call and
 * must lexically echo it.
 *
 * FALSE for abstractions and artifacts (intent labels, key-moment notes, the email draft). An
 * intent label like "price-sensitive" is a classification, not a restatement: it will never
 * lexically overlap "the pricing is the real problem", and an email is mostly the rep's own
 * prose. Scoring those with word overlap measures the wrong thing and would flag correct output
 * as unsupported. They still must pass tier 1 — the citation has to point at a real segment —
 * and their support score is still recorded so the choice stays auditable.
 */
function verifyCitations(
  claimText: string,
  ids: string[],
  index: Map<string, TranscriptSegment>,
  threshold: number,
  tier2: boolean,
): Verified {
  const evidence: Evidence[] = [];
  const missing: string[] = [];

  for (const id of ids) {
    const seg = index.get(id);
    if (!seg) {
      missing.push(id);
      continue;
    }
    // Timestamps and quoted text come from the SEGMENT, never from model prose.
    evidence.push({
      segment_id: seg.id,
      speaker: seg.speaker,
      start_ms: seg.start_ms,
      end_ms: seg.end_ms,
      text: seg.text,
    });
  }

  const support = evidence.length
    ? supportScore(claimText, evidence.map((e) => e.text).join(' '))
    : 0;

  return {
    segment_ids: evidence.map((e) => e.segment_id),
    evidence,
    missing,
    support,
    verdict:
      evidence.length === 0
        ? 'unverified' // tier 1 failed outright
        : tier2 && support < threshold
          ? 'unverified' // resolved, but the segment doesn't back the assertion
          : 'verified',
  };
}

export type GateOutcome = {
  result: ExtractionResult;
  rejections: GateRejection[];
};

/**
 * Run the gate. Returns the only version of the extraction anyone is allowed to see.
 *
 * @param draft       ungated model output
 * @param segments    the call's real transcript — the sole authority on what exists
 * @param extractedBy registry provider that produced the draft, recorded as provenance
 */
export function runCitationGate(
  draft: ExtractionDraft,
  segments: TranscriptSegment[],
  extractedBy?: string,
): GateOutcome {
  const threshold = REGISTRY_CONFIG.supportThreshold;
  const index = new Map(segments.map((s) => [s.id, s]));
  const rejections: GateRejection[] = [];

  /** List claims: drop when nothing resolves, flag when it resolves but doesn't support. */
  const gateList = (claims: Claim[], field: string): CitedClaim[] => {
    const kept: CitedClaim[] = [];
    claims.forEach((c, i) => {
      const at = `${field}[${i}]`;
      if (!c.segment_ids?.length) {
        rejections.push({
          field: at,
          claim: c.claim,
          reason: 'no_citation',
          detail: 'Claim arrived with no segment_ids at all.',
          dropped: true,
        });
        return;
      }
      // Assertions about what was said: both tiers apply.
      const v = verifyCitations(c.claim, c.segment_ids, index, threshold, true);
      if (v.evidence.length === 0) {
        rejections.push({
          field: at,
          claim: c.claim,
          reason: 'unresolvable_citation',
          detail: `Cited ${v.missing.join(', ')}; no such segment in this call. Claim dropped.`,
          dropped: true,
        });
        return;
      }
      if (v.missing.length) {
        rejections.push({
          field: at,
          claim: c.claim,
          reason: 'unresolvable_citation',
          detail: `Dropped unresolvable ${v.missing.join(', ')}; kept ${v.segment_ids.join(', ')}.`,
          dropped: false,
        });
      }
      if (v.verdict === 'unverified') {
        rejections.push({
          field: at,
          claim: c.claim,
          reason: 'unsupported_by_segment',
          detail: `Support ${v.support.toFixed(2)} < ${threshold}. Shipped flagged, not dropped.`,
          dropped: false,
        });
      }
      // Explicit, not a spread: `v` also carries `missing`, which is internal bookkeeping and
      // must not leak into the shipped result.
      kept.push({
        claim: c.claim,
        segment_ids: v.segment_ids,
        verdict: v.verdict,
        support: v.support,
        evidence: v.evidence,
      });
    });
    return kept;
  };

  /** Singleton deliverables: tier 1 only (abstractions), flag, never drop. */
  const gateSingleton = (text: string, ids: string[], field: string): Verified => {
    const v = verifyCitations(text, ids ?? [], index, threshold, false);
    if (v.evidence.length === 0) {
      rejections.push({
        field,
        claim: text.slice(0, 200),
        reason: ids?.length ? 'unresolvable_citation' : 'no_citation',
        detail: ids?.length
          ? `Cited ${v.missing.join(', ')}; none resolve. Shipped flagged as unverified.`
          : 'No segment_ids provided. Shipped flagged as unverified.',
        dropped: false,
      });
    }
    return v;
  };

  const objections = gateList(draft.objections ?? [], 'objections');
  const next_steps = gateList(draft.next_steps ?? [], 'next_steps');

  const intentV = gateSingleton(draft.intent.label, draft.intent.segment_ids, 'intent');
  const emailV = gateSingleton(
    `${draft.follow_up_email.subject} ${draft.follow_up_email.body}`,
    draft.follow_up_email.segment_ids,
    'follow_up_email',
  );

  // Key moments point at exactly one segment. If it doesn't exist, the moment doesn't exist.
  const key_moments = (draft.key_moments ?? [])
    .map((m, i) => {
      const seg = index.get(m.segment_id);
      if (!seg) {
        rejections.push({
          field: `key_moments[${i}]`,
          claim: m.note,
          reason: 'unresolvable_citation',
          detail: `Cited ${m.segment_id}; no such segment. Moment dropped.`,
          dropped: true,
        });
        return null;
      }
      return {
        ...m,
        evidence: {
          segment_id: seg.id,
          speaker: seg.speaker,
          start_ms: seg.start_ms,
          end_ms: seg.end_ms,
          text: seg.text,
        },
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);

  // ── exit status ────────────────────────────────────────────────────────────
  const attempted =
    (draft.objections?.length ?? 0) +
    (draft.next_steps?.length ?? 0) +
    (draft.key_moments?.length ?? 0);
  const survivedVerified =
    objections.filter((o) => o.verdict === 'verified').length +
    next_steps.filter((n) => n.verdict === 'verified').length +
    key_moments.length +
    (intentV.verdict === 'verified' ? 1 : 0) +
    (emailV.verdict === 'verified' ? 1 : 0);

  let run_status: RunStatus;
  if (attempted > 0 && survivedVerified === 0) {
    // Nothing at all held up. That is not a partial success, it is a failed extraction.
    run_status = 'failed';
  } else if (rejections.length > 0) {
    run_status = 'partial';
  } else {
    run_status = 'shipped';
  }

  return {
    rejections,
    result: {
      summary: draft.summary,
      intent: {
        label: draft.intent.label,
        segment_ids: intentV.segment_ids,
        verdict: intentV.verdict,
        support: intentV.support,
        evidence: intentV.evidence,
      },
      objections,
      next_steps,
      follow_up_email: {
        subject: draft.follow_up_email.subject,
        body: draft.follow_up_email.body,
        segment_ids: emailV.segment_ids,
        verdict: emailV.verdict,
        support: emailV.support,
        evidence: emailV.evidence,
      },
      key_moments,
      run_status,
      rejections,
      ...(extractedBy ? { extracted_by: extractedBy } : {}),
    },
  };
}
