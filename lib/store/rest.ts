/**
 * The REST backend: a MongoDB-shaped façade over the shared HTTP gateway.
 *
 * VERIFIED against the live gateway, whose OpenAPI schema is served at
 * `{MONGODB_URI}/agent_chat/query_mongo/openapi.json`. That schema is the source of truth for
 * everything below; where this file once guessed, it now matches endpoints that were actually
 * called and observed.
 *
 * The gateway turned out to be considerably more capable than a filter-only store, so several
 * compromises this file used to make are gone:
 *
 *   projection   server-side — `query/` accepts a `projection` object
 *   $inc         native — `update_data` takes real Mongo update operators
 *   indexes      real — `create_index/` and `create_compound_index/` exist
 *   count        native — `count_records/`
 *   updateMany   native — `update_many_data_mongo/`
 *   delete       native and acknowledged — `delete_data_mongo/`
 *
 * Two genuine limitations remain, and both are stated where they bite:
 *
 *   sort/limit          not accepted by `query/`, so they are applied here after fetching.
 *   findOneAndUpdate    no findAndModify endpoint, so it is find-then-update and NOT atomic.
 *                       Run a single worker against this backend.
 *
 * Two behaviours worth knowing, both established by experiment:
 *
 *   • `query/` STRIPS `_id` unless a projection is supplied — and returns it when one is, because
 *     Mongo includes `_id` in a projection by default. So every read here sends a projection (`{}`
 *     means "all fields") and `_id` comes back intact. That is why this file needs none of the
 *     `_id`→`id` mirroring a blind implementation would have required.
 *   • `insert_data_mongo/` returns HTTP 500 for every payload shape tried, including a bare
 *     document. Inserts therefore go through `replace_data_mongo/` with `upsert: true`, which is
 *     exactly equivalent for our usage and is verified working.
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

const PATHS = {
  base: '/agent_chat/query_mongo/',
  query: 'query/',
  count: 'count_records/',
  replace: 'replace_data_mongo/',
  update: 'update_data_mongo/',
  updateMany: 'update_many_data_mongo/',
  remove: 'delete_data_mongo/',
  createIndex: 'create_index/',
  createCompoundIndex: 'create_compound_index/',
} as const;

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
  const text = await res.text();
  if (!res.ok) {
    throw new RestStoreError(res.status, url, `Mongo gateway ${res.status} at ${endpoint}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

/**
 * The gateway answers a write with `{status: "successfull" | "unsuccessfull", ...}` at HTTP 200,
 * so a failed write is not an HTTP error and must be inspected. Silently treating one as success is
 * how a store loses data without anyone noticing.
 */
function assertWrote(payload: unknown, what: string): void {
  const p = (payload ?? {}) as { status?: string; message?: string; details?: string };
  if (typeof p.status === 'string' && !p.status.startsWith('success')) {
    throw new RestStoreError(200, what, `${what} failed: ${p.message ?? ''} ${p.details ?? ''}`.trim());
  }
}

/** Dates are not a JSON type. Send ISO strings; parse them back on the way in. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function encode(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') {
    const out: Doc = {};
    for (const [k, v] of Object.entries(value as Doc)) out[k] = encode(v);
    return out;
  }
  return value;
}

function decode(value: unknown): unknown {
  if (typeof value === 'string') return ISO.test(value) ? new Date(value) : value;
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') {
    const out: Doc = {};
    for (const [k, v] of Object.entries(value as Doc)) out[k] = decode(v);
    return out;
  }
  return value;
}

const readRows = (payload: unknown): Doc[] => (Array.isArray(payload) ? (payload as Doc[]) : []);

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

class RestCursor<T extends Doc> implements StoreCursor<T> {
  private sortKey: Record<string, 1 | -1> | null = null;
  private max: number | null = null;

  constructor(private readonly load: () => Promise<T[]>) {}

  sort(key: string | Record<string, 1 | -1>, direction: 1 | -1 = 1) {
    this.sortKey = typeof key === 'string' ? { [key]: direction } : key;
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }

  /** Sort and limit are the two things `query/` does not accept, so they happen here. */
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
    return this.max === null ? rows : rows.slice(0, this.max);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (const row of await this.toArray()) yield row;
  }
}

class RestCollection<T extends Doc> implements StoreCollection<T> {
  constructor(private readonly name: string) {}

  private get base(): Doc {
    return { db_name: storeConfig().dbName, collection_name: this.name };
  }

