/**
 * BOUNDED AIMED RETRY — harness part 3.
 *
 * Two properties make this "aimed" rather than "try again and hope":
 *
 *  1. The reason the previous attempt failed is handed to the next attempt, so it can fix the
 *     specific problem. For extraction that means the gate's actual rejection text goes into
 *     the retry prompt (see claude-extract.ts).
 *  2. Attempts are CAPPED. No loop here can run forever.
 *
 * `validate` lets a semantically-wrong-but-technically-successful result trigger a retry — which
 * is the case that matters for us: the model returned perfectly-shaped JSON citing a segment
 * that does not exist.
 */
import { DeadlineError } from './budget';

export type Attempt<T> = { value: T; attempts: number; failures: string[] };

export async function retryAimed<T>(opts: {
  attempts: number;
  /** `priorFailure` is undefined on the first attempt. */
  run: (attempt: number, priorFailure?: string) => Promise<T>;
  /** Return ok:false to spend another attempt on a semantically bad result. */
  validate?: (value: T) => { ok: boolean; reason?: string };
  /** Errors for which retrying is pointless (bad scope, bad request). */
  isFatal?: (err: unknown) => boolean;
  onRetry?: (attempt: number, reason: string) => void;
  /**
   * How long to wait before the next attempt. Defaults to a modest linear backoff, which is right
   * for a transient blip but far too short for a rate limit whose window is measured in seconds.
   * Override it to honour a server's `Retry-After`.
   */
  backoffMs?: (attempt: number, err: unknown) => number;
}): Promise<Attempt<T>> {
  const cap = Math.max(1, opts.attempts);
  const failures: string[] = [];
  let prior: string | undefined;

  for (let n = 1; n <= cap; n++) {
    try {
      const value = await opts.run(n, prior);
      const v = opts.validate?.(value) ?? { ok: true };
      if (v.ok) return { value, attempts: n, failures };

      const reason = v.reason ?? 'validation failed';
      failures.push(reason);
      if (n === cap) return { value, attempts: n, failures }; // out of attempts: return as-is
      prior = reason;
      opts.onRetry?.(n, reason);
    } catch (err) {
      // A budget deadline is never retryable — retrying is exactly what it exists to prevent.
      if (err instanceof DeadlineError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      failures.push(reason);
      if (opts.isFatal?.(err) || n === cap) throw err;
      prior = reason;
      opts.onRetry?.(n, reason);
      await new Promise((r) => setTimeout(r, opts.backoffMs?.(n, err) ?? 400 * n));
    }
  }
  // Unreachable: the loop either returns or throws.
  throw new Error('retryAimed exhausted without result');
}
