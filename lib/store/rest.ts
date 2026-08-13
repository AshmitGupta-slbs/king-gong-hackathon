/**
 * The REST backend: a compatibility shim that makes an HTTP gateway behave like a Mongo collection.
 *
 * ⚠️ UNVERIFIED AGAINST A LIVE GATEWAY. The endpoint PATHS below are specified; the request and
 * response BODY shapes are not documented anywhere I could read, so `REQUEST_SHAPE` and
 * `readRows()` encode the most probable contract and are isolated at the top of this file so they
 * are a two-minute fix rather than an archaeology exercise once the real shapes are known. Until
 * this has been run against the gateway, prefer a `mongodb+srv://` URI — see direct.ts.
 *
 * The gateway is a filter-only store, so this file makes up the difference. Every one of these
 * compromises disappears the moment MONGODB_URI is a real driver string:
 *
 *   • `_id` is stripped by the gateway → mirrored to `id` on write, restored on read, and rewritten
 *     inside filters.
 *   • datetimes are not a JSON type → ISO-8601 on the way out, parsed back on the way in.
 *   • the gateway does not sort, limit or project → all three are applied here, AFTER fetching.
 *   • `$inc` is emulated by read-modify-write, so it is safe only for single-document use.
 *   • `findOneAndUpdate` is find-then-update and therefore NOT ATOMIC — two writers can interleave.
 *     The app must run a single worker on this backend.
 *   • `createIndex` is a no-op.
 *   • `deleteMany` is best-effort.
 */
import { storeConfig } from './config';
import type {
  Doc,
  Filter,
  Projection,
  StoreCollection,
  StoreCursor,
  StoreDatabase,
  UpdateDoc,
} from './types';

// ── the parts most likely to need correcting against the real gateway ────────

/** Path suffixes, from the specification. */
const PATHS = {
  base: '/agent_chat/query_mongo/',
  query: 'query/',
  insert: 'insert_data_mongo/',
  update: 'update_data_mongo/',
  remove: 'delete_data_mongo/',
} as const;

/** The body every endpoint receives. Adjust here if the gateway names its fields differently. */
const REQUEST_SHAPE = (collection: string, extra: Doc): Doc => {
  const { dbName } = storeConfig();
  return { db: dbName, database: dbName, collection, ...extra };
};

/** Pull the row array out of whatever envelope the gateway returns. */
function readRows(payload: unknown): Doc[] {
  if (Array.isArray(payload)) return payload as Doc[];
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    for (const key of ['data', 'result', 'results', 'documents', 'rows']) {
      if (Array.isArray(p[key])) return p[key] as Doc[];
    }
  }
  return [];
}

// ── value coercion ───────────────────────────────────────────────────────────

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Dates are not a JSON type; send ISO strings and rename `_id` to the field the gateway keeps. */
function encode(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') {
    const out: Doc = {};
    for (const [k, v] of Object.entries(value as Doc)) out[k === '_id' ? 'id' : k] = encode(v);
    return out;
  }
  return value;
}

/** The mirror image: `id` becomes `_id` again, and ISO strings become Dates. */
function decode(value: unknown): unknown {
  if (typeof value === 'string') return ISO.test(value) ? new Date(value) : value;
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') {
    const out: Doc = {};
    for (const [k, v] of Object.entries(value as Doc)) out[k] = decode(v);
    if ('id' in out && !('_id' in out)) out._id = out.id;
    return out;
  }
  return value;
}

const project = (doc: Doc, projection: Projection): Doc => {
  if (!projection) return doc;
  const keys = Object.entries(projection);
  const including = keys.some(([, v]) => v === 1);
  const out: Doc = {};
  for (const [k, v] of Object.entries(doc)) {
    const rule = projection[k];
    if (including ? rule === 1 || k === '_id' : rule !== 0) out[k] = v;
  }
  return out;
};

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

// ── the client ───────────────────────────────────────────────────────────────

export class RestStoreError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'RestStoreError';
  }
}

async function post(endpoint: string, body: Doc): Promise<unknown> {
  const { uri, restTimeoutSecs } = storeConfig();
  const url = `${uri.replace(/\/+$/, '')}${PATHS.base}${endpoint}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(restTimeoutSecs * 1000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new RestStoreError(res.status, url, `Mongo REST gateway ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json().catch(() => ({}));
}

class RestCursor<T extends Doc> implements StoreCursor<T> {
  private sortKey: Record<string, 1 | -1> | null = null;
  private max: number | null = null;

  constructor(
    private readonly load: () => Promise<T[]>,
    private readonly projection: Projection,
  ) {}

  sort(key: string | Record<string, 1 | -1>, direction: 1 | -1 = 1) {
    this.sortKey = typeof key === 'string' ? { [key]: direction } : key;
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }

