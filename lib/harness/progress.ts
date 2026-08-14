/**
 * Progress events — the harness's only outward narration.
 *
 * Deliberately not a logger and not a return value: it is a fire-and-forget callback the harness
 * may call zero times without changing a single outcome. `processCall` behaves identically with and
 * without a listener, which is what makes it safe to add to a pipeline whose whole claim is that
 * every run ends in exactly one recorded status.
 */
export type StageName = 'upload' | 'transcribe' | 'extract' | 'gate';

export type StageEvent =
  | { t: 'run'; callId: string; runId: string }
  | { t: 'stage'; stage: StageName; state: 'start'; attempt?: number }
  | { t: 'stage'; stage: StageName; state: 'done'; ms: number; detail?: string }
  | { t: 'stage'; stage: StageName; state: 'retry'; attempt: number; reason: string };

export type OnStage = (e: StageEvent) => void;

/**
 * Never let a listener's bug become a run's failure.
 *
 * `onStage` is invoked from inside `processCall`'s try block, so a throwing listener would be
 * caught by the catch that exists to classify *pipeline* failures and recorded as a failed run.
 * A progress callback must not be able to do that, so it is wrapped once at the top.
 */
export const safeStage =
  (fn?: OnStage): OnStage =>
  (e) => {
    try {
      fn?.(e);
    } catch {
      /* a listener that throws is not the run's problem */
    }
  };

// ─────────────────────────────────────────────────────────────────────────────
// The wire format, shared by every client
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What `POST /api/calls` streams when asked for `application/x-ndjson`.
 *
 * This lived inside `components/UploadCard.tsx` — a `'use client'` file — which was fine while the
 * browser was the only client. It is not fine now that the terminal UI reads the same stream: a
 * non-React consumer cannot import from a client component without dragging React in, and the
 * alternative (a second hand-maintained copy of the union) is how two clients start disagreeing about
 * what the server sends.
 *
 * `ProcessOutcome` is referenced as a TYPE only, so neither the harness nor `node:sqlite` follows this
 * module into the client bundle.
 *
 *   open    1KB of padding. WebKit will not surface a streamed response until ~1KB has arrived.
 *   expect  the median duration of recent runs, or null until enough runs exist to have a median.
 *   tick    a 5s liveness heartbeat, so a long stage is distinguishable from a dead socket.
 *   result  terminal, success. `error` is terminal, failure.
 *
 * A stream that simply ENDS, with neither `result` nor `error`, is itself a failure signal — and the
 * run keeps going server-side, because cancelling the response deliberately does not abort the work.
 */
export type UploadEvent =
  | { t: 'open'; pad: string }
  | { t: 'expect'; totalMs: number | null }
  | { t: 'tick'; at: number }
  | (StageEvent & { at: number })
  | { t: 'result'; at: number; outcome: import('./loop').ProcessOutcome }
  | { t: 'error'; at: number; message: string };

/** One row of the four-stage progress display, in the order the pipeline runs them. */
export type StageView = {
  key: StageName;
  label: string;
  /**
   * `failed` is never produced by `applyStage` — the harness has no per-stage failure event, because a
   * failure ends the whole run. It exists because the renderer sets it when the stream dies, and it is
   * kept in the shared type so a client cannot represent that state in its own incompatible way.
   */
  state: 'pending' | 'running' | 'done' | 'failed';
  ms?: number;
  detail?: string;
  attempt?: number;
  retryReason?: string;
};

export const INITIAL_STAGES: StageView[] = [
  { key: 'upload', label: 'Uploading audio', state: 'running' },
  { key: 'transcribe', label: 'Transcribing (PyAI Hear)', state: 'pending' },
  { key: 'extract', label: 'Extracting notes', state: 'pending' },
  { key: 'gate', label: 'Checking citations', state: 'pending' },
];

/**
 * Pure reduction of one stage event onto the row list — no timers, no inference.
 *
 * Shared rather than duplicated so the terminal and the browser cannot drift on what a retry looks
 * like, which is the one transition with non-obvious behaviour: a repeated `start` for a stage means
 * an attempt is restarting, so the previous timing has to be cleared or the row shows a duration for
 * work that was thrown away.
 */
export function applyStage(prev: StageView[], ev: StageEvent & { t: 'stage' }): StageView[] {
  return prev.map((row) => {
    if (row.key !== ev.stage) return row;
    if (ev.state === 'start') {
      return { ...row, state: 'running', ms: undefined, attempt: ev.attempt };
    }
    if (ev.state === 'done') {
      return { ...row, state: 'done', ms: ev.ms, detail: ev.detail };
    }
    return { ...row, state: 'running', attempt: ev.attempt, retryReason: ev.reason };
  });
}
