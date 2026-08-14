/**
 * Scoring resolver verification. Runs no model — `resolveCriterionEvidence` is pure — and proves
 * the one thing this feature is not allowed to get wrong: a segment id the model returns can only
 * ever become evidence if it was ALREADY citable in this call's gated extraction AND still exists
 * in this call's real segments. Anything else is silently stripped, not trusted.
 *
 * Run: npm run test:scoring
 */
import { resolveCriterionEvidence } from '@/lib/scoring/score';
import type { TranscriptSegment } from '@/lib/types';

let failures = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? '  \x1b[32mPASS\x1b[0m' : '  \x1b[31mFAIL\x1b[0m'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

const segments: TranscriptSegment[] = [
  { id: 'seg_000', speaker: 'rep', start_ms: 0, end_ms: 4000, text: 'hi thanks for making the time today' },
  { id: 'seg_001', speaker: 'prospect', start_ms: 4000, end_ms: 9000, text: 'the pricing is a real problem for us this quarter' },
  { id: 'seg_002', speaker: 'rep', start_ms: 9000, end_ms: 13000, text: 'i can get you a pilot so finance sees the number' },
];

console.log('\n\x1b[1mScoring resolver\x1b[0m\n');

{
  // The ordinary case: the model cites an id that was genuinely already shown to it.
  const allowed = new Set(['seg_001']);
  const out = resolveCriterionEvidence(['seg_001'], allowed, segments);
  check('a genuinely allowed, real id resolves', out.length === 1 && out[0].segment_id === 'seg_001');
  check('the resolved evidence is the real segment text', out[0]?.text === segments[1].text);
}

{
  // Adversarial: the model invents an id that never appeared anywhere in the gated extraction.
  const allowed = new Set(['seg_001']); // seg_002 was never shown to the model
  const out = resolveCriterionEvidence(['seg_002'], allowed, segments);
  check('an id never shown to the model is DROPPED, even though the segment is real', out.length === 0);
}

{
  // Adversarial: the model cites an id that plain does not exist in this call at all.
  const allowed = new Set(['seg_001', 'seg_999']); // pretend it were somehow "allowed"
  const out = resolveCriterionEvidence(['seg_999'], allowed, segments);
  check('an id that does not exist in this call is DROPPED even if "allowed"', out.length === 0,
    'defence in depth: existence in this call\'s real segments is checked independently of the allow-list');
}

{
  // Mixed: one good id, one fabricated — only the good one should survive.
  const allowed = new Set(['seg_000', 'seg_001']);
  const out = resolveCriterionEvidence(['seg_000', 'seg_777'], allowed, segments);
  check('a mix keeps only the resolvable id', out.length === 1 && out[0].segment_id === 'seg_000');
}

{
  // A duplicate citation of the same real, allowed id should not produce duplicate evidence.
  const allowed = new Set(['seg_000']);
  const out = resolveCriterionEvidence(['seg_000', 'seg_000'], allowed, segments);
  check('a duplicated id does not duplicate evidence', out.length === 1);
}

{
  // Empty input is a legitimate answer, not an error.
  const out = resolveCriterionEvidence([], new Set(), segments);
  check('no citation is a valid, empty result', out.length === 0);
}

console.log(
  failures === 0
    ? '\n\x1b[1m\x1b[32mALL SCORING CHECKS PASS\x1b[0m\n'
    : `\n\x1b[1m\x1b[31m${failures} FAILED\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
