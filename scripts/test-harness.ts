/**
 * Harness verification — the Loop Depth proof.
 *
 *   npm run test:harness
 *
 * The claim being tested is not "the happy path works". It is that the failure paths are real:
 * budgets stop runs, retries are bounded and aimed, writes to one call are serialised, and no run
 * can vanish without leaving a record. Every one of these is asserted by forcing the failure, not
 * by reading the code.
 *
 * Note there is no fake provider anywhere here. Failures are induced through real code paths — a
 * fixture that does not exist, a budget cap of one cent — so what passes is the shipping loop.
 */
import { bedrockModelId, needsAccountId, __clearBedrockModelIdCache } from '@/lib/bedrock-model-id';
import { REGISTRY_CONFIG } from '@/lib/registry';
import { resolveBedrockModelId, __setStsTransport } from '@/lib/registry/providers/bedrock-extract';
import { db, closeRun, getSegments, listRuns, openRun, reconcileOrphanRuns } from '@/lib/db';
import { BudgetGovernor, DeadlineError, estimateTokens } from '@/lib/harness/budget';
import { processCall } from '@/lib/harness/loop';
import { activeLockCount, parallelMap, withLock } from '@/lib/harness/parallel';
import { retryAimed } from '@/lib/harness/retry';
import {
  audioUploadIdentity,
  buildWav,
  concat,
  detectChannelLayout,
  interleaveStereo,
  parseWav,
  readWavHeader,
  silence,
  sniffAudioFormat,
} from '@/lib/wav';
import { resolveSeparation } from '@/lib/separation';
import { RequestedSeparationSchema, SeparationModeSchema } from '@/lib/types';
import { mapSegments } from '@/lib/registry/providers/pyai-jobs';

let failures = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? '  \x1b[32mPASS\x1b[0m' : '  \x1b[31mFAIL\x1b[0m'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};
const head = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TEST_PREFIX = 'zz-test-';

