/**
 * Readability pass — casing and terminal punctuation only, and provably meaning-preserving.
 *
 * PyAI's Hear returns `hi sarah thanks for making the time today i know you've been evaluating`.
 * Verbatim is right for the citation gate, but it reads like a machine dump, and how the transcript
 * reads is most of what a stranger judges this product on.
 *
 * The tempting fix is to ask a model to restore punctuation. We deliberately do not, because a
 * model rewriting evidence is exactly the failure this product exists to prevent — it could quietly
 * change what a citation asserts. Instead this pass is **deterministic and word-preserving**: it
 * changes letter case and may append one terminal full stop. It never inserts, removes, reorders or
 * respells a word.
 *
 * That property is enforced, not asserted: every result is checked against the input with
 * `sameWords()` and the original is returned on any mismatch. So the worst case is ugly, never wrong.
 *
 * `segment.text` remains the canonical value — this runs at the presentation boundary (UI and
 * Markdown export). JSON export stays verbatim.
 */

/** Lowercase, strip everything that is not a letter or digit, collapse whitespace. */
export function normalizeWords(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The guard: two strings contain the same words in the same order, ignoring case and punctuation. */
export const sameWords = (a: string, b: string) => normalizeWords(a) === normalizeWords(b);

/** Business acronyms that read badly in lowercase. Uppercased only as whole words. */
const ACRONYMS = new Set([
  'cfo', 'ceo', 'cto', 'coo', 'cro', 'vp', 'crm', 'api', 'apis', 'sdk', 'sdks', 'roi', 'poc',
  'nda', 'sla', 'kpi', 'kpis', 'hr', 'qa', 'saas', 'b2b', 'gdpr', 'hipaa', 'sso', 'ui', 'ux',
  'mrr', 'arr', 'sql', 'csv', 'pdf', 'aws', 'eu', 'us', 'uk',
]);

/** Domain proper nouns: competitors and calendar words. Capitalised as whole words. */
const PROPER_NOUNS = [
  'gong', 'chorus', 'fireflies', 'avoma', 'outreach', 'salesloft', 'granola', 'otter',
  'salesforce', 'hubspot', 'slack', 'zoom', 'teams', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'may',
  'june', 'july', 'august', 'september', 'october', 'november', 'december',
];

const CONTRACTED_I = new Set(['im', 'ill', 'ive', 'id']);

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/**
 * Proper-noun candidates taken from the call title, which is human-authored metadata rather than
 * model output — so "cobalt freight" in a transcript becomes "Cobalt Freight" on a call titled
 * "Cobalt Freight — pricing pushback". Short and generic words are skipped.
 */
export function properNounsFromTitle(title: string): string[] {
  const STOP = new Set(['the', 'and', 'for', 'with', 'call', 'discovery', 'final', 'pushback', 'evaluation', 'decision', 'competitive', 'heavy', 'clean', 'close', 'no', 'went', 'quiet', 'objections', 'pricing']);
  return title
    .split(/[^A-Za-z]+/)
    .filter((w) => w.length > 2 && !STOP.has(w.toLowerCase()))
    .map((w) => w.toLowerCase());
}

/**
 * Apply casing and a terminal full stop. Returns the input unchanged if the guard trips.
 *
 * @param extraProperNouns lowercase words to capitalise (e.g. from the call title)
 */
export function readable(text: string, extraProperNouns: string[] = []): string {
  const raw = text.trim();
  if (!raw) return text;

  const proper = new Set([...PROPER_NOUNS, ...extraProperNouns.map((w) => w.toLowerCase())]);

  // Split on whitespace, keeping words intact so we can only ever change their case.
  let out = raw
    .split(/(\s+)/)
    .map((tok) => {
      if (/^\s+$/.test(tok)) return tok;
      const bare = tok.replace(/[^A-Za-z']/g, '');
      const key = bare.toLowerCase().replace(/'/g, '');
      if (!bare) return tok;

      if (key === 'i' || CONTRACTED_I.has(key)) {
        // i -> I, i'm -> I'm. Only the leading letter changes.
        return tok.replace(/i/i, 'I');
      }
      if (ACRONYMS.has(key)) return tok.replace(bare, bare.toUpperCase());
      if (proper.has(key)) return tok.replace(bare, cap(bare));
      return tok;
    })
    .join('');

  // Capitalise the first letter of the segment. Match the first ALPHABETIC character, not the
  // first lowercase one — otherwise a string already starting with a capital ("I'll", "This")
  // gets its second letter uppercased instead ("I'Ll", "THis").
  out = out.replace(/[a-zA-Z]/, (m) => m.toUpperCase());

  // One terminal full stop, if the line does not already end in punctuation.
  if (!/[.!?…]$/.test(out)) out += '.';

  // THE GUARD. Case and a trailing stop are the only permitted changes; anything else is a bug,
  // and a bug here would mean altering evidence. Fall back to verbatim.
  return sameWords(out, raw) ? out : text;
}

// ─────────────────────────────────────────────────────────────────────────────
// SPOKEN DIGIT RUNS — the one case where changing words is the correct call
//
// Hear's digit rendering is unreliable and NOT controllable from the request. `pricing-pushback`
// comes back containing "the number is one four oh oh a seat" and "under five oh oh oh", while the
// product's entire pitch is that Gong costs $1,400 a seat — so this is not a cosmetic nit, it reads
// as a broken product.
//
// DO NOT try to fix this by setting `numerals: true` and regenerating the samples. That has been
// tested directly: the flag changes nothing on these files. Toggling it across WAV 16k, WAV 22k and
// AIFC 22k left the output identical each time, and re-running the committed pricing-pushback bytes
// with the flag on reproduces "one four oh oh" exactly as committed. Meanwhile a short clean mono
// clip of the same sentence returns "1400" with no flag at all.
//
// So it is deterministic per file, and the flag is simply not the variable — something about length,
// mono vs stereo, `channel:true`, or surrounding context is, and which one is UNTESTED. That is
// precisely why this is fixed here, deterministically, at the display boundary: we cannot ask the
// API for the rendering we want, so we normalise what it gives us and prove we did not change the
// meaning. See docs/api-truth.md for the full matrix.
//
// `readable()` above cannot fix this: it is word-preserving by design and its `sameWords` guard
// would reject the change. Rather than weaken that guard, this is a SEPARATE pass with its own,
// stronger guard: the conversion must round-trip. Digits are expanded back to canonical digit
// words and compared to the input; anything that does not survive that is left verbatim.
//
// Deliberately conservative: only runs of MIN_DIGIT_RUN or more consecutive digit words collapse.
// "forty seats" and "the two sales pods" are ordinary English and are left alone — converting them
// to "40 seats" and "the 2 sales pods" would make the transcript worse, not better. A run of two
// ("one two") is ambiguous with counting, so the threshold is three: enough for "one four oh oh"
// (4) and "five oh oh oh" (4), and for phone numbers, while never firing on a stutter.
// ─────────────────────────────────────────────────────────────────────────────

const DIGIT_WORD: Record<string, string> = {
  zero: '0', oh: '0', o: '0', nought: '0',
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9',
};

/** Canonical spelling per digit, for the round-trip check. `oh`/`o`/`nought` all fold to `zero`. */
const CANONICAL_DIGIT_WORD = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/**
 * Four, not three — and the run must contain at least one UNAMBIGUOUS digit word.
 *
 * Both guards exist because of measured false positives on plausible speech:
 *   "oh oh oh that is a problem"    -> "000 that is a problem"    ← `oh` is an interjection
 *   "we counted one two three items" -> "we counted 123 items"    ← counting, not a figure
 *
 * The first is the dangerous one: it puts characters on screen that nobody said, in a product whose
 * entire claim is that displayed evidence is faithful. So a run made only of ambiguous words
 * (`oh`/`o`) never converts, and the threshold is four rather than three.
 *
 * Both real cases in the samples are four-word runs — "one four oh oh", "five oh oh oh" — so
 * nothing is lost on actual data. Where the two error directions trade off, prefer the false
 * negative: an unconverted "one four oh oh" is ugly and honest, a wrong "000" is neither.
 */
const MIN_DIGIT_RUN = 4;

/** `oh`, `o` and friends are only digits in context; these are digits in any context. */
const UNAMBIGUOUS_DIGIT_WORDS = new Set([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
]);

const DIGIT_RUN = new RegExp(
  `\\b((?:${Object.keys(DIGIT_WORD).join('|')})(?:\\s+(?:${Object.keys(DIGIT_WORD).join('|')})){${MIN_DIGIT_RUN - 1},})\\b`,
  'gi',
);

/**
 * Expand every digit character to its canonical digit word, and fold digit-word synonyms onto it.
 * Two strings that normalise the same say the same number, whichever way the number is written.
 */
function normalizeSpokenNumbers(s: string): string {
  return normalizeWords(s)
    .split(' ')
    .flatMap((w) => {
      if (/^\d+$/.test(w)) return w.split('').map((d) => CANONICAL_DIGIT_WORD[Number(d)]);
      const d = DIGIT_WORD[w];
      return [d !== undefined ? CANONICAL_DIGIT_WORD[Number(d)] : w];
    })
    .join(' ');
}

/** The guard for this pass: two strings say the same words AND the same numbers. */
export const sameSpokenNumbers = (a: string, b: string) =>
  normalizeSpokenNumbers(a) === normalizeSpokenNumbers(b);

/**
 * THE decision, in one place: the digits this run collapses to, or null to leave it verbatim.
 *
 * Both the plain rendering and the span-marking rendering below go through this, so there is one
 * definition of the rule rather than two that can drift.
 */
function runDigits(run: string): string | null {
  const words = run.trim().split(/\s+/);

  // A run of nothing but `oh`/`o` is speech, not a figure. Require a real digit to anchor it.
  if (!words.some((w) => UNAMBIGUOUS_DIGIT_WORDS.has(w.toLowerCase()))) return null;

  const digits = words.map((w) => DIGIT_WORD[w.toLowerCase()]).join('');

  // Every word must map to exactly one digit; anything else and we leave it alone. (The
  // canonical-word round trip is guaranteed by construction here, so `sameSpokenNumbers` in
  // readableFor() is what actually catches a regression in this function.)
  return digits.length === words.length ? digits : null;
}

/**
 * Collapse runs of spoken digits into the number they spell. "one four oh oh" -> "1400".
 * Each run must round-trip back to the same canonical digit words or it is left untouched.
 */
export function spokenDigitsToNumber(text: string): string {
  return text.replace(DIGIT_RUN, (run) => runDigits(run) ?? run);
}

/**
 * Convenience for a whole transcript, threading the title's proper nouns through.
 *
 * This is the presentation boundary the UI and the Markdown export both go through, and it is
 * where the digit pass is composed in — `readable()` itself stays strictly word-preserving so its
 * contract (and `npm run test:readability`) is unchanged. If the composed result does not say the
 * same thing as the input, fall back to casing alone.
 */
export function readableFor(title: string) {
  const nouns = properNounsFromTitle(title);
  return (text: string) => {
    const withDigits = spokenDigitsToNumber(text);
    if (withDigits !== text && !sameSpokenNumbers(withDigits, text)) return readable(text, nouns);
    return readable(withDigits, nouns);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SHOWING THE SEAM
//
// The digit pass is the only place the screen shows characters nobody said out loud: the call
// contains the words "one four oh oh" and the transcript line reads "1400". That is a better
// reading experience and it is still, strictly, a difference between the display and the evidence —
// in a product whose whole claim is that what you see is faithful to the recording. So the UI marks
// those spans and says what was actually spoken, rather than leaving the reader to assume the ASR
// returned digits.
//
// Why NUL is a safe marker — corrected, because the earlier note here named the wrong reason and
// would have misdirected the next person to touch `normalizeWords`:
//
//   NOT because `normalizeWords` strips it. That is true but irrelevant, and verified so: patching
//   `normalizeWords` to PRESERVE control characters leaves `renderedSpansFor` output byte-identical.
//   No guard here ever compares a marked string against an unmarked one, so the marker cancels:
//     - `readable()`'s `sameWords(out, raw)` sees the marker on BOTH sides (its own input is
//       already marked), so it is symmetric whatever `normalizeWords` does with it.
//     - `readableFor()`'s `sameSpokenNumbers` never sees a marked string at all.
//     - the guard below is exact string equality, which does not go through `normalizeWords`.
//
//   The two properties that ARE load-bearing:
//     1. NUL cannot occur in provider text. Span roles are assigned by odd/even position between
//        marker pairs, so a marker arriving in the source text would silently shift every role.
//        Asserted over the committed corpus in `npm run test:readability`.
//     2. `readable()` must not move or duplicate the marker. It splits on whitespace and only
//        ever changes letter case, so a marker glued to a digit token is carried through intact.
//
// So: change `normalizeWords` freely. Do not pick a marker that could appear in a transcript.
// ─────────────────────────────────────────────────────────────────────────────

const MARK = '\u0000';

/** One piece of a rendered line. `spoken` is set only on digit-normalised spans. */
export type RenderedSpan = { text: string; normalized: boolean; spoken?: string };

/**
 * The same rendering as `readableFor(title)`, split into spans that say which parts the digit pass
 * rewrote and what those words were in the recording.
 *
 * Guarded like everything else here: the spans are only used if re-joining them reproduces the
 * normal render **exactly**. If anything about the marking goes wrong, the reader gets the correct
 * text with no marks — never marked-up text that differs from what the rest of the app shows.
 */
export function renderedSpansFor(title: string) {
  const nouns = properNounsFromTitle(title);
  const plain = readableFor(title);

  return (text: string): RenderedSpan[] => {
    const expected = plain(text);

    // Collect the spoken words per conversion, in order, while marking their positions.
    const spokenRuns: string[] = [];
    const marked = text.replace(DIGIT_RUN, (run) => {
      const digits = runDigits(run);
      if (!digits) return run;
      spokenRuns.push(run.trim());
      return MARK + digits + MARK;
    });

    if (spokenRuns.length === 0) return [{ text: expected, normalized: false }];

    const parts = readable(marked, nouns).split(MARK);
    let seen = 0;
    const spans: RenderedSpan[] = [];
    for (const [i, part] of parts.entries()) {
      if (part === '') continue;
      const normalized = i % 2 === 1; // odd pieces sit between a mark pair
      spans.push(normalized ? { text: part, normalized, spoken: spokenRuns[seen++] } : { text: part, normalized });
    }

    // THE GUARD. Marking must be presentation-only.
    const joined = spans.map((s) => s.text).join('');
    if (joined !== expected || seen !== spokenRuns.length) {
      return [{ text: expected, normalized: false }];
    }
    return spans;
  };
}
