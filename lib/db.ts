/**
 * Storage — one API, two backends, chosen by `MONGODB_URI`.
 *
 * This file used to BE the SQLite implementation. It is now the dispatcher: the SQL moved to
 * `db-sqlite.ts` unchanged, `db-mongo.ts` implements the same contract over MongoDB, and everything
 * below picks one and forwards. Call sites did not have to learn anything new — the function names
 * and their meanings are exactly what they were, they are just `await`ed now.
 *
 * WHY BOTH. The SQLite path is the zero-setup promise: `npm run dev` on an empty environment has to
 * work, and it does, with no service to run and nothing to compile. The Mongo path is durability:
 * a container filesystem is ephemeral, so on a host like Railway the SQLite file — and everything a
 * user typed into /setup or uploaded — is wiped on the next redeploy.
 *
 * Everything is async even on the SQLite side, where the underlying driver is synchronous. If the
 * fast path were sync, every call site would be written against the sync shape and swapping
 * backends would stop being an environment variable.
 */
import { backend, ensureIndexes } from './store';
import { db as sqliteHandle, sqliteStore } from './db-sqlite';
import { mongoStore } from './db-mongo';
import type { Store } from './db-types';

export type { RunRow, UsageTotals } from './db-types';

/**
 * The active store.
 *
 * Resolved per call rather than once at module load: the environment is not reliably populated at
 * import time in Next, and a store captured too early would pin the process to SQLite even after
 * `MONGODB_URI` became visible.
 */
/**
 * Indexes are created once per process, on first Mongo use.
 *
 * Not awaited by callers: a missing index makes a query slower, never wrong, so blocking every
 * first request on DDL would trade correctness-neutral latency for real latency. Failures are
 * swallowed for the same reason — an index that could not be created must not take down a page
 * that would have worked without it.
 */
let indexing: Promise<unknown> | null = null;

export function store(): Store {
  if (backend() === 'none') return sqliteStore;
  if (!indexing) indexing = ensureIndexes().catch(() => undefined);
  return mongoStore;
}

/**
 * The raw SQLite handle.
 *
 * Kept for the harness test suite, which pokes the database directly to prove the failure
 * invariant. Meaningless in Mongo mode — nothing on the request path uses it.
 */
export const db = sqliteHandle;

// ── calls ────────────────────────────────────────────────────────────────────
export const insertCall = (...a: Parameters<Store['insertCall']>) => store().insertCall(...a);
export const renameCall = (...a: Parameters<Store['renameCall']>) => store().renameCall(...a);
export const getCall = (...a: Parameters<Store['getCall']>) => store().getCall(...a);
export const getCallByShareId = (...a: Parameters<Store['getCallByShareId']>) =>
  store().getCallByShareId(...a);
export const listCalls = () => store().listCalls();

// ── segments ─────────────────────────────────────────────────────────────────
export const replaceSegments = (...a: Parameters<Store['replaceSegments']>) =>
  store().replaceSegments(...a);
export const getSegments = (...a: Parameters<Store['getSegments']>) => store().getSegments(...a);

// ── extractions ──────────────────────────────────────────────────────────────
export const saveExtraction = (...a: Parameters<Store['saveExtraction']>) =>
  store().saveExtraction(...a);
export const getExtraction = (...a: Parameters<Store['getExtraction']>) =>
  store().getExtraction(...a);

// ── runs (failure invariant) ─────────────────────────────────────────────────
export const openRun = (...a: Parameters<Store['openRun']>) => store().openRun(...a);
export const closeRun = (...a: Parameters<Store['closeRun']>) => store().closeRun(...a);
export const listRuns = (...a: Parameters<Store['listRuns']>) => store().listRuns(...a);
export const medianRecentRunMs = (...a: Parameters<Store['medianRecentRunMs']>) =>
  store().medianRecentRunMs(...a);
export const reconcileOrphanRuns = () => store().reconcileOrphanRuns();

// ── gate rejections ──────────────────────────────────────────────────────────
export const recordRejections = (...a: Parameters<Store['recordRejections']>) =>
  store().recordRejections(...a);
export const countRejections = () => store().countRejections();

// ── usage (API gravity) ──────────────────────────────────────────────────────
export const recordUsage = (...a: Parameters<Store['recordUsage']>) => store().recordUsage(...a);
export const usageTotals = () => store().usageTotals();
