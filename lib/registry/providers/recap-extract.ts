/**
 * Extraction provider: PyAI Recap.
 *
 * The other two extractors send our prompt to a model and get our schema back. Recap is a different
 * kind of thing: a finished notes product. You hand it a speaker-labelled transcript, it hands back
 * its own call intelligence, and there is no prompt in between. That buys the brief's "Hear + Recap"
 * loop and costs three things, none of which are hidden:
 *
 *   1. `skills/`, account context, learned context and carried commitments cannot reach it, so
 *      `ignoresPromptContext` is true and the harness declines to record them as applied.
 *   2. It judges no earlier commitments, so `outcomes` is always absent.
 *   3. IT DOES NOT CITE. Every claim arrives without a segment id, so citations are resolved HERE
 *      rather than asserted by the engine. How that is done, and what it does and does not prove,
 *      is the substance of this file — see "Grounding" below.
 *
 * This file is the only place that knows Recap's response shape, the same rule pyai-jobs.ts follows
 * for Hear. It talks to lib/pyai.ts rather than fetch, so key resolution, the PyaiError taxonomy and
 * the quota remedies are the ones that run everywhere else.
 *
 * The record shape below was PROBED, not read: PyAI's OpenAPI types `record` as a bare `object` with
 * no properties. `scripts/probe/recap-probe.ts` is the probe and docs/api-truth.md has the findings,
 * including two that this code exists to work around (floored moment offsets, near-verbatim quotes).
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PyaiError, pyaiGet, pyaiPostJson } from '@/lib/pyai';
import { engineAvailability, RECAP_SCOPE_REMEDY } from '@/lib/engine-availability';
/**
 * The GATE's own scorer, imported rather than reimplemented.
 *
 * Deliberate, and the direction of the dependency is deliberate too. The grounder below chooses a
 * citation by lexical support, and the gate then re-scores it; if those were two copies of "how well
 * does this line support this claim?", they could drift apart and the gate would start dropping
 * claims for failing a test the grounder thought it had passed. One definition, one behaviour.
 */
import { supportScore, tokenize } from '@/lib/harness/gate';
import { ExtractionDraftSchema, type ExtractionDraft, type TranscriptSegment } from '@/lib/types';
import type { ExtractProvider, ExtractRequest, ExtractResult } from '../types';

// ── Recap's wire shape (probed Fri 14 Aug 2026; pack `sales_outbound`) ────────

/**
 * Every field optional, and unknown keys passed through.
 *
 * `record` is untyped upstream and its contents are pack-driven — `extracted_fields` alone had a
 * completely different key set on each of the two calls probed. A strict schema here would turn
 * PyAI shipping one new field into a failed extraction, which is the wrong trade for notes.
 * What we do NOT do is drop the difference silently: `unmappedKeys` below reports it.
 */
/**
 * Every optional string field below is `.nullish()`, not `.optional()`.
 *
 * `due` was already `.nullish()` with a note that it had been "observed null" — that was Recap
 * sending an explicit `null` rather than omitting the key. A real 13-minute call hit the same
 * behaviour on `objections[].response_quality`, which was still `.optional()` (accepts a missing
 * key, rejects an explicit `null`) and threw `ZodError: invalid_type, expected string, received
 * null` out of `RecapRecordSchema.parse()`. `due` was one instance of a pattern, not the only
 * field it applies to — every other declared-optional string here can plausibly arrive as `null`
 * the same way, so all of them take the fix `due` already had, not just the one that broke first.
 */
const RecapQuoteSchema = z.object({ quote: z.string().nullish(), category: z.string().nullish() });

