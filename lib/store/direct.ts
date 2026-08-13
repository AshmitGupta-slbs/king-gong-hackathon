/**
 * The direct backend: the real MongoDB driver.
 *
 * Every caveat the REST shim carries — non-atomic read-modify-write, sorting in memory, emulated
 * `$inc`, no real indexes — simply does not exist on this path. That is the whole argument for
 * making the URI the only thing that changes: today's gateway is a compatibility layer, and moving
 * to Atlas silently upgrades every operation to a native atomic one.
 *
 * Connection reuse matters in Next: a module-level client is shared across requests, and in dev the
 * handle is parked on `globalThis` so hot reloads do not open a new pool every save.
 */
import { MongoClient } from 'mongodb';
import { storeConfig } from './config';
import type { StoreDatabase } from './types';

type Cached = { client: MongoClient; promise: Promise<MongoClient> | null; uri: string };

const g = globalThis as unknown as { __opengongMongo?: Cached };

export function directDatabase(): StoreDatabase {
  const { uri, dbName } = storeConfig();

  if (!g.__opengongMongo || g.__opengongMongo.uri !== uri) {
    const client = new MongoClient(uri, {
      // Fail fast rather than hanging a page render for 30 seconds on a bad URI.
      serverSelectionTimeoutMS: 8_000,
      // Node ships its own CA bundle, so Atlas TLS needs no extra certificate configuration.
    });
    g.__opengongMongo = { client, promise: null, uri };
  }
  const cached = g.__opengongMongo;

  /**
   * `connect()` is idempotent in the driver and the operations queue behind it, so callers do not
   * have to await a connection before issuing a query. Kicking it off once here means the very
   * first request pays the handshake instead of every request racing to open one.
   */
  if (!cached.promise) {
    cached.promise = cached.client.connect().catch((err: unknown) => {
      // Let the next call retry rather than caching a rejected promise forever.
      cached.promise = null;
      throw err;
    });
  }

  // The driver's own Database/Collection already satisfies StoreDatabase — no wrapper, no
  // translation layer, and therefore nowhere for a translation bug to live.
  return cached.client.db(dbName) as unknown as StoreDatabase;
}

/** Close the pool. Only scripts need this; the server keeps it open for the process lifetime. */
export async function closeDirect(): Promise<void> {
  if (!g.__opengongMongo) return;
  const { client } = g.__opengongMongo;
  g.__opengongMongo = undefined;
  await client.close();
}
