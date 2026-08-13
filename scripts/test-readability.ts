/**
 * Readability verification.
 *
 * The only property that really matters: the pass NEVER changes the words. Everything else is
 * cosmetics. If this suite is green, no citation can be altered by the readability layer.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  normalizeWords,
  properNounsFromTitle,
  readable,
  readableFor,
  renderedSpansFor,
  sameSpokenNumbers,
  sameWords,
  spokenDigitsToNumber,
} from '@/lib/readability';

let failures = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? '  \x1b[32mPASS\x1b[0m' : '  \x1b[31mFAIL\x1b[0m'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};
const head = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);

head('Casing and terminal punctuation');
{
  const r = readable('hi sarah thanks for making the time today i know you have been evaluating');
  check('capitalises the first word', r.startsWith('Hi '), r);
  check('standalone "i" becomes "I"', / I /.test(r), r);
  check('adds a terminal full stop', r.endsWith('.'), r);

  const c = readable("i'll send that over and i'm happy to help");
  check('contractions: i\'ll / i\'m capitalise', c.startsWith("I'll") && /I'm/.test(c), c);

  const a = readable('our cfo and the vp will review the roi in the crm');
  check('acronyms uppercase', /CFO/.test(a) && /VP/.test(a) && /ROI/.test(a) && /CRM/.test(a), a);

  const p = readable('we are down to three you gong and chorus we looked at fireflies');
  check('competitor names capitalise', /Gong/.test(p) && /Chorus/.test(p) && /Fireflies/.test(p), p);

  const d = readable('send that over before the finance review on thursday');
  check('weekday capitalises', /Thursday/.test(d), d);

  const already = readable('This already ends properly.');
  check('does not double up terminal punctuation', already === 'This already ends properly.', already);

  const q = readable('how many seats were you modelling?');
  check('leaves an existing question mark alone', q.endsWith('?'), q);
}

head('Title-derived proper nouns');
{
  const nouns = properNounsFromTitle('Cobalt Freight — pricing pushback');
  check('extracts the company, drops generic words', nouns.includes('cobalt') && nouns.includes('freight') && !nouns.includes('pricing'), nouns.join(','));
  const r = readable('the cobalt freight account is up for renewal', nouns);
  check('capitalises the company from the title', /Cobalt Freight/.test(r), r);
}

head('THE GUARD — words are never altered');
{
  const cases = [
    'hi sarah thanks for making the time today',
    "the product is not the issue the number is one four oh oh a seat",
    'our cfo has been very clear this year that anything new has to displace something existing',
    'we are down to three you gong and chorus',
    '',
    '   ',
    'single',
    "don't stop believing",
    'numbers 123 and 456 stay put',
  ];
  let allSame = true;
  for (const t of cases) {
    const r = readable(t, ['cobalt', 'freight']);
    if (!sameWords(r, t)) {
      allSame = false;
      console.log(`    \x1b[31mALTERED\x1b[0m "${t}" -> "${r}"`);
    }
  }
  check('every sample preserves its words exactly', allSame);

  // A property check over the real committed transcripts: nothing may change but case.
  const dir = join(process.cwd(), 'samples');
  let segs = 0;
  let altered = 0;
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.stt.json'))) {
      const { segments } = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
        segments: { text: string }[];
      };
      for (const s of segments) {
        segs++;
        if (!sameWords(readable(s.text, ['cobalt', 'freight', 'halcyon', 'northwind']), s.text)) altered++;
      }
    }
  }
  check(
    `all ${segs} real transcript segments survive unaltered`,
    segs > 0 && altered === 0,
    altered ? `${altered} altered` : 'word-for-word identical',
  );

  check('normalizeWords strips case and punctuation', normalizeWords('Hi, Sarah!') === 'hi sarah');
  check('sameWords sees through case and punctuation', sameWords('Hi, Sarah!', 'hi sarah'));
  check('sameWords rejects a genuine word change', !sameWords('hi sarah', 'hi sarah jones'));
}

head('Spoken digit runs — the one pass allowed to change words');
{
  // Real cases from the committed samples.
  check('"one four oh oh" becomes 1400',
    spokenDigitsToNumber('the number is one four oh oh a seat').includes('1400'),
    spokenDigitsToNumber('the number is one four oh oh a seat'));
  check('"five oh oh oh" becomes 5000',
    spokenDigitsToNumber('comes in under five oh oh oh i can approve it').includes('5000'));

  // The false positives that made the original threshold unsafe.
  const interjection = 'oh oh oh that is a problem';
  check('a run of bare interjections does NOT convert', spokenDigitsToNumber(interjection) === interjection,
    spokenDigitsToNumber(interjection));
  const counting = 'we counted one two three items';
  check('a three-word counting run does NOT convert', spokenDigitsToNumber(counting) === counting,
    spokenDigitsToNumber(counting));

  // Ordinary English numbers must be left alone entirely.
  for (const s of ['forty seats to start', 'the two sales pods', 'oh no not one of those', 'oh i see']) {
    check(`left alone: "${s}"`, spokenDigitsToNumber(s) === s, spokenDigitsToNumber(s));
  }

  check('the digit guard sees through spelling',
    sameSpokenNumbers('one four oh oh', '1400') && sameSpokenNumbers('five oh oh oh', '5000'));
  check('the digit guard still rejects a genuinely different number',
    !sameSpokenNumbers('one four oh oh', '1500'));

  // And the composed presentation boundary must apply both passes.
  const composed = readableFor('Cobalt Freight — pricing pushback')(
    'the number is one four oh oh a seat is more than we spend',
  );
  check('readableFor composes casing + digits', composed.startsWith('The') && composed.includes('1400'), composed);
}

head('Spoken digits — boundary cases and the whole-corpus invariant');
{
  // A run has to be four long AND anchored by a real digit. These probe both edges.
  check('a phone number collapses', spokenDigitsToNumber('call me on five five five one two three four')
    .includes('5551234'));
  check('a four-run with one ambiguous word collapses',
    spokenDigitsToNumber('the code is one oh one four').includes('1014'));
  check('case is irrelevant', spokenDigitsToNumber('ONE FOUR OH OH').includes('1400'));
  check('"one on one" is not a run — "on" breaks it',
    spokenDigitsToNumber('it was a one on one with the cfo').includes('one on one'));
  check('an ambiguous-only run never converts, however long',
    spokenDigitsToNumber('oh o oh o oh') === 'oh o oh o oh');

  check('the digit guard rejects a real word change',
    !sameSpokenNumbers('one four oh oh a seat', '1400 a licence'));
  check('the digit guard sees through case and punctuation',
    sameSpokenNumbers('One Four Oh Oh, a seat!', 'one four oh oh a seat'));

  // Every conversion must round-trip, on converting and non-converting input alike.
  const roundTrip = [
    'one four oh oh', 'five oh oh oh', 'nine nine nine nine', 'one oh one four',
    'five five five one two three four', 'forty seats', 'one two', 'nothing numeric here',
    'oh oh oh oh oh oh oh oh', 'zero zero zero zero', 'we counted one two three items',
    'oh oh oh oh that is a problem', 'it was a one on one with the cfo',
  ];
  check(`every conversion round-trips (${roundTrip.length} inputs)`,
    roundTrip.every((s) => sameSpokenNumbers(spokenDigitsToNumber(s), s)));

  // THE INVARIANT that matters: across every committed segment, the line the UI renders must say
  // the same words AND the same numbers as the verbatim text the citation gate reads. The suite
  // above proves casing preserves words; this proves the composed display preserves meaning.
  const samplesDir = join(process.cwd(), 'samples');
  let segments = 0;
  let converted = 0;
  let broke = 0;
  const examples: string[] = [];
  for (const f of readdirSync(samplesDir).filter((x) => x.endsWith('.stt.json'))) {
    const parsed = JSON.parse(readFileSync(join(samplesDir, f), 'utf8')) as {
      segments: { text: string }[];
    };
    const display = readableFor(f.replace('.stt.json', ''));
    for (const s of parsed.segments) {
      segments++;
      if (spokenDigitsToNumber(s.text) !== s.text) converted++;
      if (!sameSpokenNumbers(display(s.text), s.text)) {
        broke++;
        if (examples.length < 3) examples.push(`${f}: ${s.text.slice(0, 50)}`);
      }
    }
  }
  check(`every rendered segment says the same thing as its verbatim text (${segments} segments)`,
    broke === 0, examples.join(' | '));
  check('and the digit pass actually fires on real sample data', converted > 0,
    `${converted} of ${segments} segments`);
}

head('Marked spans — the UI must show the seam, and never change the text to do it');
{
  const spansFor = renderedSpansFor('Cobalt Freight — pricing pushback');

  const line = 'the number is one four oh oh a seat is more than we spend';
  const spans = spansFor(line);
  const marked = spans.filter((s) => s.normalized);
  check('a converted run is marked exactly once', marked.length === 1, JSON.stringify(marked));
  check('the marked span holds the digits', marked[0]?.text === '1400', marked[0]?.text);
  check('the marked span reports what was spoken', marked[0]?.spoken === 'one four oh oh',
    marked[0]?.spoken);

  const plain = 'hi sarah thanks for making the time today';
  check('an unconverted line is one unmarked span',
    spansFor(plain).length === 1 && !spansFor(plain)[0].normalized);

  // A run that must NOT convert must also not be marked — marking is not a second chance to convert.
  const interjection = spansFor('oh oh oh oh that is a problem');
  check('a rejected run is never marked', interjection.every((s) => !s.normalized),
    JSON.stringify(interjection));

  // THE GUARD, over every real segment: the spans a reader sees must re-join to exactly the string
  // the rest of the app renders. Marking is presentation; it may not alter a single character.
  let segs = 0;
  let drift = 0;
  let convertedSegs = 0;
  let spokenMissing = 0;
  for (const f of readdirSync(join(process.cwd(), 'samples')).filter((x) => x.endsWith('.stt.json'))) {
    const parsed = JSON.parse(readFileSync(join(process.cwd(), 'samples', f), 'utf8')) as {
      segments: { text: string }[];
    };
    const title = f.replace('.stt.json', '');
    const toSpans = renderedSpansFor(title);
    const toText = readableFor(title);
    for (const s of parsed.segments) {
      segs++;
      const parts = toSpans(s.text);
      if (parts.map((p) => p.text).join('') !== toText(s.text)) drift++;
      const norm = parts.filter((p) => p.normalized);
      if (norm.length) convertedSegs++;
      if (norm.some((p) => !p.spoken || !sameSpokenNumbers(p.spoken, p.text))) spokenMissing++;
    }
  }
  check(`spans re-join to the normal render for all ${segs} segments`, drift === 0, `${drift} differ`);
  check('every marked span carries the spoken words it replaced, saying the same number',
    spokenMissing === 0, `${spokenMissing} bad`);
  check('and the marking fires on the real corpus', convertedSegs > 0, `${convertedSegs} segments marked`);

  // THE MARKER'S REAL PRECONDITION. Span roles are assigned by odd/even position between marker
  // pairs, so a marker character arriving in provider text would silently shift every role — the
  // reader would see the wrong words attributed to the wrong span, with no guard tripping, because
  // re-joining still reproduces the expected string. Nothing downstream can detect that; the only
  // defence is that the marker cannot occur in a transcript. So assert it.
  //
  // (An earlier comment in lib/readability.ts claimed the marker was safe because `normalizeWords`
  // strips it. That is irrelevant — no guard ever compares a marked string to an unmarked one, and
  // patching `normalizeWords` to preserve control characters leaves the output byte-identical.
  // This is the check that actually protects the mechanism.)
  let withControl = 0;
  for (const f of readdirSync(join(process.cwd(), 'samples')).filter((x) => x.endsWith('.stt.json'))) {
    const parsed = JSON.parse(readFileSync(join(process.cwd(), 'samples', f), 'utf8')) as {
      segments: { text: string }[];
    };
    // Escapes, not literal control bytes — a literal NUL in a source file makes grep treat
    // the whole file as binary and silently return nothing for every pattern.
    for (const s of parsed.segments) if (/[\u0000-\u001f]/.test(s.text)) withControl++;
  }
  check('no provider segment contains a control character that could collide with the marker',
    withControl === 0, `${withControl} segment(s) contain one`);
}

console.log(
  failures === 0
    ? '\n\x1b[32m\x1b[1mAll readability checks passed.\x1b[0m Casing never changes words; digits only convert an anchored run.\n'
    : `\n\x1b[31m\x1b[1m${failures} check(s) FAILED.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
