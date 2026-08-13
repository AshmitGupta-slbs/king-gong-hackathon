/**
 * SAFE PARALLELISM — harness part 6.
 *
 * Independent work runs concurrently; anything that writes shared state runs one at a time.
 *
 * Concretely: two different calls can be transcribed and extracted at the same time, because
 * they touch disjoint rows. Two operations on the SAME call are serialised behind a per-call
 * lock — parallelising writes to one call's record is a race waiting to corrupt output, not a
 * performance win.
 */

const locks = new Map<string, Promise<unknown>>();

/**
 * Serialise all work for one key (we key on call id). Different keys proceed in parallel.
 * The chain is preserved even if a holder throws, so one failure cannot wedge the lock.
 */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve();
  // `.then(fn, fn)` runs regardless of how the previous holder settled, so one failure cannot
  // wedge the queue behind it.
  const next = prior.then(fn, fn);
  // The stored tail must never reject, or a later waiter would see an unhandled rejection.
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, tail);
  // Drop the entry only if we are still the tail — otherwise a queued waiter gets orphaned and
  // would start running in parallel with the current holder. Identity comparison, not a
  // truthiness check: `locks.get(key)` is always set here, so testing for undefined never fired
  // and the map grew for the lifetime of the process.
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return next;
}

/** Test/diagnostic hook: how many keys currently hold a lock chain. */
export const activeLockCount = () => locks.size;

/** Bounded-concurrency map, for independent reads (e.g. batch-processing several calls). */
export async function parallelMap<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
