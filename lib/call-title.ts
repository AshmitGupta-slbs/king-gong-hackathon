/**
 * Give a call a name that says what happened on it.
 *
 * An upload gets whatever the user typed in a hurry — "test" — and then sits in the call list
 * saying nothing, next to five bundled calls named "Cobalt Freight — pricing pushback". The title
 * is also load-bearing beyond display: `readableFor(call.title)` mines it for proper nouns to
 * capitalise the transcript, so a better title improves the transcript too.
 *
 * COMPOSED HERE, NOT ASKED OF THE MODEL. The harness already knows the company (it resolved one to
 * build the account context) and the gated draft already carries an intent label and typed key
 * moments. Deriving from those means:
 *   - it works identically whether a real model or the keyword stub produced the draft,
 *   - no draft-schema change, no prompt change, and no gate change — and the gate rebuilds its
 *     result field by field, so a new draft field would have been silently dropped anyway,
 *   - the title stays a fact about the analysis rather than another sentence a model wrote.
 *
 * The themes below are deliberately the same vocabulary the five sample titles use, so an uploaded
 * call and a bundled one read as the same kind of object.
 */
import type { ExtractionDraft, KeyMoment } from './types';

/** Enough of the draft to name a call. Works for a draft or a gated result. */
type Namable = {
  intent: { label: string };
  objections: readonly unknown[];
  key_moments: readonly Pick<KeyMoment, 'type'>[];
};

const countType = (moments: Namable['key_moments'], type: KeyMoment['type']) =>
  moments.filter((m) => m.type === type).length;

/**
 * The one-line description of what this call was.
 *
 * Order matters: the checks run from most specific to least, so a competitive evaluation is not
 * flattened into "evaluating" just because the intent label says so.
 */
export function themeFor(d: Namable): string {
  const label = d.intent.label.toLowerCase();
  const competitors = countType(d.key_moments, 'competitor_mention');
  const pricing = countType(d.key_moments, 'pricing');
  const objections = d.objections.length;

  if (label.includes('no decision')) return 'no decision, went quiet';

  /**
   * EVIDENCE OUTRANKS THE LABEL, and that ordering is load-bearing.
   *
   * The intent label can be one keyword away from wrong: the stub reads "i can approve it myself"
   * on a call that was entirely a pricing fight and labels it high interest. Flagged moments are
   * cited spans, so several pricing moments are a much stronger signal about what the call WAS than
   * a single-phrase classification. Measured: trusting the label first titled the pricing-pushback
   * recording "final call, closed won".
   */
  if (competitors > 0) return 'competitive evaluation';
  if (pricing >= 2 || label.includes('price')) return 'pricing pushback';

  /**
   * Closing still outranks the objection count — a deal being signed usually has objections on the
   * call, and scoring those first labelled a closed-won call "discovery, heavy objections". The
   * label vocabulary is open (the stub emits four, a model writes its own), so match on meaning.
   */
  if (/sign|commit|closed|won|high interest|ready/.test(label)) return 'final call, closed won';
  if (objections >= 2) return 'discovery, heavy objections';
  if (objections === 1) return 'discovery';
  return 'call review';
}

/**
 * `{Subject} — {theme}`, or just the theme when nothing can honestly name the subject.
 *
 * Never invents a company. With no account linked and no repeated proper noun in the transcript,
 * the title is the theme alone — "Pricing pushback" — which is derived entirely from what the call
 * contained and is still far more use in a list than "test".
 */
export function deriveCallTitle(input: {
  draft: Namable;
  /** The account this call is linked to, when there is one. The best possible subject. */
  companyName?: string | null;
  /** Fallback subject: a proper noun the transcript itself supplies. */
  transcriptSubject?: string | null;
}): string {
  const theme = themeFor(input.draft);
  const subject = input.companyName?.trim() || input.transcriptSubject?.trim();
  if (subject) return `${subject} — ${theme}`;
  return theme.charAt(0).toUpperCase() + theme.slice(1);
}

/**
 * Last-resort subject when no company is linked: a capitalised multi-word name the speakers used.
 *
 * Deliberately conservative. It only accepts a run of Capitalised Words that the transcript
 * repeats, because speech-to-text output here is lowercase and unpunctuated — anything that
 * survives that is either a provider-capitalised entity or nothing. If it finds nothing, the caller
 * keeps the user's title, which is the correct outcome rather than a guess.
 */
export function subjectFromTranscript(segments: { text: string }[]): string | null {
  const counts = new Map<string, number>();
  for (const s of segments) {
    for (const m of s.text.matchAll(/\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){1,2})\b/g)) {
      const name = m[1];
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestN = 1; // must appear at least twice to count as the subject
  for (const [name, n] of counts) {
    if (n > bestN) {
      best = name;
      bestN = n;
    }
  }
  return best;
}

export type { ExtractionDraft };