const RecapRecordSchema = z
  .object({
    tldr: z.string().nullish(),
    summary: z.string().nullish(),
    summary_draft: z.string().nullish(),
    /** Prose, NOT a list — easy to misread from the docs. */
    next_steps: z.string().nullish(),
    action_items: z
      .array(
        z.object({
          task: z.string(),
          owner: z.string().nullish(),
          due: z.string().nullish(),
        }),
      )
      .optional(),
    objections: z
      .array(
        z.object({
          /** A quote of the submitted utterance — see `groundByQuote` for why "a" and not "the". */
          text: z.string(),
          note: z.string().nullish(),
          response_quality: z.string().nullish(),
          agent_response_type: z.string().nullish(),
        }),
      )
      .optional(),
    moments: z
      .array(
        z.object({
          category: z.string(),
          /** ⚠ A FLOORED utterance start, not a point in time. See `groundByOffset`. */
          offset_s: z.number(),
          description: z.string(),
        }),
      )
      .optional(),
    buying_signals: z.array(RecapQuoteSchema).optional(),
    risk_signals: z.array(RecapQuoteSchema.extend({ severity: z.string().nullish() })).optional(),
    /**
     * A DIFFERENT shape from the other signal arrays — `{name, context, sentiment, mentioned_by}`,
     * with no quote anywhere. Worth the note: this was empty on both calls used to derive this
     * schema, so an earlier version of this file assumed `{quote, category}` like its neighbours and
     * silently dropped every competitor mention on the one sample that is *about* competitors.
     * Hence `unresolved` accounting in the mapper: an element that grounds to nothing gets counted,
     * never quietly skipped.
     */
    competitor_mentions: z
      .array(
        z
          .object({
            name: z.string().nullish(),
            context: z.string().nullish(),
            sentiment: z.string().nullish(),
            mentioned_by: z.string().nullish(),
            quote: z.string().nullish(),
          })
          .passthrough(),
      )
      .optional(),
    key_decisions: z.array(z.string()).optional(),
    coverage_gaps: z
      .array(
        z.object({
          fact: z.string().nullish(),
          type: z.string().nullish(),
          transcript_quote: z.string().nullish(),
        }),
      )
      .optional(),
  })
  .passthrough();

type RecapRecord = z.infer<typeof RecapRecordSchema>;

const RecapCallSchema = z
  .object({
    call_id: z.string(),
    status: z.enum(['pending', 'processing', 'complete', 'failed']),
    headline: z.string().nullish(),
    record: z.unknown().optional(),
    error: z.string().nullish(),
    processing: z.object({ stage: z.string().optional() }).partial().passthrough().optional(),
  })
  .passthrough();

type RecapCall = z.infer<typeof RecapCallSchema>;

/**
 * Keys we read, plus keys we knowingly leave on the table. Anything outside this set is NEW, and is
 * reported louder — `ExtractionResult` has nowhere to put `analytics` or `sentiment_phases` today,
 * but "we chose not to map this" and "we never noticed this existed" must not look the same.
 */
const MAPPED_KEYS = new Set([
  'tldr',
  'summary',
  'summary_draft',
  'next_steps',
  'action_items',
  'objections',
  'moments',
  'buying_signals',
  'risk_signals',
  'competitor_mentions',
]);
const KNOWN_UNMAPPED_KEYS = new Set([
  'analytics',
  'sentiment_phases',
  'coverage_gaps',
  'extracted_fields',
  'key_decisions',
]);

// ── Polling ──────────────────────────────────────────────────────────────────

/** Same cadence as pyai-jobs.ts. Recap completed in 3.5–4.7s for a 10-utterance call when probed. */
const POLL_INTERVAL_MS = 1_200;
/** Matches the STT poll deadline and the default wall-clock cap, so nothing waits past the budget. */
const POLL_TIMEOUT_MS = 180_000;

// ── Grounding ────────────────────────────────────────────────────────────────

/**
 * How a citation was resolved. Recorded so the log can say which mechanism carried a run, because
 * these are NOT equally strong and treating them as one number would be the dishonest version.
 *
 * 'quote'       — the segment's text literally contains Recap's quote. A lookup, not a judgement.
 * 'quote-fuzzy' — Recap's quote repaired the ASR (measured: Hear's `stig` → Recap's `stigma`), so it
 *                 matched on token overlap instead. Still a quote resolution.
 * 'offset'      — resolved from `moments[].offset_s` by NEAREST SEGMENT START. Exact in the probes.
 * 'lexical'     — no quote and no offset, so the best-supported segment was searched for. This is
 *                 the weak one: see the note on `groundByText`.
 */
