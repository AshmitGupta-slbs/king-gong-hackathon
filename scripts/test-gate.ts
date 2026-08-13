/**
 * Gate verification. The most important test in this repo: it proves "no proof, no claim" is
 * enforced by code rather than asserted in a README.
 *
 * Run: npm run test:gate
 */
import { runCitationGate, supportScore } from '@/lib/harness/gate';
import type { ExtractionDraft, TranscriptSegment } from '@/lib/types';

const segments: TranscriptSegment[] = [
  { id: 'seg_000', speaker: 'rep', start_ms: 0, end_ms: 6160, text: "hi sarah thanks for making the time today i know you've been evaluating a few options" },
  { id: 'seg_001', speaker: 'prospect', start_ms: 6000, end_ms: 10400, text: "yeah no problem we've been looking at gong and chorus honestly" },
  { id: 'seg_002', speaker: 'rep', start_ms: 10160, end_ms: 15680, text: "that's fair most teams we talk to are in exactly that spot before they switch" },
  { id: 'seg_003', speaker: 'prospect', start_ms: 15280, end_ms: 20240, text: 'the pricing is the real problem though one four oh oh a seat is hard to justify' },
  { id: 'seg_004', speaker: 'rep', start_ms: 20000, end_ms: 25440, text: 'i can get you a pilot on two seats so your cfo sees the number before committing' },
  { id: 'seg_005', speaker: 'prospect', start_ms: 25280, end_ms: 29280, text: "okay send that over and i'll take it to the finance review on thursday" },
];

let failures = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? '  \x1b[32mPASS\x1b[0m' : '  \x1b[31mFAIL\x1b[0m'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

const baseDraft = (over: Partial<ExtractionDraft> = {}): ExtractionDraft => ({
  summary: 'Discovery call. Prospect is evaluating Gong and Chorus; pricing is the blocker.',
  intent: { label: 'price-sensitive', segment_ids: ['seg_003'] },
  objections: [{ claim: 'Pricing is hard to justify at that per-seat cost', segment_ids: ['seg_003'] }],
  next_steps: [{ claim: 'Send the two-seat pilot for the finance review on thursday', segment_ids: ['seg_005'] }],
  follow_up_email: { subject: 'Two-seat pilot', body: 'As discussed, here is the pilot so your cfo sees the number.', segment_ids: ['seg_004'] },
  key_moments: [{ type: 'competitor_mention', segment_id: 'seg_001', note: 'Named Gong and Chorus' }],
  ...over,
});

console.log('\n\x1b[1m1. A clean, well-cited extraction ships\x1b[0m');
{
  const { result, rejections } = runCitationGate(baseDraft(), segments);
  check('run_status is "shipped"', result.run_status === 'shipped', result.run_status);
  check('no rejections', rejections.length === 0, `${rejections.length}`);
  check('objection verified', result.objections[0]?.verdict === 'verified',
    `support=${result.objections[0]?.support.toFixed(2)}`);
  check('evidence text comes from the segment, not the model',
    result.objections[0]?.evidence[0]?.text === segments[3].text);
  check('evidence carries the segment\'s real timestamp',
    result.objections[0]?.evidence[0]?.start_ms === 15280);
}

console.log('\n\x1b[1m2. THE BIG ONE: a fabricated segment id is blocked and logged\x1b[0m');
{
  const draft = baseDraft({
    objections: [
      { claim: 'Pricing is hard to justify at that per-seat cost', segment_ids: ['seg_003'] },
      { claim: 'The prospect said their legal team blocked the deal', segment_ids: ['seg_999'] },
    ],
  });
  const { result, rejections } = runCitationGate(draft, segments);
  check('fabricated claim dropped from output', result.objections.length === 1,
    `${result.objections.length} objection(s) survived`);
  check('legitimate claim survived alongside it',
    result.objections[0]?.claim.includes('Pricing'));
  const r = rejections.find((x) => x.reason === 'unresolvable_citation');
  check('rejection logged with a reason', !!r, r?.detail);
  check('rejection marked as dropped', r?.dropped === true);
  check('run_status downgraded to "partial"', result.run_status === 'partial', result.run_status);
}