  /**
   * A projection is always sent, even when the caller wants every field.
   *
   * Without one the gateway strips `_id`, and `_id` is the primary key every read here maps back to
   * a domain object. `{}` means "all fields", and Mongo includes `_id` in a projection by default —
   * verified against the live gateway.
   */
  private async fetchAll(filter: Filter, projection: Projection): Promise<T[]> {
    const payload = await post(PATHS.query, {
      ...this.base,
      query: encode(filter) as Doc,
      projection: projection ?? {},
    });
    return readRows(payload).map((r) => decode(r) as T);
  }

  find(filter: Filter = {}, options?: { projection?: Projection }): StoreCursor<T> {
    return new RestCursor<T>(() => this.fetchAll(filter, options?.projection));
  }

  async findOne(filter: Filter = {}, options?: { projection?: Projection }): Promise<T | null> {
    // Deliberately `query/` rather than `query_single/`: the single-document endpoint strips `_id`
    // even when a projection is supplied, and the id is the one field that must survive.
    const rows = await this.fetchAll(filter, options?.projection);
    return rows[0] ?? null;
  }

  async countDocuments(filter: Filter = {}): Promise<number> {
    const payload = (await post(PATHS.count, { ...this.base, query: encode(filter) as Doc })) as {
      count?: number;
      response?: number;
    };
    return Number(payload.count ?? payload.response ?? 0);
  }

  /**
   * `insert_data_mongo/` 500s for every payload shape, so inserts go through replace+upsert, which
   * is equivalent here: every document this app writes carries its own `_id`.
   */
  async insertOne(doc: T) {
    const { _id, ...rest } = doc as Doc;
    const res = await post(PATHS.replace, {
      ...this.base,
      query: { _id: encode(_id) },
      new_object: encode({ _id, ...rest }) as Doc,
      upsert: true,
    });
    assertWrote(res, 'insertOne');
    return res;
  }

  async insertMany(docs: T[]) {
    // One call per document: the gateway has no batch endpoint, and N small writes that work beat
    // one large write that silently does nothing.
    for (const d of docs) await this.insertOne(d);
    return { insertedCount: docs.length };
  }

  async updateOne(filter: Filter, update: UpdateDoc, options?: { upsert?: boolean }) {
    const res = await post(PATHS.update, {
      ...this.base,
      query: encode(filter) as Doc,
      // Passed through untouched: the gateway requires real Mongo operators ("update only works
      // with $ operators") and applies $set / $inc natively, so nothing is emulated here.
      update_data: encode(update) as Doc,
      upsert: options?.upsert ?? false,
    });
    assertWrote(res, 'updateOne');
    return res;
  }

  async updateMany(filter: Filter, update: UpdateDoc, options?: { upsert?: boolean }) {
    const res = await post(PATHS.updateMany, {
      ...this.base,
      query: encode(filter) as Doc,
      update_data: encode(update) as Doc,
      upsert: options?.upsert ?? false,
    });
    assertWrote(res, 'updateMany');
    return res;
  }

  async deleteMany(filter: Filter) {
    const res = await post(PATHS.remove, { ...this.base, query: encode(filter) as Doc });
    assertWrote(res, 'deleteMany');
    return { acknowledged: true };
  }

  /**
   * NOT ATOMIC on this backend: the gateway exposes no findAndModify, so this is a read followed by
   * a write and two writers can interleave. Run a single worker against the REST backend.
   */
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
      return this.findOne(filter);
    }
    const id = before._id;
    await this.updateOne({ _id: id } as Filter, update);
    return options?.returnDocument === 'after' ? this.findOne({ _id: id } as Filter) : before;
  }

  /** Real indexes: single-field and compound are separate endpoints on the gateway. */
  async createIndex(spec: Record<string, 1 | -1>, options?: Record<string, unknown>) {
    const fields = Object.keys(spec);
    const unique = Boolean(options?.unique);
    if (fields.length === 1) {
      return post(PATHS.createIndex, {
        ...this.base,
        field_name: fields[0],
        index_type: spec[fields[0]] === -1 ? 'descending' : 'ascending',
        unique,
      });
    }
    return post(PATHS.createCompoundIndex, {
      ...this.base,
      fields: fields.map((f) => [f, spec[f]]),
      unique,
    });
  }
}

export function restDatabase(): StoreDatabase {
  return {
    collection<T extends Doc = Doc>(name: string): StoreCollection<T> {
      return new RestCollection<T>(name);
    },
  };
}