type GroundMethod = 'quote' | 'quote-fuzzy' | 'offset' | 'lexical';
type Grounding = { ids: string[]; method: GroundMethod } | null;

/** Quote matching works on raw tokens, not content words: a quote is a string, not an assertion. */
const normalise = (s: string) => tokenize(s).join(' ');

/** Recall of the quote's tokens in a segment. 0.88 was the measured value for the one ASR repair. */
const QUOTE_FUZZY_MIN = 0.6;

/**
 * Resolve one of Recap's quotes to the segment it came from.
 *
 * Exact substring match hit 14/16 across the probed calls. Both misses were the same quote, and the
 * reason matters: Recap silently CORRECTS transcription damage in the text it quotes, so its prose
 * is near-verbatim rather than verbatim. Hence the tolerant second pass.
 *
 * This does not weaken the evidence shown to anyone. `lib/harness/gate.ts` builds every Evidence
 * object from the SEGMENT — its text, its speaker, its timestamps — never from provider prose.
 */
function groundByQuote(quote: string, segments: TranscriptSegment[]): Grounding {
  const q = normalise(quote);
  if (!q) return null;

  for (const seg of segments) {
    if (normalise(seg.text).includes(q)) return { ids: [seg.id], method: 'quote' };
  }

  const want = new Set(tokenize(quote));
  if (want.size === 0) return null;
  let best: { id: string; score: number } | null = null;
  for (const seg of segments) {
    const have = new Set(tokenize(seg.text));
    let hit = 0;
    for (const t of want) if (have.has(t)) hit++;
    const score = hit / want.size;
    if (!best || score > best.score) best = { id: seg.id, score };
  }
  return best && best.score >= QUOTE_FUZZY_MIN
    ? { ids: [best.id], method: 'quote-fuzzy' }
    : null;
}

/** Widest gap measured between a moment's offset and its segment's start was +0.76s. */
const OFFSET_TOLERANCE_MS = 1_500;

/**
 * Resolve a moment's `offset_s` to a segment by NEAREST START — never by containment.
 *
 * Recap returns whole seconds, and they are the TRUNCATED start offset of the utterance it means.
 * Flooring puts the value just below that utterance's start, so asking "whose [start, end] window
 * contains this?" returns the PREVIOUS segment. Measured on two calls: containment 0/6 and it
 * inverted the speaker every single time; nearest start 6/6. A citation that names the wrong party
 * is worse than no citation, so this returns null rather than guess when nothing is close.
 */
function groundByOffset(offsetS: number, segments: TranscriptSegment[]): Grounding {
  const target = offsetS * 1000;
  let best: { id: string; delta: number } | null = null;
  for (const seg of segments) {
    const delta = Math.abs(seg.start_ms - target);
    if (!best || delta < best.delta) best = { id: seg.id, delta };
  }
  return best && best.delta <= OFFSET_TOLERANCE_MS ? { ids: [best.id], method: 'offset' } : null;
}

/**
 * Last resort: search for the segment that best supports the claim, using the gate's own scorer.
 *
 * BE CLEAR ABOUT WHAT THIS PROVES. For a self-citing model, the gate asks "does the line you chose
 * back what you said?" and can answer no. Here we chose the line, so the gate can no longer catch a
 * MIS-citation — only an UNSUPPORTABLE claim.
 *
 * That second check is still real, and it is the one that matters for an external engine: the argmax
 * does not clear `supportThreshold` just because it is the argmax. A claim Recap wrote that nothing
 * in the transcript backs scores below the line, and the gate marks it `unverified`, logs a rejection
 * and downgrades the run. Which is why nothing here filters on the score: the best candidate is cited
 * unconditionally and the gate is left to rule on it. Filtering first would make the gate a formality
 * that could only ever agree with us.
 *
 * ⚠ AND BE CLEAR ABOUT THE LIMIT. The gate DELETES a claim only when its citation does not resolve.
 * A derived citation always resolves, because it was picked from the real segment list — so for this
 * engine the delete path is unreachable and a flag is the strongest sanction available. "Unprovable
 * claims are deleted rather than softened" is true of a model that mis-cites its own lines; for
 * Recap's notes the accurate statement is that unsupported claims ship visibly flagged on a partial
 * run. `describeExtractor('recap')` says so to the reader, and `scripts/test-gate.ts` §9 pins both
 * halves down so neither can quietly change.
 */
