/**
 * Storage entry point. The rest of the app asks for a database and does not learn which one it got.
 *
 *   const db = getDatabase();
 *   await db.collection(collections().calls).insertOne({ _id: 'abc', title: 'x' });
 *
 * `backend()` reports `'direct' | 'rest' | 'none'` for diagnostics, and `'none'` is a real,
 * supported state rather than an error: with no `MONGODB_URI` the app runs on local SQLite, which
 * is what keeps `npm run dev` working on an empty environment — a promise this repo makes
 * explicitly and `check:ship` enforces.
 */
import { backend, storeConfig } from './config';
import { directDatabase } from './direct';
import { restDatabase } from './rest';
import { collections } from './names';
import type { StoreDatabase } from './types';

export { backend, storeConfig, collections };
export type { StoreCollection, StoreCursor, StoreDatabase, Doc, Filter, UpdateDoc } from './types';

/**
 * The database handle.
 *
 * Throws in `'none'` mode rather than returning something half-working: a caller that reaches here
 * without Mongo configured has taken a wrong branch, and a silent no-op store would lose writes
 * without telling anyone. Callers check `backend()` first — `lib/db.ts` does exactly that.
 */
export function getDatabase(): StoreDatabase {
  const b = backend();
  if (b === 'direct') return directDatabase();
  if (b === 'rest') return restDatabase();
  throw new Error(
    'No MONGODB_URI is configured, so there is no Mongo database to return. ' +
      'Check backend() before calling getDatabase(); with no URI the app uses local SQLite.',
  );
}

/** Async accessor, for symmetry with the spec's dependency-injection shape. */
export async function getDb(): Promise<StoreDatabase> {
  return getDatabase();
}

/**
 * Create the indexes the app's queries rely on.
 *
 * A no-op on REST (the gateway owns its own indexes) and skipped entirely with no URI. Safe to call
 * repeatedly — `createIndex` is idempotent for an identical specification.
 */
export async function ensureIndexes(): Promise<{ created: number; skipped: boolean }> {
  const b = backend();
  if (b !== 'direct') return { created: 0, skipped: true };

  const db = getDatabase();
  const c = collections();
  const specs: [string, Record<string, 1 | -1>][] = [
    [c.calls, { created_at: -1 }],
    [c.calls, { share_id: 1 }],
    [c.segments, { call_id: 1, seq: 1 }],
    // No extractions entry: the collection is keyed on `_id` (the call id), which Mongo indexes
    // automatically. It used to declare `{ call_id: 1 }` — a field this store has never written.
    [c.runs, { started_at: -1 }],
    [c.runs, { status: 1, started_at: -1 }],
    [c.gateRejections, { call_id: 1 }],
    [c.usageEvents, { created_at: -1 }],
    [c.companies, { name: 1 }],
    [c.callCompanies, { call_id: 1 }],
    [c.companyLearnings, { company_id: 1, created_at: -1 }],
    [c.companyLearnings, { call_id: 1 }],
    // Both reads this collection serves: everything for an account, and the open subset the next
    // call is asked about.
    [c.actionItems, { company_id: 1, created_at: -1 }],
    [c.actionItems, { company_id: 1, status: 1 }],
  ];
  for (const [name, spec] of specs) await db.collection(name).createIndex(spec);
  return { created: specs.length, skipped: false };
}

/** One line describing where data is going, for `check:store` and the UI's honesty footer. */
export function describeStore() {
  const { backend: b, dbName, prefix, uri } = storeConfig();
  return {
    backend: b,
    detail:
      b === 'direct'
        ? `MongoDB · ${dbName} · collections prefixed "${prefix}"`
        : b === 'rest'
          ? `MongoDB via REST gateway (${new URL(uri).host}) · ${dbName} · prefix "${prefix}"`
          : 'local SQLite (data/opengong.db) — set MONGODB_URI to use MongoDB',
    durable: b !== 'none',
  };
}
