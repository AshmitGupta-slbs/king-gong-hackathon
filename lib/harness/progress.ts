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