function groundByText(claim: string, segments: TranscriptSegment[]): Grounding {
  if (segments.length === 0) return null;
  const scored = segments
    .map((seg) => ({ id: seg.id, text: seg.text, score: supportScore(claim, seg.text) }))
    .sort((a, b) => b.score - a.score);

  const first = scored[0];
  // A second citation only if it actually adds support — a model cites one or two lines, not five,
  // and padding the list would inflate `support` without making the claim any better evidenced.
  const second = scored[1];
  if (second) {
    const combined = supportScore(claim, `${first.text} ${second.text}`);
    if (combined > first.score) return { ids: [first.id, second.id], method: 'lexical' };
  }
  return { ids: [first.id], method: 'lexical' };
}

/** Try the strong mechanisms first, fall back to the weak one. */
function ground(
  segments: TranscriptSegment[],
  claim: string,
  opts: { quote?: string; offsetS?: number } = {},
): Grounding {
  if (opts.quote) {
    const byQuote = groundByQuote(opts.quote, segments);
    if (byQuote) return byQuote;
  }
  if (typeof opts.offsetS === 'number') {
    const byOffset = groundByOffset(opts.offsetS, segments);
    if (byOffset) return byOffset;
  }
  return groundByText(claim, segments);
}

// ── Mapping Recap's record onto our draft ────────────────────────────────────

/** Recap speaks agent/customer; this product speaks rep/prospect. A missing or null owner defaults to Rep. */
const ownerLabel = (owner: string | null | undefined) => (owner === 'customer' ? 'Prospect' : 'Rep');

/** 'explicit_interest' → 'explicit interest'. Recap's own vocabulary, just readable. */
const humanise = (s: string) => s.replace(/[_-]+/g, ' ').trim().toLowerCase();

/**
 * Recap capitalises each task as a sentence ("Send the paper over today"), which reads wrong once it
 * is spliced after an owner ("Rep to Send the paper"). Only the first letter is touched, and only
 * when the word is not an acronym, so "Send the SOC 2 report" keeps its capitals where they belong.
 */
const uncapitalise = (s: string) => {
  const first = s.split(/\s+/, 1)[0] ?? '';
  if (first.length > 1 && first === first.toUpperCase()) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
};

/**
 * Recap's moment categories → our closed `key_moments` enum.
 *
 * Categories observed: buying_signal, objection_raised, risk_flagged, commitment_made. A category
 * with no honest counterpart is SKIPPED and counted, not forced into the nearest-looking bucket —
 * mislabelling a moment is worse than omitting it, and `buying_signal` is not lost either way
 * because it is what `intent` is derived from below.
 */
const MOMENT_TYPES: Record<string, ExtractionDraft['key_moments'][number]['type']> = {
  objection_raised: 'objection',
  objection: 'objection',
  risk_flagged: 'objection',
  commitment_made: 'next_step',
  next_step: 'next_step',
  pricing_discussed: 'pricing',
  pricing: 'pricing',
  competitor_mentioned: 'competitor_mention',
  competitor_mention: 'competitor_mention',
};

