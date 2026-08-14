/**
 * Deal-methodology scoring — a DOWNSTREAM enrichment, called AFTER the citation gate has already
 * produced an `ExtractionResult`. See the schema comment in lib/types.ts for why this sits outside
 * the draft→gate flow entirely.
 *
 * The model is given ONLY this call's already-cited notes (summary, objections, next_steps,
 * key_moments, follow_up_email, outcomes) — never the raw transcript. Every id it may cite is
 * therefore one that already passed the real citation gate for some other claim; this module's own
 * job is smaller than the gate's: filter out anything that isn't actually one of those ids, never
 * trust a new one. That is `resolveCriterionEvidence` below, and it is a pure function specifically
 * so it can be tested without a model — see scripts/test-scoring.ts.
 *
 * Best-effort by design: returns `null` on any missing credential, refusal, or malformed output,
 * so the caller (lib/harness/loop.ts) can skip scoring without affecting the call's own run_status.
 */
import { REGISTRY_CONFIG } from '@/lib/registry';
import { runScoringModel } from '@/lib/registry/providers/scoring-claude';
import { hasBedrockCredentials, runScoringModelBedrock } from '@/lib/registry/providers/scoring-bedrock';
import type { UsageReport } from '@/lib/registry/types';
import {
  ScoringDraftSchema,
  type Evidence,
  type ExtractionResult,
  type ScoringBundle,
  type TranscriptSegment,
} from '@/lib/types';
import { METHODOLOGIES } from './methodologies';

const SCORING_SYSTEM = `You score a sales call against several deal-qualification methodologies, using ONLY the
already-extracted notes you are given below. You are not given a transcript, and you must not act as
though you have one.

For every criterion of every methodology listed, decide how well this call's notes evidence it
(0-100) and write one short rationale sentence.

Hard requirements:
- Base every score and rationale ONLY on the notes provided below. Never invent a fact that is not
  in them, and never imply you consulted the call itself.
- Every segment id you cite must be copied EXACTLY, character for character, from the ids shown in
  brackets next to the note you are using. Never invent an id, never guess one, never cite an id that
  is not shown to you — anything else is discarded before anyone sees it, so an uncited true score is
  worth more than a confidently-cited false one.
- If nothing in the notes supports a criterion, score it low and leave segment_ids empty. An empty
  list is a correct answer, not a failure.
- Return exactly one entry per methodology listed, and exactly one criterion entry per criterion key
  listed for that methodology — no more, no fewer.`;

function renderMethodologiesBlock(): string {
  return METHODOLOGIES.map(
    (m) =>
      `${m.id} (${m.name}): ` +
      m.criteria.map((c) => `${c.key} — ${c.label}: ${c.hint}`).join('; '),
  ).join('\n');
}

/**
 * Everything the scoring model is allowed to see, plus the exact set of segment ids it is allowed
 * to cite — every id that appears anywhere in `ex`'s own already-gated evidence. Nothing here reads
 * `segments` at all; that is the whole point.
 */
function renderCitableNotes(ex: ExtractionResult): { block: string; allowed: Set<string> } {
  const allowed = new Set<string>();
  const lines: string[] = [];

  const cite = (ids: string[]): string => {
    ids.forEach((id) => allowed.add(id));
    return ids.length ? `[${ids.join(', ')}]` : '[]';
  };

  lines.push(`Summary: ${ex.summary}`);
  lines.push(`Intent: ${ex.intent.label} ${cite(ex.intent.segment_ids)}`);

  ex.objections.forEach((c) => lines.push(`Objection: ${c.claim} ${cite(c.segment_ids)}`));
  ex.next_steps.forEach((c) => lines.push(`Next step: ${c.claim} ${cite(c.segment_ids)}`));
  ex.key_moments.forEach((m) => {
    allowed.add(m.evidence.segment_id);
    lines.push(`Key moment (${m.type}): ${m.note} [${m.evidence.segment_id}]`);
  });
  lines.push(
    `Follow-up email: ${ex.follow_up_email.subject} — ${ex.follow_up_email.body} ` +
      cite(ex.follow_up_email.segment_ids),
  );
  (ex.outcomes ?? []).forEach((o) =>
    lines.push(`Outcome ${o.item_id} (${o.status}): ${o.note} ${cite(o.segment_ids)}`),
  );

  return { block: lines.join('\n'), allowed };
}

function buildUserMessage(ex: ExtractionResult): { message: string; allowed: Set<string> } {
  const { block, allowed } = renderCitableNotes(ex);
  const message =
    `METHODOLOGIES AND CRITERIA\n${renderMethodologiesBlock()}\n\n` +
    `ALREADY-EXTRACTED, ALREADY-CITED NOTES FOR THIS CALL (bracketed ids are the only ids you ` +
    `may cite; an empty [] means nothing was cited for that note)\n${block}`;
  return { message, allowed };
}

