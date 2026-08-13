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
import { db, closeRun, getSegments, listRuns, openRun, reconcileOrphanRuns } from '@/lib/db';
import { BudgetGovernor, DeadlineError, estimateTokens } from '@/lib/harness/budget';
import { processCall } from '@/lib/harness/loop';
import { activeLockCount, parallelMap, withLock } from '@/lib/harness/parallel';
import { retryAimed } from '@/lib/harness/retry';
import { audioUploadIdentity, buildWav, silence, sniffAudioFormat } from '@/lib/wav';

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
    openRun(orphanId, `${TEST_PREFIX}call`, 'ingest+extract+gate');
    // Simulate a process killed mid-run: the row exists, still marked running, and is stale.
    db()
      .prepare(`UPDATE runs SET started_at = ? WHERE id = ?`)
      .run(Date.now() - 30 * 60_000, orphanId);

    const reconciled = reconcileOrphanRuns();
    const row = listRuns(200).find((r) => r.id === orphanId);
    check('a stale running row is reconciled on boot', reconciled >= 1, `${reconciled} reconciled`);
    check('the orphan becomes a FAILED record, not a mystery', row?.status === 'failed', row?.status);
    check('and it carries a reason', Boolean(row?.error), row?.error ?? 'no error text');

    const closedId = `${TEST_PREFIX}closed-${Date.now()}`;
    openRun(closedId, `${TEST_PREFIX}call`, 'ingest+extract+gate');
    closeRun(closedId, 'shipped', { attempts: 1 });
    const before = reconcileOrphanRuns();
    const still = listRuns(200).find((r) => r.id === closedId);
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
    check('segments were persisted', getSegments(happyId).length > 0, `${happy.segments} segments`);
    check('an extraction was produced', happy.extraction !== null);
    const happyRun = listRuns(200).find((r) => r.id === happy.runId);
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
    const badRun = listRuns(200).find((r) => r.id === bad.runId);
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
    const brokeRun = listRuns(200).find((r) => r.id === broke.runId);
    check('the deadlined run is recorded too', brokeRun?.status === 'deadline');
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