type MapReport = {
  methods: Record<GroundMethod, number>;
  /** Deliberately not carried across — a category with no honest home in our schema. */
  skipped: string[];
  /**
   * Something Recap DID say that we failed to place. Distinct from `skipped` on purpose: skipped is
   * a decision, unresolved is a shortfall, and collapsing the two is how the competitor-mention bug
   * survived — the field was in the mapped list, so nothing reported that it produced nothing.
   */
  unresolved: string[];
  /** A top-level `record` key this provider has never seen. */
  unmapped: string[];
};

function toDraft(
  record: RecapRecord,
  headline: string | null | undefined,
  segments: TranscriptSegment[],
  callTitle: string,
  customerName: string | undefined,
): { draft: ExtractionDraft; report: MapReport } {
  const report: MapReport = {
    methods: { quote: 0, 'quote-fuzzy': 0, offset: 0, lexical: 0 },
    skipped: [],
    unresolved: [],
    unmapped: [],
  };
  const count = (g: Grounding) => {
    if (g) report.methods[g.method]++;
    return g;
  };

  // ── summary: prose, and the one field the gate never asks to cite ──
  const summary = record.summary_draft ?? record.summary ?? record.tldr ?? headline ?? '';

  // ── objections: the claim is Recap's quote, resolved to the line it quoted ──
  const objections = (record.objections ?? []).flatMap((o) => {
    const g = count(ground(segments, o.text, { quote: o.text }));
    if (!g) {
      report.unresolved.push('objections (no segment matched)');
      return [];
    }
    return [{ claim: o.text, segment_ids: g.ids }];
  });

  // ── next_steps: composed so the OWNER survives, which is the point of an action item ──
  // `due` is left out of the claim text on purpose: it is rarely provable from any single line, and
  // every unprovable word in a claim drags down the support score of the part that IS provable.
  const nextSteps = (record.action_items ?? []).flatMap((a) => {
    const claim = `${ownerLabel(a.owner)} to ${uncapitalise(a.task)}`;
    // Grounded on the task alone — the owner label is ours, so scoring the transcript against it
    // would be scoring the transcript against our own formatting.
    const g = count(ground(segments, a.task));
    if (!g) {
      report.unresolved.push('action_items (no segment matched)');
      return [];
    }
    return [{ claim, segment_ids: g.ids }];
  });

  // ── intent: a label Recap actually stated, cited to the line it quoted for it ──
  const signal = record.buying_signals?.find((s) => s.category || s.quote)
    ?? record.risk_signals?.find((s) => s.category || s.quote);
  let intent: ExtractionDraft['intent'] | null = null;
  if (signal?.category) {
    const g = count(ground(segments, signal.category, { quote: signal.quote ?? undefined }));
    if (g) intent = { label: humanise(signal.category), segment_ids: g.ids };
  }
  if (!intent && record.moments?.length) {
    const m = record.moments[0];
    const g = count(ground(segments, m.description, { offsetS: m.offset_s }));
    if (g) intent = { label: humanise(m.category), segment_ids: g.ids };
  }
  if (!intent) {
    // Nothing classified this call. Say so, rather than inventing a label — and still cite, so the
    // gate gets to rule on it like anything else.
    const basis = record.tldr ?? headline ?? callTitle;
    const g = count(groundByText(basis, segments));
    intent = { label: 'not classified', segment_ids: g?.ids ?? [] };
  }

  // ── key_moments: tier-1 only by design, which is why Recap's own commentary belongs here ──
  const keyMoments: ExtractionDraft['key_moments'] = [];
  for (const m of record.moments ?? []) {
    const type = MOMENT_TYPES[m.category];
    if (!type) {
      report.skipped.push(`moments.category=${m.category}`);
      continue;
    }
    const g = count(ground(segments, m.description, { offsetS: m.offset_s }));
    if (g) keyMoments.push({ type, segment_id: g.ids[0], note: m.description });
    else report.unresolved.push('moments (no segment matched)');
  }
  /*
    Recap's `objections[].note` is its read of how the rep HANDLED the objection, and it is dropped
    rather than shown. It has no locatable line, and both ways of pretending otherwise are wrong:
    citing the objection's own quote attributes commentary about the AGENT to the CUSTOMER's turn
    (observed doing exactly that — "Agent offers a solution" cited to the prospect), and grounding it
    lexically finds nothing, because "agent offers a solution to the customer's concern" shares no
    content word with anything anyone said, so the argmax would be arbitrary.

    Nothing of substance is lost: the objection itself is in `objections`, cited to the exact line it
    was quoted from. What is lost is a judgement about the rep, which this product only makes where it
    can point at the words that justify it.
  */
  for (const o of record.objections ?? []) {
    if (o.note) report.skipped.push('objections.note (no locatable line)');
  }
  for (const r of record.risk_signals ?? []) {
    const note = [r.category && humanise(r.category), r.severity && `severity: ${r.severity}`]
      .filter(Boolean)
      .join(' · ');
    if (!note || !r.quote) {
      report.unresolved.push('risk_signals (no quote or no category)');
      continue;
    }
    const g = count(ground(segments, r.quote, { quote: r.quote }));
    if (g) keyMoments.push({ type: 'objection', segment_id: g.ids[0], note });
    else report.unresolved.push('risk_signals (no segment matched)');
  }
  for (const cm of record.competitor_mentions ?? []) {
    const note = [cm.name, cm.context].filter(Boolean).join(' — ') || cm.quote;
    if (!note) {
      report.unresolved.push('competitor_mentions (no name, context or quote)');
      continue;
    }
    /*
      A competitor's NAME is the strongest available handle: "gong" and "chorus" appear literally in
      the transcript, so matching on the name is a lookup rather than a similarity judgement. The
      quote path is kept for packs that do supply one, and `context` is the last resort because it is
      Recap's own prose and will only ever match loosely.
    */
    const g = count(
      ground(segments, cm.context ?? note, { quote: cm.quote ?? cm.name ?? undefined }),
    );
    if (g) keyMoments.push({ type: 'competitor_mention', segment_id: g.ids[0], note });
    else report.unresolved.push('competitor_mentions (no segment matched)');
  }

  // ── follow_up_email: ASSEMBLED, not authored. Recap writes no email. ──
  // Built only from things Recap did say (its one-liner, its action items, its next-step prose), so
  // it commits to nothing the notes do not already contain. The interface says it was assembled;
  // that disclosure lives in the UI and not in the body, because the body is meant to be sendable.
  const greetName = customerName?.trim().split(/\s+/)[0];
  const lines = [`Hi${greetName ? ` ${greetName}` : ''},`, ''];
  const opener = record.tldr ?? headline;
  lines.push(opener ? `Thanks for your time today. ${opener}` : 'Thanks for your time today.');
  if (nextSteps.length) {
    lines.push('', 'Where we landed:');
    for (const s of nextSteps) lines.push(`- ${s.claim}`);
  }
  if (record.next_steps) lines.push('', record.next_steps);
  lines.push('', 'Best,');
  const emailIds = [...new Set(nextSteps.flatMap((s) => s.segment_ids))];
  const emailGrounding = emailIds.length
    ? { ids: emailIds, method: 'quote' as GroundMethod }
    : groundByText(opener ?? callTitle, segments);
  const followUpEmail = {
    subject: `Follow-up: ${opener ?? callTitle}`.slice(0, 160),
    body: lines.join('\n'),
    segment_ids: emailGrounding?.ids ?? [],
  };

  for (const key of Object.keys(record)) {
    if (MAPPED_KEYS.has(key) || KNOWN_UNMAPPED_KEYS.has(key)) continue;
    report.unmapped.push(key);
  }

  return {
    draft: {
      summary,
      intent,
      objections,
      next_steps: nextSteps,
      follow_up_email: followUpEmail,
      key_moments: keyMoments,
      // `outcomes` is deliberately absent, not empty-by-accident: Recap is never shown the
      // commitments carried in from earlier calls, so it has judged nothing and must claim nothing.
    },
    report,
  };
}

