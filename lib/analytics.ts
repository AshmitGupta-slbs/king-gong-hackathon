/**
 * Call analytics — measured from the transcript, not asserted by a model.
 *
 * Everything here is arithmetic over `segments`: who spoke for how long, the longest uninterrupted
 * stretch, how many questions were asked, which competitors came up. No model is involved, so these
 * numbers cannot be wrong in the way a generated claim can be wrong — they can only be wrong if the
 * transcript is.
 *
 * That matters on the call page, where these sit next to fabricated CRM records. Anything derived
 * from the real recording is labelled as measured; anything from the CRM is labelled as demo data.
 *
 * The one honest caveat is `questions`: PyAI Hear returns lowercase, unpunctuated text, so there is
 * no '?' to count. It is detected from interrogative openers, which is a heuristic, and the UI says
 * so rather than presenting it as exact.
 */
import { COMPETITORS } from './competitors';
import type { TranscriptSegment } from './types';

/** Openers that begin a question in spoken sales English. Order matters only for readability. */
const QUESTION_OPENERS = [
  'what', 'how', 'why', 'when', 'where', 'who', 'which',
  'do you', 'did you', 'are you', 'is there', 'is that', 'can you', 'could you',
  'would you', 'have you', 'has that', 'was that', 'tell me', 'help me understand',
];

export type SpeakerShare = {
  speaker: string;
  ms: number;
  /** 0–100, rounded to one decimal. */
  pct: number;
};

export type CallAnalytics = {
  totalSpokenMs: number;
  shares: SpeakerShare[];
  longestMonologue: { speaker: string; ms: number } | null;
  questions: number;
  competitors: { name: string; mentions: number; segment_ids: string[] }[];
};

export function analyseCall(segments: TranscriptSegment[]): CallAnalytics {
  const bySpeaker = new Map<string, number>();
  let totalSpokenMs = 0;
  let longest: { speaker: string; ms: number } | null = null;
  let questions = 0;

  // Competitor tallies keyed by name, so "gong" mentioned in three segments counts three times
  // but reports the segments it came from — the UI can then link straight to them.
  const competitorHits = new Map<string, { mentions: number; segment_ids: string[] }>();

  for (const s of segments) {
    // Guard against a provider returning end before start; a negative duration would silently
    // deflate the ratio rather than showing up as an obviously wrong number.
    const dur = Math.max(0, s.end_ms - s.start_ms);
    totalSpokenMs += dur;
    bySpeaker.set(s.speaker, (bySpeaker.get(s.speaker) ?? 0) + dur);

    if (!longest || dur > longest.ms) longest = { speaker: s.speaker, ms: dur };

    const text = s.text.toLowerCase();
    if (QUESTION_OPENERS.some((q) => text.startsWith(q) || text.includes(` ${q} `))) questions++;

    for (const name of COMPETITORS) {
      if (!text.includes(name)) continue;
      const hit = competitorHits.get(name) ?? { mentions: 0, segment_ids: [] };
      hit.mentions++;
      hit.segment_ids.push(s.id);
      competitorHits.set(name, hit);
    }
  }

  const shares: SpeakerShare[] = [...bySpeaker.entries()]
    .map(([speaker, ms]) => ({
      speaker,
      ms,
      pct: totalSpokenMs > 0 ? Math.round((ms / totalSpokenMs) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.ms - a.ms);

  const competitors = [...competitorHits.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.mentions - a.mentions);

  return { totalSpokenMs, shares, longestMonologue: longest, questions, competitors };
}