console.log('\n\x1b[1m3. A real segment that does not support the claim ships FLAGGED, not dropped\x1b[0m');
{
  const draft = baseDraft({
    objections: [{
      claim: 'The prospect confirmed budget approval and a signed purchase order',
      segment_ids: ['seg_000'],
    }],
  });
  const { result, rejections } = runCitationGate(draft, segments);
  check('claim still present', result.objections.length === 1);
  check('marked unverified', result.objections[0]?.verdict === 'unverified',
    `support=${result.objections[0]?.support.toFixed(2)}`);
  check('not dropped', rejections.some((r) => r.reason === 'unsupported_by_segment' && !r.dropped));
  check('run_status "partial"', result.run_status === 'partial', result.run_status);
}

console.log('\n\x1b[1m4. A claim with no citation at all is dropped\x1b[0m');
{
  const draft = baseDraft({ next_steps: [{ claim: 'Renew in Q3', segment_ids: [] }] });
  const { result, rejections } = runCitationGate(draft, segments);
  check('dropped', result.next_steps.length === 0);
  check('reason is no_citation', rejections.some((r) => r.reason === 'no_citation'));
}

console.log('\n\x1b[1m5. Nothing holds up at all -> "failed", not a cheerful "partial"\x1b[0m');
{
  const draft = baseDraft({
    objections: [{ claim: 'Legal blocked it', segment_ids: ['seg_900'] }],
    next_steps: [{ claim: 'Ship next week', segment_ids: ['seg_901'] }],
    key_moments: [{ type: 'pricing', segment_id: 'seg_902', note: 'nope' }],
    intent: { label: 'closed won', segment_ids: ['seg_903'] },
    follow_up_email: { subject: 'x', body: 'y', segment_ids: ['seg_904'] },
  });
  const { result } = runCitationGate(draft, segments);
  check('run_status is "failed"', result.run_status === 'failed', result.run_status);
  check('every list claim dropped',
    result.objections.length === 0 && result.next_steps.length === 0 && result.key_moments.length === 0);
  check('singleton email retained but unverified', result.follow_up_email.verdict === 'unverified');
}

console.log('\n\x1b[1m6. Partially-bad citation list keeps the good ids, drops the bad\x1b[0m');
{
  const draft = baseDraft({
    objections: [{ claim: 'Pricing is hard to justify per seat', segment_ids: ['seg_003', 'seg_777'] }],
  });
  const { result, rejections } = runCitationGate(draft, segments);
  check('kept only the resolvable id',
    JSON.stringify(result.objections[0]?.segment_ids) === JSON.stringify(['seg_003']));
  check('partial-citation rejection logged, not dropped',
    rejections.some((r) => r.reason === 'unresolvable_citation' && !r.dropped));
}