// ── The provider ─────────────────────────────────────────────────────────────

/**
 * A stable id for calls that do not have one.
 *
 * `scripts/extract-samples.ts` re-extracts committed transcripts, which are not calls. Recap keys
 * records BY call id, so hashing the transcript makes a re-run return the record it already produced
 * instead of billing a second identical extraction.
 */
function derivedCallId(segments: TranscriptSegment[]): string {
  const h = createHash('sha256');
  for (const s of segments) h.update(`${s.id} ${s.speaker} ${s.text} `);
  return `og-t-${h.digest('hex').slice(0, 24)}`;
}


export function recapExtractor(): ExtractProvider {
  return {
    name: 'recap',
    ignoresPromptContext: true,
    precheck: () => engineAvailability('recap'),

    async extract(req: ExtractRequest): Promise<ExtractResult> {
      if (req.segments.length === 0) {
        throw new PyaiError(400, 'empty_transcript', 'Recap needs at least one utterance.');
      }

      /** Whether the id was DERIVED (so a prior record may exist), not whether one was found. */
      const idIsDerived = !req.callId;
      const callId = req.callId ? `og-${req.callId}` : derivedCallId(req.segments);
      const path = `/recap/calls/${encodeURIComponent(callId)}`;

      let call: RecapCall | null = null;
      let units: string | null = null;
      /** Set only when a completed record was actually read back — the log must not overclaim. */
      let reusedExisting = false;

      /*
        Only for a DERIVED id, and only because a derived id means "this exact transcript again".
        Recap already holds that record, so reading it back costs nothing and bills nothing. For a
        real call the id is fresh by construction, and a speculative GET would just be a guaranteed
        404 on the request path.
      */
      if (idIsDerived) {
        try {
          const existing = await pyaiGet<unknown>(path);
          const parsed = RecapCallSchema.parse(existing.data);
          if (parsed.status === 'complete') {
            call = parsed;
            units = existing.units;
            reusedExisting = true;
          }
        } catch (err) {
          // A missing scope is worth failing on immediately — it is the one error where retrying as
          // a POST just produces the same 403 with less context about what to do about it.
          if (err instanceof PyaiError && (err.status === 401 || err.status === 403)) {
            // `remedy` as an OWN PROPERTY, not appended to the message. loop.ts reads `.remedy`
            // structurally and UploadCard renders it in its own panel; concatenating it into the
            // message left that panel empty and buried the fix inside the red error blob.
            throw Object.assign(new PyaiError(err.status, err.code, err.message), {
              remedy: RECAP_SCOPE_REMEDY,
            });
          }
          // 404 is the expected answer for a transcript never submitted before, and is the whole
          // reason this is in a try. Anything else is left to recur on the POST below, where it
          // surfaces with a clearer origin than "the speculative read failed".
        }
      }

      if (!call) {
        const utterances = req.segments.map((s) => ({
          speaker_role: s.speaker === 'rep' ? 'agent' : 'customer',
          text: s.text,
          offset_s: s.start_ms / 1000,
          duration_s: Math.max(0, (s.end_ms - s.start_ms) / 1000),
        }));
        const lastEnd = Math.max(...req.segments.map((s) => s.end_ms));

        let submitted;
        try {
          submitted = await pyaiPostJson<unknown>(path, {
            utterances,
            call_duration_s: lastEnd / 1000,
            ...(req.customerName ? { customer_name: req.customerName } : {}),
            ...(process.env.OPENGONG_RECAP_PACK_ID
              ? { pack_id: process.env.OPENGONG_RECAP_PACK_ID }
              : {}),
            // `call_direction` is deliberately not sent. This product does not record whether a call
            // was inbound or outbound, and guessing it would put a fact we do not have into the
            // input of the thing that writes the notes.
          });
        } catch (err) {
          if (err instanceof PyaiError && (err.status === 401 || err.status === 403)) {
            // `remedy` as an OWN PROPERTY, not appended to the message. loop.ts reads `.remedy`
            // structurally and UploadCard renders it in its own panel; concatenating it into the
            // message left that panel empty and buried the fix inside the red error blob.
            throw Object.assign(new PyaiError(err.status, err.code, err.message), {
              remedy: RECAP_SCOPE_REMEDY,
            });
          }
          throw err;
        }
        units = submitted.units;
        call = RecapCallSchema.parse(submitted.data);

        const deadline = Date.now() + POLL_TIMEOUT_MS;
        while (call.status === 'pending' || call.status === 'processing') {
          if (Date.now() > deadline) {
            throw new PyaiError(
              504,
              'recap_poll_timeout',
              `Recap did not finish within ${POLL_TIMEOUT_MS / 1000}s (last stage: ` +
                `${call.processing?.stage ?? 'unknown'}).`,
            );
          }
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          const polled = await pyaiGet<unknown>(path);
          call = RecapCallSchema.parse(polled.data);
          units = polled.units ?? units;
        }
      }

      if (call.status !== 'complete') {
        throw new PyaiError(
          502,
          `recap_${call.status}`,
          `Recap finished as "${call.status}"${call.error ? `: ${call.error}` : '.'}`,
        );
      }
      if (!call.record || typeof call.record !== 'object') {
        throw new PyaiError(
          502,
          'recap_no_record',
          'Recap reported complete but returned no `record` to read notes from.',
        );
      }

      const record = RecapRecordSchema.parse(call.record);
      const { draft, report } = toDraft(
        record,
        call.headline,
        req.segments,
        req.callTitle,
        req.customerName,
      );

      /*
        Say out loud how the citations were resolved, and what was left on the floor.

        These numbers are the difference between "Recap's notes are cited" and "Recap's notes are
        cited, and here is on what basis" — a run carried by `lexical` is a materially weaker claim
        than one carried by `quote`, and that distinction should not be discoverable only by reading
        this file. `unmapped` fires when PyAI adds a field we have never seen.
      */
      const methods = Object.entries(report.methods)
        .filter(([, n]) => n > 0)
        .map(([m, n]) => `${m}=${n}`)
        .join(' ');
      console.log(
        `[recap] ${callId} citations resolved by: ${methods || 'none'}` +
          (report.skipped.length ? ` · skipped: ${[...new Set(report.skipped)].join(', ')}` : '') +
          (reusedExisting ? ' · read back an existing Recap record, nothing re-billed' : ''),
      );
      if (report.unresolved.length) {
        // Louder than `skipped`: Recap said something and we could not place it. Either the grounder
        // failed or the pack's shape differs from what this file expects.
        console.warn(
          `[recap] ${report.unresolved.length} item(s) Recap produced could not be placed: ` +
            `${[...new Set(report.unresolved)].join(', ')}`,
        );
      }
      if (report.unmapped.length) {
        console.warn(
          `[recap] record contained fields this provider does not map: ` +
            `${report.unmapped.join(', ')}. Add them to lib/registry/providers/recap-extract.ts ` +
            'or to KNOWN_UNMAPPED_KEYS so the distinction stays deliberate.',
        );
      }

      /*
        Validated before returning, so a mapping bug fails HERE with a schema error naming the field,
        rather than downstream as a confusing gate result. The prompt-driven providers get this for
        free from structured outputs; this one assembles its draft by hand and has to check its work.
      */
      return {
        draft: ExtractionDraftSchema.parse(draft),
        /*
          No tokens, because no tokens were spent — Recap bills per call. Leaving the token fields
          unset rather than writing 0 keeps the usage counter honest: `units` carries whatever PyAI
          metered, and a Recap run legitimately shows no token spend rather than a fabricated one.
        */
        usage: units ? { units } : {},
      };
    },
  };
}

/**
 * Exported for `scripts/test-gate.ts`, which grounds a claim exactly as a run would and then asserts
 * the gate still rejects it. Testing against a reimplementation of the grounder would prove nothing.
 */
export const __groundingForTests = { ground, groundByQuote, groundByOffset, groundByText };