  /** Sort, limit and project happen HERE because the gateway only filters. */
  async toArray(): Promise<T[]> {
    let rows = await this.load();
    if (this.sortKey) {
      const entries = Object.entries(this.sortKey);
      rows = [...rows].sort((a, b) => {
        for (const [k, dir] of entries) {
          const c = compare(a[k], b[k]);
          if (c !== 0) return dir === -1 ? -c : c;
        }
        return 0;
      });
    }
    if (this.max !== null) rows = rows.slice(0, this.max);
    return this.projection ? (rows.map((r) => project(r, this.projection)) as T[]) : rows;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (const row of await this.toArray()) yield row;
  }
}

class RestCollection<T extends Doc> implements StoreCollection<T> {
  constructor(private readonly name: string) {}

  private async fetchAll(filter: Filter): Promise<T[]> {
    const payload = await post(PATHS.query, REQUEST_SHAPE(this.name, { query: encode(filter) as Doc, filter: encode(filter) as Doc }));
    return readRows(payload).map((r) => decode(r) as T);
  }

  find(filter: Filter = {}, options?: { projection?: Projection }): StoreCursor<T> {
    return new RestCursor<T>(() => this.fetchAll(filter), options?.projection);
  }

  async findOne(filter: Filter = {}, options?: { projection?: Projection }): Promise<T | null> {
    const rows = await this.find(filter, options).limit(1).toArray();
    return rows[0] ?? null;
  }

  async countDocuments(filter: Filter = {}): Promise<number> {
    return (await this.fetchAll(filter)).length;
  }

  async insertOne(doc: T) {
    return post(PATHS.insert, REQUEST_SHAPE(this.name, { data: encode(doc) as Doc }));
  }

  async insertMany(docs: T[]) {
    // Sequential rather than one batched call: the gateway's batch shape is unknown, and N small
    // writes that work beat one large write that silently does nothing.
    for (const d of docs) await this.insertOne(d);
    return { insertedCount: docs.length };
  }

  private applyUpdate(existing: Doc, update: UpdateDoc): Doc {
    const next: Doc = { ...existing, ...(update.$set ?? {}) };
    // $inc emulated by read-modify-write — safe for single-document counters only.
    for (const [k, delta] of Object.entries(update.$inc ?? {})) {
      next[k] = (typeof existing[k] === 'number' ? (existing[k] as number) : 0) + delta;
    }
    return next;
  }

  async updateOne(filter: Filter, update: UpdateDoc, options?: { upsert?: boolean }) {
    const existing = await this.findOne(filter);
    if (!existing) {
      if (!options?.upsert) return { matchedCount: 0, modifiedCount: 0 };
      const seeded = { ...filter, ...(update.$setOnInsert ?? {}), ...(update.$set ?? {}) } as T;
      await this.insertOne(seeded);
      return { matchedCount: 0, upsertedCount: 1 };
    }
    const next = this.applyUpdate(existing, update);
    await post(
      PATHS.update,
      REQUEST_SHAPE(this.name, { query: encode(filter) as Doc, filter: encode(filter) as Doc, data: encode(next) as Doc, update: encode(next) as Doc }),
    );
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async updateMany(filter: Filter, update: UpdateDoc, options?: { upsert?: boolean }) {
    const rows = await this.fetchAll(filter);
    if (rows.length === 0 && options?.upsert) return this.updateOne(filter, update, options);
    for (const row of rows) {
      const id = row._id ?? row.id;
      await this.updateOne({ _id: id } as Filter, update);
    }
    return { matchedCount: rows.length, modifiedCount: rows.length };
  }

  /** Best-effort: a gateway without a delete endpoint should not take the caller down. */
  async deleteMany(filter: Filter) {
    try {
      await post(PATHS.remove, REQUEST_SHAPE(this.name, { query: encode(filter) as Doc, filter: encode(filter) as Doc }));
      return { acknowledged: true };
    } catch {
      return { acknowledged: false };
    }
  }

  /** NOT ATOMIC on this backend — find, then update. Single-worker deployments only. */
  async findOneAndUpdate(
    filter: Filter,
    update: UpdateDoc,
    options?: { sort?: Record<string, 1 | -1>; returnDocument?: 'before' | 'after'; upsert?: boolean },
  ): Promise<T | null> {
    const cursor = this.find(filter);
    if (options?.sort) cursor.sort(options.sort);
    const before = (await cursor.limit(1).toArray())[0] ?? null;

    if (!before) {
      if (!options?.upsert) return null;
      await this.updateOne(filter, update, { upsert: true });
      return (await this.findOne(filter)) ?? null;
    }
    const id = before._id ?? before.id;
    await this.updateOne({ _id: id } as Filter, update);
    return options?.returnDocument === 'after'
      ? ((await this.findOne({ _id: id } as Filter)) as T | null)
      : before;
  }

  /** A no-op: the gateway owns its own indexes. Resolved so callers need no backend check. */
  async createIndex() {
    return 'noop-rest';
  }
}

export function restDatabase(): StoreDatabase {
  return {
    collection<T extends Doc = Doc>(name: string): StoreCollection<T> {
      return new RestCollection<T>(name);
    },
  };
}
