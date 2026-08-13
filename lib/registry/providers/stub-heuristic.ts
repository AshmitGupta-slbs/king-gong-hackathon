/**
 * Extraction provider: DETERMINISTIC KEYWORD STUB. Not a model. Not shippable.
 *
 * Why it exists: extraction is the one step that needs a Claude credential, and there wasn't one
 * on this machine. Rather than block the UI, routes, export and harness verification behind a
 * credential, this provider derives claims FROM the transcript with keyword rules. Because every
 * claim is built out of a real segment, its citations always resolve — so the gate runs for real,
 * the loop runs for real, and the UI gets realistically-shaped data at zero cost.
 *
 * It is also a live demonstration that the capability registry earns its keep: swapping the
 * extraction engine is one line of config, and nothing outside this directory changed.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *  THIS MUST NEVER BE WHAT WE DEMO.
 *
 *  The entire argument of this product is that a claim you cannot trace to the call is worthless.
 *  Presenting keyword output as though a model reasoned about the call would be exactly the
 *  dishonesty we are pointing at Gong about. So provenance is enforced, not remembered:
 *    • `isRealModel(provider)` below is what the UI banner and the ship check both read.
 *    • `npm run check:ship` FAILS while any shipped extraction was stub-produced.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
import type { Claim, ExtractionDraft, KeyMoment, TranscriptSegment } from '@/lib/types';
import { COMPETITORS } from '@/lib/competitors';
import type { ExtractProvider, ExtractRequest, ExtractResult } from '../types';

/** The single source of truth for "did a real model produce this?". Read by UI and check:ship. */
export const REAL_MODEL_PROVIDERS = ['claude', 'bedrock'] as const;
export const isRealModel = (provider: string) =>
  (REAL_MODEL_PROVIDERS as readonly string[]).includes(provider);

const OBJECTION_CUES = [
  'problem', 'expensive', 'justify', 'hard to', 'concern', 'sceptical', 'skeptical', 'blocker',
  'terrible', 'worried', 'not the priority', 'do not have', 'does not have', 'cannot', 'slow',
  'says no', 'stretched', 'surveilled', 'worse', 'bothers me', 'more than we spend',
];
const PRICING_CUES = ['price', 'pricing', 'seat', 'budget', 'cost', 'figure', 'committee', 'cfo', 'procurement', 'spend'];
const NEXT_STEP_CUES = [
  'send', 'forward', 'follow up', "i'll", 'i will', 'check back', 'review', 'signature', 'sign',
  'copy', 'get it through', 'take it to', 'put in front of', 'let me', 'come in under',
];
const NO_DECISION_CUES = ['not the priority', 'paused', 'do not know', 'no one championing', 'check back with me', 'not much has moved'];
const COMMIT_CUES = ['signed off', 'signature', 'approve it myself', 'budget line', 'that works', 'send the paper'];

const has = (text: string, cues: readonly string[]) => cues.some((c) => text.includes(c));

/** First N content words of a segment, so a claim reads like prose rather than a keyword dump. */
function gist(text: string, words = 16): string {
  const w = text.split(/\s+/).filter(Boolean);
  const slice = w.slice(0, words).join(' ');
  const s = slice.charAt(0).toUpperCase() + slice.slice(1);
  return w.length > words ? `${s}…` : s;
}

export function stubHeuristicExtractor(): ExtractProvider {
  return {
    name: 'stub-heuristic',

    async extract(req: ExtractRequest): Promise<ExtractResult> {
      const segs = req.segments;
      const prospect = segs.filter((s) => s.speaker !== 'rep');
      const rep = segs.filter((s) => s.speaker === 'rep');

      const objections: Claim[] = prospect
        .filter((s) => has(s.text, OBJECTION_CUES))
        .slice(0, 4)
        .map((s) => ({
          claim: `Prospect raised a concern: ${gist(s.text)}`,
          segment_ids: [s.id],
        }));

      const next_steps: Claim[] = [...prospect, ...rep]
        .filter((s) => has(s.text, NEXT_STEP_CUES))
        .sort((a, b) => b.start_ms - a.start_ms) // commitments live at the end of a call
        .slice(0, 3)
        .map((s) => ({
          claim: `Agreed action: ${gist(s.text)}`,
          segment_ids: [s.id],
        }));

      // Cap per type. Without this, a pricing-heavy call produced six identical "Pricing came up
      // here" rows — technically correct, useless to read, and it made the panel look broken.
      const PER_TYPE_CAP: Record<KeyMoment['type'], number> = {
        competitor_mention: 2,
        pricing: 2,
        objection: 2,
        next_step: 1,
      };
      const key_moments: KeyMoment[] = [];
      const seen = new Set<string>();
      const perType = new Map<KeyMoment['type'], number>();
      const addMoment = (s: TranscriptSegment, type: KeyMoment['type'], note: string) => {
        if (seen.has(s.id)) return;
        const n = perType.get(type) ?? 0;
        if (n >= PER_TYPE_CAP[type]) return;
        seen.add(s.id);
        perType.set(type, n + 1);
        key_moments.push({ type, segment_id: s.id, note });
      };
      for (const s of segs) {
        if (has(s.text, COMPETITORS)) {
          const named = COMPETITORS.filter((c) => s.text.includes(c));
          addMoment(s, 'competitor_mention', `Named: ${named.join(', ')}`);
        } else if (has(s.text, PRICING_CUES) && s.speaker !== 'rep') {
          addMoment(s, 'pricing', gist(s.text, 10));
        } else if (has(s.text, OBJECTION_CUES) && s.speaker !== 'rep') {
          addMoment(s, 'objection', gist(s.text, 10));
        } else if (has(s.text, NEXT_STEP_CUES) && s.start_ms > segs[Math.floor(segs.length * 0.6)].start_ms) {
          addMoment(s, 'next_step', gist(s.text, 10));
        }
      }

      const allText = segs.map((s) => s.text).join(' ');
      const pricingSeg = prospect.find((s) => has(s.text, PRICING_CUES)) ?? prospect[0] ?? segs[0];
      const noDecisionSeg = prospect.find((s) => has(s.text, NO_DECISION_CUES));
      const commitSeg = prospect.find((s) => has(s.text, COMMIT_CUES));

      const intentSeg = noDecisionSeg ?? commitSeg ?? pricingSeg;
      const label = noDecisionSeg
        ? 'no decision'
        : commitSeg
          ? 'high interest'
          : has(allText, PRICING_CUES)
            ? 'price-sensitive'
            : 'evaluating';

      const lastProspect = prospect[prospect.length - 1] ?? segs[segs.length - 1];

      const draft: ExtractionDraft = {
        summary:
          `[Heuristic stub — no model was involved] ${segs.length}-segment call. ` +
          `${objections.length} concern(s) detected by keyword, ${next_steps.length} action(s), ` +
          `${key_moments.length} flagged moment(s). Intent classified as "${label}". ` +
          `Replace by running extraction against a real model before showing this to anyone.`,
        intent: { label, segment_ids: [intentSeg.id] },
        objections,
        next_steps,
        follow_up_email: {
          subject: `Following up on our call`,
          body:
            `Thanks for the time today. Picking up on what you raised, I will follow up on the ` +
            `points we agreed and come back to you with the detail.`,
          segment_ids: [lastProspect.id],
        },
        key_moments: key_moments.slice(0, 6),
      };

      return { draft, usage: {} }; // no tokens, no minutes — reporting any would corrupt the counter
    },
  };
}
