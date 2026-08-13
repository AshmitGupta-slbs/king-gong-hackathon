/**
 * Storage configuration — the ONLY place these environment variables are read.
 *
 * Everything hangs off one variable, `MONGODB_URI`, and the backend is inferred from its prefix:
 *
 *   mongodb://…  |  mongodb+srv://…   → DIRECT   (the real driver, native atomic operations)
 *   anything else (an https:// URL)   → REST     (an HTTP gateway proxying to a shared cluster)
 *   unset                             → NONE     (local SQLite, which is what keeps `npm run dev`
 *                                                 working on an empty environment)
 *
 * The point of inferring rather than configuring is that swapping a REST gateway URL for a real
 * Atlas connection string later changes this one value and nothing else — no application code, no
 * call sites, no imports.
 */

export type Backend = 'direct' | 'rest' | 'none';

const trimmed = (v: string | undefined) => v?.trim() || '';

/** Read fresh each time: Next loads .env at various points and a module-init snapshot can miss it. */
export function storeConfig() {
  const uri = trimmed(process.env.MONGODB_URI);

  const backend: Backend = !uri
    ? 'none'
    : /^mongodb(\+srv)?:\/\//i.test(uri)
      ? 'direct'
      : 'rest';

  return {
    uri,
    backend,
    /** Database name. Fixed in code rather than user-facing, per the spec. */
    dbName: trimmed(process.env.MONGODB_DB) || 'opengong',
    /**
     * Prefixed onto EVERY collection name, so several apps can share one cluster without colliding.
     * Isolation depends on this being applied everywhere, which is why collection names are
     * constants in `names.ts` rather than string literals at call sites.
     */
    prefix: trimmed(process.env.MONGO_COLLECTION_PREFIX) || 'opengong_',
    /** REST-backend request timeout, seconds. */
    restTimeoutSecs: Number(trimmed(process.env.MONGO_REST_TIMEOUT_SECS)) || 20,
  };
}

export const backend = (): Backend => storeConfig().backend;
