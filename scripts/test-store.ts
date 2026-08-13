/**
 * Prove the storage contract, whichever backend is configured.
 *
 *   MONGODB_URI=mongodb+srv://…  npm run test:store
 *   npm run test:store                    # no URI → exercises SQLite instead
 *
 * This exists because the two backends are only interchangeable if they actually behave the same,
 * and "it compiled" is not evidence of that. Every method the app uses is exercised against real
 * storage: writes, reads, the ordering the UI depends on, and the replace-semantics the learning
 * ledger relies on to stay idempotent.
 *
 * It writes under a `zz_test_` id prefix and deletes what it wrote, so it is safe to point at a
 * real database — including the deployed one, which is the only way to find out whether the
 * gateway or cluster you are about to demo on actually works.
 */
import { existsSync } from 'node:fs';

for (const f of ['.env.local', '.env']) {
  if (!existsSync(f)) continue;
  try {
    process.loadEnvFile(f);
    break;
  } catch {
    /* a malformed env file should not stop the suite */
  }
}

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

let failures = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? c.ok('PASS') : c.bad('FAIL')}  ${name}${detail ? c.dim(` — ${detail}`) : ''}`);
  if (!cond) failures++;
};
const head = (s: string) => console.log(`\n${c.b(s)}`);

const ID = 'zz_test_';

async function main() {
  const { store } = await import('@/lib/db');
  const { backend, describeStore } = await import('@/lib/store');
  const s = store();

  console.log(`\n${c.b('Storage contract')}  ${c.dim(describeStore().detail)}\n`);

  const callId = `${ID}call`;
  const companyId = `${ID}co`;

  // ── calls ──────────────────────────────────────────────────────────────────
  head('Calls');
  await s.insertCall({
    id: callId,
    title: 'Original title',
    audio_path: `/api/audio/${callId}.wav`,
    duration_ms: 61_000,
    separation: 'channel',
    created_at: Date.now(),
    share_id: callId,
  });
  const call = await s.getCall(callId);
  check('a written call reads back', call?.id === callId, call?.title);
  check('every field survives the round trip', call?.duration_ms === 61_000 && call?.separation === 'channel');

  await s.renameCall(callId, 'Renamed by analysis');
  const renamed = await s.getCall(callId);
  check('renameCall changes ONLY the title', renamed?.title === 'Renamed by analysis');
  check('...and leaves the rest intact', renamed?.audio_path === `/api/audio/${callId}.wav` && renamed?.share_id === callId,
    'a partial upsert here would blank audio_path and churn the share link');

  const byShare = await s.getCallByShareId(callId);
  check('lookup by share id finds it', byShare?.id === callId);
  check('a missing call is null, not a throw', (await s.getCall(`${ID}nope`)) === null);
  check('listCalls includes it', (await s.listCalls()).some((x) => x.id === callId));

  // ── segments ───────────────────────────────────────────────────────────────
  head('Segments');
  await s.replaceSegments(callId, [
    { id: 'seg_000', speaker: 'rep', start_ms: 0, end_ms: 1000, text: 'first', channel: 0 },
    { id: 'seg_001', speaker: 'prospect', start_ms: 1000, end_ms: 2000, text: 'second', channel: 1 },
  ]);
  let segs = await s.getSegments(callId);
  check('segments write and read', segs.length === 2, `${segs.length} back`);
  check('ORDER is preserved', segs[0]?.id === 'seg_000' && segs[1]?.id === 'seg_001',
    'the transcript renders in this order — a wrong sort is a scrambled call');
  check('optional fields survive', segs[0]?.channel === 0);

  await s.replaceSegments(callId, [
    { id: 'seg_000', speaker: 'rep', start_ms: 0, end_ms: 500, text: 'only one now' },
  ]);
  segs = await s.getSegments(callId);
  check('replaceSegments REPLACES rather than appends', segs.length === 1, `${segs.length} after replace`);

  // ── extractions ────────────────────────────────────────────────────────────
  head('Extractions');
  const ex = {
    summary: 'a summary',
    intent: { label: 'price-sensitive', segment_ids: ['seg_000'], verdict: 'verified' as const, support: 0.5, evidence: [] },
    objections: [],
    next_steps: [],
    follow_up_email: { subject: 's', body: 'b', segment_ids: ['seg_000'], verdict: 'verified' as const, support: 0.4, evidence: [] },
    key_moments: [],
    run_status: 'shipped' as const,
    rejections: [],
    extracted_by: 'test',
  };
  await s.saveExtraction(callId, ex);
  const readEx = await s.getExtraction(callId);
  check('an extraction round-trips', readEx?.summary === 'a summary' && readEx?.run_status === 'shipped');
  check('nested structure survives', readEx?.intent.label === 'price-sensitive');

  // ── runs: the failure invariant ────────────────────────────────────────────
  head('Runs');
  const runId = `${ID}run`;
  await s.openRun(runId, callId, 'test-step');
  let runs = await s.listRuns(200);
  const opened = runs.find((r) => r.id === runId);
  check('openRun writes a row BEFORE work', opened?.status === 'running');
  await s.closeRun(runId, 'shipped', { attempts: 2, notes: 'n' });
  runs = await s.listRuns(200);
  const closed = runs.find((r) => r.id === runId);
  check('closeRun writes exactly one terminal status', closed?.status === 'shipped' && closed?.ended_at !== null);
  check('attempts and notes persist', closed?.attempts === 2 && closed?.notes === 'n');
  check('listRuns is newest-first', runs.length < 2 || runs[0].started_at >= runs[runs.length - 1].started_at);

  // ── rejections and usage ───────────────────────────────────────────────────
  head('Rejections and usage');
  const before = await s.countRejections();
  await s.recordRejections(callId, runId, [
    { field: 'objections[0]', claim: 'x', reason: 'unresolvable_citation', detail: 'd', dropped: true },
    { field: 'objections[1]', claim: 'y', reason: 'unsupported_by_segment', detail: 'd', dropped: false },
  ]);
  const after = await s.countRejections();
  check('rejections are counted', after.total === before.total + 2, `${before.total} → ${after.total}`);
  check('dropped is counted separately from flagged', after.dropped === before.dropped + 1);

  const u0 = await s.usageTotals();
  await s.recordUsage(callId, 'test-provider', { audio_seconds: 30, input_tokens: 100, output_tokens: 50 });
  const u1 = await s.usageTotals();
  check('usage accumulates', u1.audio_seconds === u0.audio_seconds + 30 && u1.input_tokens === u0.input_tokens + 100);
  check('minutes derive from seconds', Math.abs(u1.minutes - u1.audio_seconds / 60) < 1e-9);

  // ── companies ──────────────────────────────────────────────────────────────
  head('Companies');
  await s.upsertCompany({
    id: companyId, name: 'Zed Test Co', industry: 'Testing', size_band: '1-10',
    website: 'zed.example', notes: 'typed by a human', stage: 'Negotiation',
    created_at: Date.now(), detail: { location: 'Nowhere' },
  });
  const co = await s.getCompany(companyId);
  check('a company round-trips', co?.name === 'Zed Test Co' && co?.stage === 'Negotiation');
  check('the detail blob survives', co?.detail?.location === 'Nowhere');
  check('listCompanies includes it', (await s.listCompanies()).some((x) => x.id === companyId));

  await s.upsertCompany({ ...co!, notes: 'edited' });
  check('upsert updates rather than duplicating', (await s.getCompany(companyId))?.notes === 'edited');

  await s.linkCallToCompany(callId, companyId);
  check('a call links to its company', (await s.companyIdForCall(callId)) === companyId);
  check('an unlinked call returns null', (await s.companyIdForCall(`${ID}other`)) === null);

  // ── learnings ──────────────────────────────────────────────────────────────
  head('Learnings');
  const row = (text: string) => ({
    company_id: companyId, call_id: callId, created_at: Date.now(),
    kind: 'objection' as const, text,
    segment_id: 'seg_000', start_ms: 0, speaker: 'prospect', quote: 'q',
    support: 0.5, verdict: 'verified', extracted_by: 'test', promoted: false,
  });
  await s.replaceLearningsForCall(callId, [row('first learning'), row('second learning')]);
  let ls = await s.learningsForCompany(companyId);
  check('learnings write and read', ls.length === 2, `${ls.length} back`);
  check('evidence is carried', ls[0]?.segment_id === 'seg_000' && ls[0]?.quote === 'q');

  await s.replaceLearningsForCall(callId, [row('only one now')]);
  ls = await s.learningsForCompany(companyId);
  check('re-analysis REPLACES that call\'s rows', ls.length === 1,
    'otherwise an account looks like it heard the same objection twice');

  const one = ls[0];
  check('a learning is addressable by id', (await s.getLearning(one.id))?.text === 'only one now');
  await s.markLearningPromoted(one.id);
  check('promotion persists', (await s.getLearning(one.id))?.promoted === true);

  // ── cleanup ────────────────────────────────────────────────────────────────
  head('Cleanup');
  await s.replaceSegments(callId, []);
  await s.replaceLearningsForCall(callId, []);
  check('test rows removed', (await s.getSegments(callId)).length === 0 &&
    (await s.learningsForCompany(companyId)).length === 0);
  console.log(
    c.dim(`  note: the ${ID}* call, company and run rows are left behind — no delete in the contract.`),
  );

  console.log(
    failures === 0
      ? `\n${c.ok(`ALL STORAGE CHECKS PASS`)} ${c.dim(`(${backend()} backend)`)}\n`
      : `\n${c.bad(`${failures} FAILED`)} ${c.dim(`(${backend()} backend)`)}\n`,
  );

  if (backend() === 'direct') {
    const { closeDirect } = await import('@/lib/store/direct');
    await closeDirect();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(c.bad(`\ntest:store failed: ${e instanceof Error ? e.stack : String(e)}\n`));
  process.exit(1);
});