console.log('\n\x1b[1m7. Outcomes — judgements on commitments from EARLIER calls\x1b[0m');
{
  const OPEN = ['ai_1111aaaa', 'ai_2222bbbb'];

  // An item id the account does not have is a citation pointing at nothing, and is dropped like one.
  {
    const draft = baseDraft({
      outcomes: [{ item_id: 'ai_deadbeef', status: 'done', note: 'they sent it', segment_ids: ['seg_005'] }],
    });
    const { result, rejections } = runCitationGate(draft, segments, undefined, OPEN);
    check('an invented item id is DROPPED', (result.outcomes?.length ?? 0) === 0,
      'otherwise a model could close a commitment that does not exist, or another account\'s');
    check('...and the drop is published', rejections.some((r) => r.dropped && r.field.startsWith('outcomes[')));
  }

  // The ordinary answer. No citation, and that is correct rather than a missing one.
  {
    const draft = baseDraft({
      outcomes: [{ item_id: OPEN[0], status: 'not_discussed', note: '', segment_ids: [] }],
    });
    const { result, rejections } = runCitationGate(draft, segments, undefined, OPEN);
    check('not_discussed passes with NO citation', result.outcomes?.[0]?.verdict === 'verified',
      'absence has no line to point at, and demanding one would invite an invented citation');
    check('...and logs no rejection', !rejections.some((r) => r.field.startsWith('outcomes[')));
    check('...carrying no evidence', result.outcomes?.[0]?.evidence.length === 0);
  }

  // done needs a real line, and one that says what the note says.
  {
    const draft = baseDraft({
      outcomes: [{ item_id: OPEN[0], status: 'done', note: 'they will take it to finance review on thursday', segment_ids: ['seg_005'] }],
    });
    const { result } = runCitationGate(draft, segments, undefined, OPEN);
    check('a done backed by a real supporting line VERIFIES',
      result.outcomes?.[0]?.verdict === 'verified', `support ${result.outcomes?.[0]?.support.toFixed(2)}`);
  }
  {
    const draft = baseDraft({
      outcomes: [{ item_id: OPEN[0], status: 'done', note: 'it happened', segment_ids: ['seg_999'] }],
    });
    const { result, rejections } = runCitationGate(draft, segments, undefined, OPEN);
    check('a done citing a nonexistent segment is DROPPED', (result.outcomes?.length ?? 0) === 0);
    check('...for the right reason',
      rejections.some((r) => r.field.startsWith('outcomes[') && r.reason === 'unresolvable_citation'));
  }
  {
    const draft = baseDraft({
      outcomes: [{ item_id: OPEN[0], status: 'done', note: 'done', segment_ids: [] }],
    });
    const { result, rejections } = runCitationGate(draft, segments, undefined, OPEN);
    check('a done with no citation at all is DROPPED', (result.outcomes?.length ?? 0) === 0,
      'a commitment must not close on an assertion');
    check('...logged as no_citation',
      rejections.some((r) => r.field.startsWith('outcomes[') && r.reason === 'no_citation'));
  }
  {
    // Cites a real line that plainly does not say the thing happened.
    const draft = baseDraft({
      outcomes: [{ item_id: OPEN[0], status: 'done', note: 'the legal team approved data residency', segment_ids: ['seg_000'] }],
    });
    const { result } = runCitationGate(draft, segments, undefined, OPEN);
    check('a done whose line does not support it ships FLAGGED, not dropped',
      result.outcomes?.[0]?.verdict === 'unverified',
      'the rejection card should show what was claimed and why it did not hold');
  }

  // With nothing carried in, every outcome is unresolvable — there was nothing to judge.
  {
    const draft = baseDraft({
      outcomes: [{ item_id: OPEN[0], status: 'done', note: 'sent', segment_ids: ['seg_005'] }],
    });
    const { result } = runCitationGate(draft, segments);
    check('with no open items, an outcome cannot resolve', (result.outcomes?.length ?? 0) === 0);
  }

  // Exit-status accounting has to count them on both sides.
  {
    const draft = baseDraft({
      objections: [], next_steps: [], key_moments: [],
      outcomes: [{ item_id: 'ai_nope', status: 'done', note: 'x', segment_ids: ['seg_005'] }],
    });
    const { result } = runCitationGate(draft, segments, undefined, OPEN);
    check('an attempt where only outcomes were tried, and all died, is not "shipped"',
      result.run_status !== 'shipped', result.run_status);
  }
  {
    const draft = baseDraft({
      outcomes: [{ item_id: OPEN[0], status: 'not_discussed', note: '', segment_ids: [] }],
    });
    const { result } = runCitationGate(draft, segments, undefined, OPEN);
    check('an otherwise clean call with a not_discussed still ships', result.run_status === 'shipped',
      result.run_status);
  }
}

console.log('\n\x1b[1m8. supportScore sanity\x1b[0m');
{
  const good = supportScore('pricing is hard to justify per seat', segments[3].text);
  const bad = supportScore('legal team blocked the deal over data residency', segments[3].text);
  check('supporting text scores higher than unrelated text', good > bad, `${good.toFixed(2)} vs ${bad.toFixed(2)}`);
  check('unrelated text scores near zero', bad < 0.18, bad.toFixed(2));
}

console.log(
  failures === 0
    ? '\n\x1b[32m\x1b[1mAll gate checks passed.\x1b[0m The gate blocks, logs, and downgrades status.\n'
    : `\n\x1b[31m\x1b[1m${failures} check(s) FAILED.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
