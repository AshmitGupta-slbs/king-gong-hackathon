/**
 * Analysing a call from the terminal, by asking the app to do it.
 *
 * ── Why HTTP and not a direct call to processCall() ──
 *
 * Two reasons, and the second is the one that actually decides it.
 *
 * 1. `app/api/calls/route.ts` already owns the whole ingest path: multipart parsing, fetching a pasted
 *    https URL server-side, writing audio outside `public/` (where Next would 404 it in production),
 *    resolving the separation mode from the audio bytes rather than from a form default, and mapping
 *    provider failures to remedies a human can act on. Calling processCall() directly would mean
 *    reimplementing all of that here, and then maintaining two copies that slowly disagree.
 *
 * 2. SQLite. `lib/db-sqlite.ts` runs in WAL mode, so a second process can safely READ while the dev
 *    server writes. Two concurrent WRITERS is a different matter: `withLock` in lib/harness/parallel.ts
 *    is a module-level Map, so it serialises calls within one process and does nothing across two. A
 *    losing writer would get SQLITE_BUSY, and because processCall opens its run row before doing any
 *    work, that leaves a row stuck in 'running'. Keeping the dev server as the only writer removes the
 *    problem rather than mitigating it.
 *
 * Reads still go direct (see kg.ts) so browsing works with nothing running.
 */
import { readNdjson } from '@/lib/ndjson';
import { applyStage, INITIAL_STAGES, type StageView, type UploadEvent } from '@/lib/harness/progress';
import type { ProcessOutcome } from '@/lib/harness/loop';
import { c, mmss } from '../_ui';

const PORT = Number(process.env.PORT || 3000);
export const BASE = `http://localhost:${PORT}`;

/** Is the app already answering? Cheap, and distinguishes "not running" from "running but broken". */
export async function serverUp(base = BASE): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/usage`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Start `next dev` and wait for it to answer.
 *
 * Detached and with output discarded on purpose: this is a convenience so `./kg analyse` works as one
 * command, not a process supervisor. It prints what it started so the reader knows a server is now
 * running that they did not start, and how to see it.
 */
export async function ensureServer(): Promise<{ started: boolean; ok: boolean }> {
  if (await serverUp()) return { started: false, ok: true };

  console.log(c.dim(`  no app on ${BASE} - starting one (npm run dev)`));
  const { spawn } = await import('node:child_process');
  const child = spawn('npm', ['run', 'dev'], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();

  // First compile of a Next app is slow; 90s is generous rather than optimistic.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_000));
    if (await serverUp()) {
      console.log(c.dim(`  app is up at ${BASE}`));
      return { started: true, ok: true };
    }
  }
  return { started: true, ok: false };
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** Repaint the four stage rows in place, so progress reads as a status board, not a scrolling log. */
function paintStages(rows: StageView[], firstPaint: boolean) {
  if (!firstPaint && process.stdout.isTTY) {
    // Move the cursor back up over the rows we drew last time and overwrite them.
    process.stdout.write(`\x1b[${rows.length}A`);
  }
  for (const row of rows) {
    const glyph =
      row.state === 'done'
        ? c.ok('*')
        : row.state === 'running'
          ? c.warn('>')
          : row.state === 'failed'
            ? c.bad('x')
            : c.dim('.');
    const timing = row.ms !== undefined ? c.dim(` ${secs(row.ms)}`) : '';
    const detail = row.detail ? c.dim(`  ${row.detail}`) : '';
    const retry =
      row.retryReason && row.state === 'running'
        ? c.warn(`  retry ${row.attempt ?? ''}: ${row.retryReason}`)
        : '';
    // Clear to end of line, or a shorter repaint leaves fragments of the previous one behind.
    process.stdout.write(`  ${glyph} ${row.label}${timing}${detail}${retry}\x1b[K\n`);
  }
}

export type AnalyseInput = {
  /** A local path or an https URL; the route accepts either. */
  source: string;
  title?: string;
  engine?: string;
  companyId?: string;
  mode?: string;
};

/**
 * POST the call and narrate the stream.
 *
 * `Accept: application/x-ndjson` is what opts into progress events; without it the route returns a
 * single JSON object at the end. `readNdjson` handles the framing, including multi-byte characters
 * split across chunks, and throws if the stream stops mid-event.
 */
export async function analyse(input: AnalyseInput): Promise<ProcessOutcome | null> {
  const form = new FormData();
  if (/^https:\/\//.test(input.source)) {
    form.set('url', input.source);
  } else {
    const { readFileSync, existsSync } = await import('node:fs');
    const { basename } = await import('node:path');
    if (!existsSync(input.source)) {
      console.log(`  ${c.bad(`No such file: ${input.source}`)}`);
      return null;
    }
    const bytes = readFileSync(input.source);
    form.set('audio', new Blob([bytes]), basename(input.source));
  }
  form.set('title', input.title || 'Untitled call');
  form.set('mode', input.mode || 'auto');
  if (input.engine) form.set('engine', input.engine);
  if (input.companyId) form.set('companyId', input.companyId);

  const res = await fetch(`${BASE}/api/calls`, {
    method: 'POST',
    headers: { Accept: 'application/x-ndjson' },
    body: form,
  });

  if (!res.ok || !res.body) {
    // A failure before the first byte still has a real status and a JSON body.
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* non-JSON */
    }
    console.log(`  ${c.bad(detail)}`);
    return null;
  }

  let rows = INITIAL_STAGES.map((r) => ({ ...r }));
  let painted = false;
  let expected: number | null = null;
  let outcome: ProcessOutcome | null = null;
  let failure: string | null = null;

  paintStages(rows, true);
  painted = true;

  for await (const ev of readNdjson<UploadEvent>(res.body)) {
    if (ev.t === 'open') continue;
    if (ev.t === 'expect') {
      expected = ev.totalMs;
      continue;
    }
    if (ev.t === 'tick') continue;
    if (ev.t === 'stage') {
      rows = applyStage(rows, ev);
      paintStages(rows, !painted);
      continue;
    }
    if (ev.t === 'run') continue;
    if (ev.t === 'result') {
      outcome = ev.outcome;
      break;
    }
    if (ev.t === 'error') {
      failure = ev.message;
      break;
    }
  }

  if (failure) {
    console.log(`\n  ${c.bad(failure)}`);
    return null;
  }
  if (!outcome) {
    /*
      The stream ended without a terminal event. That is itself the signal, and it does NOT mean the
      run stopped: the route deliberately does not abort the work when the response is cancelled, so
      the call may well finish and appear in `./kg calls` shortly.
    */
    console.log(
      `\n  ${c.warn('The connection ended before the run reported a result.')}\n  ` +
        c.dim('The run keeps going server-side - check ./kg calls in a moment.'),
    );
    return null;
  }

  if (expected !== null) console.log(c.dim(`  (median recent run: ${mmss(expected)})`));
  return outcome;
}