async function main() {
  // ── 7. Budget governor ─────────────────────────────────────────────────────
  head('Budget governor — caps enforced BEFORE the call, not logged after');
  {
    const g = new BudgetGovernor({ maxInputTokens: 1000, maxUsd: 1, maxWallClockMs: 60_000 });
    let threw = false;
    try {
      g.preflight(500, 100);
    } catch {
      threw = true;
    }
    check('a request inside the caps is allowed', !threw);

    let caught: unknown = null;
    try {
      g.preflight(5000, 100);
    } catch (e) {
      caught = e;
    }
    check(
      'projected input over cap throws DeadlineError',
      caught instanceof DeadlineError && caught.cap === 'maxInputTokens',
      caught instanceof DeadlineError ? caught.message : String(caught),
    );

    const cheap = new BudgetGovernor({ maxUsd: 0.000001, maxInputTokens: 1e9 });
    let usdErr: unknown = null;
    try {
      cheap.preflight(100_000, 10_000);
    } catch (e) {
      usdErr = e;
    }
    check(
      'projected spend over cap throws with cap=maxUsd',
      usdErr instanceof DeadlineError && usdErr.cap === 'maxUsd',
      usdErr instanceof DeadlineError ? usdErr.message : String(usdErr),
    );

    const impatient = new BudgetGovernor({ maxWallClockMs: 1 });
    await sleep(15);
    let clockErr: unknown = null;
    try {
      impatient.preflight(1);
    } catch (e) {
      clockErr = e;
    }
    check(
      'elapsed wall clock over cap throws with cap=maxWallClockMs',
      clockErr instanceof DeadlineError && clockErr.cap === 'maxWallClockMs',
    );

    const acc = new BudgetGovernor({});
    acc.record({ input_tokens: 1_000_000, output_tokens: 100_000 });
    const snap = acc.snapshot();
    // 1M input @ $5/MTok + 100k output @ $25/MTok = $5.00 + $2.50
    check('usd accounting matches list pricing', Math.abs(snap.usd - 7.5) < 0.001, `$${snap.usd}`);
    check('token estimator is roughly sane', estimateTokens('x'.repeat(3600)) === 1000);
  }

  // ── 3. Bounded aimed retry ─────────────────────────────────────────────────
  head('Bounded aimed retry — capped, and the reason is fed forward');
  {
    const ok = await retryAimed({ attempts: 3, run: async () => 'fine' });
    check('succeeds on first attempt without retrying', ok.attempts === 1 && ok.value === 'fine');

    const seenPriors: (string | undefined)[] = [];
    let n = 0;
    const aimed = await retryAimed({
      attempts: 3,
      run: async (_i, prior) => {
        seenPriors.push(prior);
        return ++n;
      },
      validate: (v) => (v >= 2 ? { ok: true } : { ok: false, reason: 'value too small' }),
    });
    check('retries when validate rejects', aimed.attempts === 2, `attempts=${aimed.attempts}`);
    check('first attempt gets no priorFailure', seenPriors[0] === undefined);
    check(
      'THE AIMED PART: retry receives the specific failure reason',
      seenPriors[1] === 'value too small',
      String(seenPriors[1]),
    );

    let calls = 0;
    const capped = await retryAimed({
      attempts: 2,
      run: async () => ++calls,
      validate: () => ({ ok: false, reason: 'never happy' }),
    });
    check('attempts are CAPPED, no infinite loop', calls === 2, `called ${calls}x`);
    check('returns the last value once attempts run out', capped.value === 2);
    check('records each failure reason', capped.failures.length === 2);

    let thrown = 0;
    let escaped: unknown = null;
    try {
      await retryAimed({
        attempts: 3,
        run: async () => {
          thrown++;
          throw new Error('provider exploded');
        },
      });
    } catch (e) {
      escaped = e;
    }
    check('a throwing step is retried to the cap then rethrown', thrown === 3 && escaped !== null);

    let deadlineTries = 0;
    let dl: unknown = null;
    try {
      await retryAimed({
        attempts: 3,
        run: async () => {
          deadlineTries++;
          throw new DeadlineError('maxUsd', 'out of money');
        },
      });
    } catch (e) {
      dl = e;
    }
    check(
      'a budget DeadlineError is never retried — retrying is what it exists to prevent',
      deadlineTries === 1 && dl instanceof DeadlineError,
      `tried ${deadlineTries}x`,
    );

    let fatalTries = 0;
    try {
      await retryAimed({
        attempts: 3,
        run: async () => {
          fatalTries++;
          throw new Error('403 forbidden');
        },
        isFatal: (e) => e instanceof Error && e.message.includes('403'),
      });
    } catch {
      /* expected */
    }
    check('a fatal (non-retryable) error is not retried', fatalTries === 1, `tried ${fatalTries}x`);
  }

  // ── 6. Safe parallelism ────────────────────────────────────────────────────
  head('Safe parallelism — concurrent across calls, serialised within one call');
  {
    const order: string[] = [];
    const slow = (tag: string, ms: number) => async () => {
      order.push(`${tag}:start`);
      await sleep(ms);
      order.push(`${tag}:end`);
      return tag;
    };

    await Promise.all([withLock('call-A', slow('a1', 40)), withLock('call-A', slow('a2', 5))]);
    check(
      'same key: second waits for the first to finish',
      order.join(' ') === 'a1:start a1:end a2:start a2:end',
      order.join(' '),
    );

    const order2: string[] = [];
    const tagged = (tag: string, ms: number) => async () => {
      order2.push(`${tag}:start`);
      await sleep(ms);
      order2.push(`${tag}:end`);
    };
    await Promise.all([withLock('call-X', tagged('x', 30)), withLock('call-Y', tagged('y', 5))]);
    check(
      'different keys run concurrently',
      order2.indexOf('y:end') < order2.indexOf('x:end'),
      order2.join(' '),
    );

    // A holder that throws must not wedge everything queued behind it.
    const after: string[] = [];
    const boom = withLock('call-B', async () => {
      throw new Error('holder failed');
    });
    const queued = withLock('call-B', async () => {
      after.push('ran anyway');
      return 'ok';
    });
    await boom.catch(() => {});
    check('a throwing holder does not wedge the lock', (await queued) === 'ok' && after.length === 1);

    // Locks must be released, or the map grows for the process lifetime.
    await sleep(20);
    check('lock entries are released once drained', activeLockCount() === 0, `${activeLockCount()} left`);

    const started: number[] = [];
    let inFlight = 0;
    let peak = 0;
    const results = await parallelMap([1, 2, 3, 4, 5, 6, 7, 8], 3, async (item) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      started.push(item);
      await sleep(10);
      inFlight--;
      return item * 2;
    });
    check('parallelMap respects the concurrency limit', peak <= 3, `peak=${peak}`);
    check(
      'parallelMap preserves input order in its results',
      results.join(',') === '2,4,6,8,10,12,14,16',
      results.join(','),
    );
  }

  // ── 4. Failure invariant ───────────────────────────────────────────────────
  head('Failure invariant — no run disappears, even when the process dies');
  {
    const orphanId = `${TEST_PREFIX}orphan-${Date.now()}`;
    await openRun(orphanId, `${TEST_PREFIX}call`, 'ingest+extract+gate');
    // Simulate a process killed mid-run: the row exists, still marked running, and is stale.
    db()
      .prepare(`UPDATE runs SET started_at = ? WHERE id = ?`)
      .run(Date.now() - 30 * 60_000, orphanId);

    const reconciled = await reconcileOrphanRuns();
    const row = (await listRuns(200)).find((r) => r.id === orphanId);
    check('a stale running row is reconciled on boot', reconciled >= 1, `${reconciled} reconciled`);
    check('the orphan becomes a FAILED record, not a mystery', row?.status === 'failed', row?.status);
    check('and it carries a reason', Boolean(row?.error), row?.error ?? 'no error text');

    const closedId = `${TEST_PREFIX}closed-${Date.now()}`;
    await openRun(closedId, `${TEST_PREFIX}call`, 'ingest+extract+gate');
    await closeRun(closedId, 'shipped', { attempts: 1 });
    const before = await reconcileOrphanRuns();
    const still = (await listRuns(200)).find((r) => r.id === closedId);
    check('a properly closed run is never touched by reconciliation', still?.status === 'shipped', `${before} reconciled`);
  }

  // ── 1. The named loop, end to end ──────────────────────────────────────────
  head('Named loop — exactly one terminal status, always recorded');
  {
    const base = {
      audio: new Uint8Array(0), // the fixture provider replays committed JSON; bytes are unused
      audioPath: '/samples/clean-close.wav',
      mode: 'channel' as const,
      sttProvider: 'fixture',
    };

    const happyId = `${TEST_PREFIX}happy-${Date.now()}`;
    const happy = await processCall({
      ...base,
      callId: happyId,
      title: 'Harness test — happy path',
      filename: 'clean-close.wav',
    });
    check(
      'a good run ends shipped or partial',
      happy.run_status === 'shipped' || happy.run_status === 'partial',
      happy.run_status,
    );
    check('segments were persisted', (await getSegments(happyId)).length > 0, `${happy.segments} segments`);
    check('an extraction was produced', happy.extraction !== null);
    const happyRun = (await listRuns(200)).find((r) => r.id === happy.runId);
    check('the run row is closed with that status', happyRun?.status === happy.run_status);
    check('and it recorded a budget snapshot', Boolean(happyRun?.notes));

    // Force a provider failure through a real path: no such fixture exists.
    const badId = `${TEST_PREFIX}fail-${Date.now()}`;
    const bad = await processCall({
      ...base,
      callId: badId,
      title: 'Harness test — provider failure',
      filename: 'no-such-call.wav',
    });
    check('a provider failure ends as FAILED', bad.run_status === 'failed', bad.run_status);
    check('the error is reported to the caller', Boolean(bad.error), bad.error?.slice(0, 60));
    const badRun = (await listRuns(200)).find((r) => r.id === bad.runId);
    check('a failed run still leaves a row', Boolean(badRun), badRun?.status);
    check('with the failure reason attached', Boolean(badRun?.error));
    check('and no silent hang: the row is closed', badRun?.ended_at !== null);

    // Budget governor, through the loop this time.
    const brokeId = `${TEST_PREFIX}deadline-${Date.now()}`;
    const broke = await processCall({
      ...base,
      callId: brokeId,
      title: 'Harness test — budget deadline',
      filename: 'clean-close.wav',
      budgetCaps: { maxInputTokens: 1 }, // any real transcript blows straight past this
    });
    check(
      'THE BUDGET PROOF: an over-budget run exits with run_status "deadline"',
      broke.run_status === 'deadline',
      broke.run_status,
    );
    check('the deadline names the cap it hit', broke.error?.includes('maxInputTokens') ?? false, broke.error);
    const brokeRun = (await listRuns(200)).find((r) => r.id === broke.runId);
    check('the deadlined run is recorded too', brokeRun?.status === 'deadline');
  }

  head('Bedrock model ids — resolved by shape, ported from the reference implementation');
  {
    // Mirrors agent-service/tests/test_bedrock_model_id.py. The bare-id case is the one that was
    // broken: LLM_MODEL=3s3wyt6beb2x was being mangled into anthropic.3s3wyt6beb2x, producing a 404
    // that reads exactly like "this region does not serve that model".
    // The account is passed explicitly: this module is pure, reads no environment and opens no
    // socket, so every shape rule below is asserted with no mocking at all.
    const prevAccount = process.env.AWS_ACCOUNT_ID;
    const ACCT = '123456789012';
    __clearBedrockModelIdCache();

    check(
      'a bare application-inference-profile id expands to a full ARN',
      bedrockModelId('3s3wyt6beb2x', 'us-east-1', ACCT) ===
        'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/3s3wyt6beb2x',
      bedrockModelId('3s3wyt6beb2x', 'us-east-1', ACCT),
    );

    const arn = 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc';
    check('a full ARN passes through untouched', bedrockModelId(arn, 'us-east-1') === arn);

    check('cross-region profiles pass through',
      bedrockModelId('global.anthropic.claude-sonnet-4-6', 'us-east-1') === 'global.anthropic.claude-sonnet-4-6' &&
      bedrockModelId('us.anthropic.claude-sonnet-4-6', 'us-east-1') === 'us.anthropic.claude-sonnet-4-6');

    check('the two remapped foundation ids become cross-region profiles',
      bedrockModelId('anthropic.claude-sonnet-4-6', 'us-east-1') === 'global.anthropic.claude-sonnet-4-6',
      bedrockModelId('anthropic.claude-sonnet-4-6', 'us-east-1'));

    check('a non-claude foundation id passes through unchanged',
      bedrockModelId('anthropic.some-other', 'us-east-1') === 'anthropic.some-other');

    // Generalised beyond the reference's two-entry table, forced by a live 400: "Invocation of model
    // ID anthropic.claude-opus-5 with on-demand throughput isn't supported. Retry with the ID or ARN
    // of an inference profile." A global.-prefixed id IS an inference profile.
    check('any anthropic.claude-* id routes through a cross-region profile',
      bedrockModelId('anthropic.claude-opus-5', 'us-east-1') === 'global.anthropic.claude-opus-5',
      bedrockModelId('anthropic.claude-opus-5', 'us-east-1'));
    check('and a bare claude-* name lands in the same place',
      bedrockModelId('claude-opus-5', 'us-east-1') === 'global.anthropic.claude-opus-5',
      bedrockModelId('claude-opus-5', 'us-east-1'));

    check('an empty model stays empty', bedrockModelId('', 'us-east-1') === '');

    // OUR addition, absent from the reference: a bare `claude-*` name also contains none of . : /
    // so it would be misread as a profile id and expanded into a nonsense ARN.
    check('a bare claude-* name is a foundation id, not a profile id (no ARN expansion)',
      !bedrockModelId('claude-sonnet-4-6', 'us-east-1').startsWith('arn:'),
      bedrockModelId('claude-sonnet-4-6', 'us-east-1'));
    check('and the reference\'s own remap entry still holds',
      bedrockModelId('claude-sonnet-4-6', 'us-east-1') === 'global.anthropic.claude-sonnet-4-6',
      bedrockModelId('claude-sonnet-4-6', 'us-east-1'));

    // Only a bare profile id needs an account. Everything else must never trigger a lookup, which is
    // what keeps the STS call off the common paths.
    check('only a bare profile id needs an account id',
      needsAccountId('3s3wyt6beb2x') &&
        !needsAccountId(arn) &&
        !needsAccountId('global.anthropic.claude-sonnet-4-6') &&
        !needsAccountId('claude-opus-5') &&
        !needsAccountId(''));

    // With no account available at all, only the bare-id shape fails — and it fails with the remedy
    // rather than sending an id Bedrock will reject with a misleading 404.
    delete process.env.AWS_ACCOUNT_ID;
    __clearBedrockModelIdCache();
    let threw = false;
    let namesTheRemedy = false;
    try {
      bedrockModelId('3s3wyt6beb2x', 'us-east-1', null);
    } catch (e) {
      threw = true;
      const m = e instanceof Error ? e.message : '';
      namesTheRemedy = m.includes('AWS_ACCOUNT_ID') && m.includes('cross-region default');
    }
    check('a bare id with no resolvable account throws rather than sending a broken id', threw);
    check('and the error names both remedies', namesTheRemedy);

    check('an ARN still resolves with no account id', bedrockModelId(arn, 'us-east-1', null) === arn);
    check('a foundation id still resolves with no account id',
      bedrockModelId('claude-opus-5', 'us-east-1', null) === 'global.anthropic.claude-opus-5');

    // THE DEFAULT must be usable with nothing configured. It is a cross-region inference profile, so
    // it needs no account, no ARN and no provisioned throughput — which is the whole reason a blank
    // LLM_MODEL works. Asserted against the registry itself so the two cannot drift.
    check('the registry default is a cross-region inference profile',
      /^global\./.test(REGISTRY_CONFIG.extractModel), REGISTRY_CONFIG.extractModel);
    check('and it resolves unchanged, needing no account id',
      bedrockModelId(REGISTRY_CONFIG.extractModel, 'us-east-1', null) === REGISTRY_CONFIG.extractModel);

    if (prevAccount === undefined) delete process.env.AWS_ACCOUNT_ID;
    else process.env.AWS_ACCOUNT_ID = prevAccount;
    __clearBedrockModelIdCache();
  }

  head('STS account lookup — one call, cached, and never fatal on its own');
  {
    const prevAccount = process.env.AWS_ACCOUNT_ID;
    const prevKey = process.env.AWS_ACCESS_KEY_ID;
    const prevSecret = process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_ACCOUNT_ID;
    /**
     * Fake credentials so SigV4 has something to sign with — without them the credential chain
     * throws and the STS path bails before the transport, which is how this test first failed.
     * Deliberately NOT of the form AKIA…: `check:ship` scans committed files for that pattern, and a
     * test fixture that trips the repo's own secret scanner is a bad trade for realism SigV4 does not
     * require.
     */
    process.env.AWS_ACCESS_KEY_ID = 'test-access-key-id';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-access-key';
    __clearBedrockModelIdCache();

    // Stub the transport so the signing path runs for real but nothing leaves the machine.
    let calls = 0;
    __setStsTransport(async () => {
      calls++;
      return new Response(
        '<GetCallerIdentityResponse><GetCallerIdentityResult><Account>210987654321</Account>' +
          '</GetCallerIdentityResult></GetCallerIdentityResponse>',
        { status: 200 },
      );
    });

    const first = await resolveBedrockModelId('3s3wyt6beb2x', 'us-east-1');
    check('a bare id resolves via STS with AWS_ACCOUNT_ID unset',
      first === 'arn:aws:bedrock:us-east-1:210987654321:application-inference-profile/3s3wyt6beb2x',
      first);

    const second = await resolveBedrockModelId('3s3wyt6beb2x', 'us-east-1');
    check('a repeat resolution is cached — STS is called once', second === first && calls === 1, `calls=${calls}`);

    // A shape that needs no account must not reach STS at all.
    __setStsTransport(async () => {
      calls++;
      return new Response('<x/>', { status: 200 });
    });
    const callsBefore = calls;
    await resolveBedrockModelId('global.anthropic.claude-sonnet-4-6', 'us-east-1');
    await resolveBedrockModelId('claude-opus-5', 'us-east-1');
    check('shapes that need no account never call STS', calls === callsBefore, `calls=${calls}`);

    // An STS failure must surface as our explicit error, not an unexpanded id.
    __clearBedrockModelIdCache();
    __setStsTransport(async () => new Response('nope', { status: 403 }));
    let stsFailureThrew = false;
    try {
      await resolveBedrockModelId('3s3wyt6beb2x', 'us-east-1');
    } catch {
      stsFailureThrew = true;
    }
    check('an STS failure throws rather than sending the bare id', stsFailureThrew);

    __setStsTransport(null);
    if (prevAccount === undefined) delete process.env.AWS_ACCOUNT_ID;
    else process.env.AWS_ACCOUNT_ID = prevAccount;
    if (prevKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
    else process.env.AWS_ACCESS_KEY_ID = prevKey;
    if (prevSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = prevSecret;
    __clearBedrockModelIdCache();
  }

  head('Upload identity — the container is read from the bytes, never the filename');
  {
    // The case that motivated this: a real dialer export named .mp3 that is actually RIFF/WAVE.
    // Declaring the extension's format would misreport it to the API on the files people really
    // have, so the sniffed type wins and the filename is corrected to agree with it.
    const wavBytes = buildWav({ pcm16: silence(40, 8000), sampleRate: 8000, channels: 1 });
    const mislabelled = audioUploadIdentity(wavBytes, 'recording.mp3');
    check('a WAV named .mp3 is declared audio/wav', mislabelled.mime === 'audio/wav', mislabelled.mime);
    check('and its filename is corrected to .wav', mislabelled.filename === 'recording.wav', mislabelled.filename);
    check('the correction is reported', mislabelled.corrected);

    const honest = audioUploadIdentity(wavBytes, 'call.wav');
    check('a correctly-named WAV is left alone', honest.filename === 'call.wav' && !honest.corrected);

    check('RIFF/WAVE is detected', sniffAudioFormat(wavBytes)?.ext === 'wav');
    check('ID3-tagged MP3 is detected',
      sniffAudioFormat(new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0, 0]))?.mime === 'audio/mpeg');
    check('a bare MPEG frame is detected',
      sniffAudioFormat(new Uint8Array([0xff, 0xfb, 0x90, 0, 0, 0, 0, 0, 0, 0, 0, 0]))?.mime === 'audio/mpeg');
    check('OggS is detected',
      sniffAudioFormat(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0, 0, 0, 0, 0]))?.ext === 'ogg');
    check('fLaC is detected',
      sniffAudioFormat(new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 0, 0, 0, 0, 0]))?.ext === 'flac');
    check('ftyp (m4a/mp4) is detected',
      sniffAudioFormat(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]))?.mime === 'audio/mp4');

    // Both AIFF brands. AIFC is the one that matters: it is what `say -o x.aiff` emits with no
    // format flags, so recognising only AIFF missed the variant macOS produces by default.
    const aiffHdr = (brand: string) =>
      new Uint8Array([0x46, 0x4f, 0x52, 0x4d, 0, 1, 0xcb, 0x42, ...[...brand].map((c) => c.charCodeAt(0))]);
    check('plain AIFF is detected', sniffAudioFormat(aiffHdr('AIFF'))?.ext === 'aiff');
    check('AIFF-C is detected too (what `say` emits by default)',
      sniffAudioFormat(aiffHdr('AIFC'))?.ext === 'aiff', String(sniffAudioFormat(aiffHdr('AIFC'))?.ext));
    check('a FORM container of some other brand is not claimed as audio',
      sniffAudioFormat(aiffHdr('XXXX')) === null);

    // Unknown or truncated input must not block an upload — fall back to the old behaviour.
    check('an unrecognised container sniffs as null', sniffAudioFormat(new Uint8Array(16)) === null);
    check('too-short input sniffs as null', sniffAudioFormat(new Uint8Array([1, 2, 3])) === null);
    const unknown = audioUploadIdentity(new Uint8Array(16), 'mystery.bin');
    check('an unknown container keeps its filename and falls back to audio/wav',
      unknown.mime === 'audio/wav' && unknown.filename === 'mystery.bin' && !unknown.corrected);
  }

  // Clean up so test rows never show up in the demo UI.
  const d = db();
  for (const t of ['segments', 'extractions', 'gate_rejections', 'usage_events']) {
    d.prepare(`DELETE FROM ${t} WHERE call_id LIKE ?`).run(`${TEST_PREFIX}%`);
  }
  d.prepare(`DELETE FROM calls WHERE id LIKE ?`).run(`${TEST_PREFIX}%`);

  // ───────────────────────────────────────────────────────────────────────────
  const RATE = 8000;
  /** int16 sine, written through a DataView so it works on a pooled Buffer too. */
  function tone(ms: number, hz = 220, amp = 9000): Uint8Array {
    const n = Math.round((RATE * ms) / 1000);
    const out = new Uint8Array(n * 2);
    const v = new DataView(out.buffer);
    for (let i = 0; i < n; i++) {
      v.setInt16(i * 2, Math.round(amp * Math.sin((2 * Math.PI * hz * i) / RATE)), true);
    }
    return out;
  }
  const wav = (pcm16: Uint8Array, channels: number) => buildWav({ pcm16, sampleRate: RATE, channels });
  // Party A speaks in blocks 1 and 3, party B in block 2 — disjoint in time, like a real call.
  const talk = concat([tone(600), silence(600, RATE), tone(600)]);
  const reply = concat([silence(600, RATE), tone(600, 330), silence(600, RATE)]);
  const twoParty = wav(interleaveStereo(talk, reply), 2);
  const dualMono = wav(interleaveStereo(talk, talk), 2);
  const oneSilent = wav(interleaveStereo(talk, new Uint8Array(talk.length)), 2);
  const correlated = wav(interleaveStereo(tone(1800, 220), tone(1800, 250, 6000)), 2);
  const monoWav = wav(talk, 1);

  head('Channel layout — stereo is read from the bytes, and dual-mono is not mistaken for two parties');
  {
    const layout = (b: Uint8Array) => detectChannelLayout(b).layout;
    check('a mono WAV reports mono', layout(monoWav) === 'mono', layout(monoWav));
    check('true one-party-per-channel stereo is detected', layout(twoParty) === 'two-party-stereo', layout(twoParty));
    // The trap: a mono call exported as stereo. channel:true here attributes half the call to the
    // wrong person, and the transcript still looks plausible.
    check('THE DUAL-MONO TRAP: identical channels are NOT two parties', layout(dualMono) === 'dual-mono', layout(dualMono));
    check('a stereo file with one silent channel is not two parties', layout(oneSilent) === 'one-silent', layout(oneSilent));
    check('both-channels-always-active stereo is not claimed as two parties', layout(correlated) === 'correlated-stereo', layout(correlated));

    const mp3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0, 0]);
    check('an MP3 cannot be judged without decoding, and says so', layout(mp3) === 'unknown' && detectChannelLayout(mp3).channels === null);
    check('an Ogg upload reports unknown rather than throwing', layout(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0, 0, 0, 0, 0])) === 'unknown');
    check('a truncated WAV reports unknown rather than throwing', layout(twoParty.subarray(0, 30)) === 'unknown');

    const patched = (src: Uint8Array, off: number, val: number, bytes16 = true) => {
      const c = new Uint8Array(src);
      const v = new DataView(c.buffer);
      if (bytes16) v.setUint16(off, val, true); else v.setUint32(off, val, true);
      return c;
    };
    const twentyFour = patched(twoParty, 34, 24);
    check('a 24-bit stereo WAV is not analysed, and the detail names the depth',
      layout(twentyFour) === 'unknown' && detectChannelLayout(twentyFour).detail.includes('24-bit'));
    check('a 4-channel WAV is not treated as two-party', layout(patched(twoParty, 22, 4)) === 'multichannel');

    const big = wav(interleaveStereo(concat([talk, talk, talk, talk]), concat([reply, reply, reply, reply])), 2);
    const bounded = detectChannelLayout(big, 1000);
    check('detection is bounded by maxFrames', (bounded.stats?.framesExamined ?? 0) <= 1001, String(bounded.stats?.framesExamined));
    check('stride is at least 1', (bounded.stats?.strideFrames ?? 0) >= 1);
    const t0 = Date.now();
    detectChannelLayout(big);
    check('detection does not scale with file size', Date.now() - t0 < 250, `${Date.now() - t0}ms`);

    check('readWavHeader never throws on garbage', readWavHeader(new Uint8Array(16)) === null);
    let msg = '';
    try { parseWav(new Uint8Array([1, 2, 3])); } catch (e) { msg = (e as Error).message; }
    check('parseWav still throws on non-RIFF after the refactor', msg === 'not a RIFF/WAVE file', msg);
    msg = '';
    try { parseWav(twentyFour); } catch (e) { msg = (e as Error).message; }
    check('parseWav still throws on non-16-bit after the refactor', msg === 'expected 16-bit PCM, got 24-bit', msg);
    // pyai-speak returns a streaming WAV with both sizes 0xFFFFFFFF; losing this clamp would read
    // far past the buffer and would only show up as corrupt sample audio.
    const streaming = patched(twoParty, 40, 0xffffffff, false);
    check('THE STREAMING-WAV CLAMP SURVIVES: 0xFFFFFFFF reads only the bytes that arrived',
      parseWav(streaming).pcm16.length === twoParty.length - 44);
  }

  head('Separation resolution — auto picks the exact mode only when it can prove it');
  {
    const auto = (b: Uint8Array) => resolveSeparation(b, 'auto');
    check('auto on true stereo resolves to channel', auto(twoParty).mode === 'channel' && auto(twoParty).auto === true);
    check('auto on dual-mono resolves to diarize, not channel', auto(dualMono).mode === 'diarize', auto(dualMono).mode);
    check('auto on one-silent stereo resolves to diarize', auto(oneSilent).mode === 'diarize');
    check('auto on correlated stereo resolves to diarize', auto(correlated).mode === 'diarize');
    check('auto on mono resolves to diarize', auto(monoWav).mode === 'diarize');
    check('auto on an MP3 resolves to diarize', auto(new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0, 0])).mode === 'diarize');

    const forced = resolveSeparation(dualMono, 'channel');
    check('an explicit channel request is never overridden by detection', forced.mode === 'channel' && forced.auto === false);
    check('and the disagreement is stated rather than hidden', forced.reason.includes('diarize'), forced.reason);
    check('an explicit diarize request on true stereo is honoured', resolveSeparation(twoParty, 'diarize').mode === 'diarize');
    check('the resolved mode is always concrete',
      [twoParty, dualMono, monoWav].every((b) => SeparationModeSchema.safeParse(auto(b).mode).success));
  }

  head('Mode validation — the form field is validated, not cast');
  {
    // Each of these would have sailed through `as SeparationMode` into pyai-jobs.ts's bare `else`
    // and silently diarized, indistinguishable from a deliberate choice.
    for (const bad of ['stereo', 'CHANNEL', '', 'true']) {
      check(`"${bad}" is rejected`, !RequestedSeparationSchema.safeParse(bad).success);
    }
    check('auto / channel / diarize are accepted',
      ['auto', 'channel', 'diarize'].every((m) => RequestedSeparationSchema.safeParse(m).success));
  }

  head('Speaker mapping — the lookup key cannot diverge from the map key');
  {
    const seg = (start: number, speaker?: string, channel?: number) => ({
      id: 0, start, end: start + 1, text: 'hello', ...(speaker ? { speaker } : {}), ...(channel !== undefined ? { channel } : {}),
    });
    const chan = mapSegments([seg(0, 'speaker_1', 0), seg(1, 'speaker_2', 1)] as never, 'channel');
    check('channel mode maps channel 0 to rep and channel 1 to prospect',
      chan[0].speaker === 'rep' && chan[1].speaker === 'prospect', chan.map((c) => c.speaker).join(','));

    // The second independent cause of the reported bug: one shared label used to collapse every
    // segment onto whichever role was written to the map last.
    const shared = mapSegments([seg(0, 'speaker_1', 0), seg(1, 'speaker_1', 1)] as never, 'channel');
    check('REGRESSION: channel mode is keyed by channel, so one shared label still yields two roles',
      shared[0].speaker === 'rep' && shared[1].speaker === 'prospect', shared.map((c) => c.speaker).join(','));

    // Diarize returns no channel, so the old lookup key was the literal "channel_undefined".
    const unlabelled = mapSegments([seg(0), seg(1)] as never, 'diarize');
    check('REGRESSION: a diarized segment with no speaker label is not "unknown"',
      unlabelled.every((u) => u.speaker !== 'unknown'), unlabelled.map((u) => u.speaker).join(','));

    const ordered = mapSegments([seg(5, 'b', 1), seg(0, 'a', 0)] as never, 'channel');
    check('segments are ordered by start and ids assigned once',
      ordered[0].id === 'seg_000' && ordered[0].start_ms === 0 && ordered[1].id === 'seg_001');
  }

  d.prepare(`DELETE FROM runs WHERE call_id LIKE ? OR id LIKE ?`).run(`${TEST_PREFIX}%`, `${TEST_PREFIX}%`);

  console.log(
    failures === 0
      ? '\n\x1b[32m\x1b[1mAll harness checks passed.\x1b[0m Budgets stop runs, retries are bounded and aimed, writes serialise, and no run vanishes.\n'
      : `\n\x1b[31m\x1b[1m${failures} check(s) FAILED.\x1b[0m\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\n\x1b[31mtest-harness crashed: ${e instanceof Error ? e.stack : String(e)}\x1b[0m\n`);
  process.exit(1);
});