/**
 * Everything that will actually be sent, as one string — the same shape `extractPromptText()`
 * gives the main extraction call in extract-shared.ts. Exists so the BUDGET GOVERNOR can size this
 * request from outside, the same way it already sizes the main call, without this module knowing
 * anything about tokens, caps or money.
 */
export function scoringPromptText(ex: ExtractionResult): string {
  return `${SCORING_SYSTEM}\n${buildUserMessage(ex).message}`;
}

/**
 * Pure and network-free on purpose: keep every id that (a) the model was actually shown — i.e. it
 * already backs some OTHER claim in this call's gated extraction — and (b) still exists in this
 * call's real segments, then resolve it into full `Evidence`. Anything else is silently stripped,
 * never shipped. Exported so scripts/test-scoring.ts can run adversarial cases with no API key.
 */
export function resolveCriterionEvidence(
  ids: string[],
  allowed: ReadonlySet<string>,
  segments: TranscriptSegment[],
): Evidence[] {
  const index = new Map(segments.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const id of ids) {
    if (!allowed.has(id) || seen.has(id)) continue;
    const seg = index.get(id);
    if (!seg) continue;
    seen.add(id);
    out.push({ segment_id: seg.id, speaker: seg.speaker, start_ms: seg.start_ms, end_ms: seg.end_ms, text: seg.text });
  }
  return out;
}

export type ScoreCallOutcome = { scoring: ScoringBundle; usage: UsageReport };

/**
 * Score a call's already-gated extraction against every methodology in METHODOLOGIES.
 *
 * Uses whichever provider `REGISTRY_CONFIG.extract` says the MAIN extraction actually used —
 * deliberately not an independent credential check. Scoring following a different provider than
 * the one actually configured is exactly how this silently did nothing on a Bedrock deployment
 * with no Anthropic key: `REGISTRY_CONFIG.extract` already knows which provider is real here.
 *
 * Returns `null` (never throws past this point in normal use) when there is no usable credential
 * for that provider, the model refused, output didn't validate, or nothing usable came back — the
 * caller treats absence as "scoring not available for this call" and moves on.
 */
export async function scoreCall(
  ex: ExtractionResult,
  segments: TranscriptSegment[],
): Promise<ScoreCallOutcome | null> {
  const { message, allowed } = buildUserMessage(ex);

  const hasAnthropicKey = Boolean(
    process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN,
  );

  let res;
  if (REGISTRY_CONFIG.extract === 'bedrock') {
    if (!hasBedrockCredentials()) return null;
    res = await runScoringModelBedrock(SCORING_SYSTEM, message, ScoringDraftSchema);
  } else if (REGISTRY_CONFIG.extract === 'claude') {
    if (!hasAnthropicKey) return null;
    res = await runScoringModel(SCORING_SYSTEM, message, ScoringDraftSchema);
  } else if (hasBedrockCredentials()) {
    /*
      The configured extractor is not itself a model we can score with — 'recap' (an external notes
      API with no scoring endpoint) or 'stub-heuristic'. Scoring is nonetheless still possible and
      still meaningful, because it reads the ALREADY-GATED extraction rather than the transcript: it
      does not care which engine wrote the notes, only that the claims it scores survived the gate.

      Falling back to credential detection here does NOT reintroduce the bug the comment above warns
      about. That bug was an independent credential check OVERRIDING a configured provider, picking
      Anthropic on a Bedrock-only deployment. Both configured model providers are still honoured
      first and exactly as before; this branch runs only where the previous behaviour was to return
      null and leave the call unscored. On a machine with no model credential at all, both checks
      fail and we return null as before.
    */
    res = await runScoringModelBedrock(SCORING_SYSTEM, message, ScoringDraftSchema);
  } else if (hasAnthropicKey) {
    res = await runScoringModel(SCORING_SYSTEM, message, ScoringDraftSchema);
  } else {
    return null; // no real model configured anywhere, nothing to score with
  }

  if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens' || !res.parsed_output) {
    return null;
  }
  const parsed = ScoringDraftSchema.safeParse(res.parsed_output);
  if (!parsed.success) return null;

  const byId = new Map(parsed.data.methodologies.map((m) => [m.methodology, m]));
  const methodologies = METHODOLOGIES.map((def) => byId.get(def.id))
    .filter((m): m is NonNullable<typeof m> => Boolean(m))
    .map((m) => ({
      methodology: m.methodology,
      overall: m.overall,
      criteria: m.criteria.map((c) => ({
        key: c.key,
        score: c.score,
        rationale: c.rationale,
        evidence: resolveCriterionEvidence(c.segment_ids, allowed, segments),
      })),
    }));

  if (methodologies.length === 0) return null;

  return {
    scoring: { methodologies, scored_at: Date.now() },
    usage: {
      input_tokens: res.usage?.input_tokens ?? 0,
      output_tokens: res.usage?.output_tokens ?? 0,
    },
  };
}
