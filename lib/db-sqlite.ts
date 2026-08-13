/**
 * The SQLite implementation of the storage contract.
 *
 * This is the zero-setup path: Node's BUILT-IN `node:sqlite`, no native module, nothing to compile,
 * and it is what runs when `MONGODB_URI` is unset. The SQL below is unchanged from when this was
 * the only store — it was moved here, not rewritten, so the behaviour a demo depends on is exactly
 * the behaviour that has been running all along.
 *
 * Every method is `async` even though the underlying calls are synchronous. That is deliberate: if
 * the fast path were sync, call sites would be written against the sync shape and switching to
 * Mongo would become a rewrite rather than an environment variable.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Call, ExtractionResult, GateRejection, RunStatus, TranscriptSegment } from './types';
import type { Company } from './company-types';
import type { Learning } from './learning-types';
import type { RunRow, Store, UsageTotals } from './db-types';

const DIR = join(process.cwd(), 'data');
let _db: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (_db) return _db;
  mkdirSync(DIR, { recursive: true });
  const d = new DatabaseSync(join(DIR, 'opengong.db'));
  d.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, audio_path TEXT NOT NULL,
      duration_ms INTEGER NOT NULL, separation TEXT NOT NULL,
      created_at INTEGER NOT NULL, share_id TEXT UNIQUE
    );

    CREATE TABLE IF NOT EXISTS segments (
      call_id TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL,
      speaker TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
      text TEXT NOT NULL, display_text TEXT, channel INTEGER,
      PRIMARY KEY (call_id, id)
    );

    CREATE TABLE IF NOT EXISTS extractions (
      call_id TEXT PRIMARY KEY, json TEXT NOT NULL,
      run_status TEXT NOT NULL, created_at INTEGER NOT NULL
    );

    -- FAILURE INVARIANT (harness part 4): a row is written BEFORE work starts, so a crash
    -- leaves a 'running' row that can be reconciled. No run ever disappears without a trace.
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, call_id TEXT NOT NULL, step TEXT NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL, ended_at INTEGER, error TEXT, notes TEXT
    );

    CREATE TABLE IF NOT EXISTS gate_rejections (
      id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL, run_id TEXT NOT NULL,
      field TEXT NOT NULL, claim TEXT NOT NULL, reason TEXT NOT NULL,
      detail TEXT NOT NULL, dropped INTEGER NOT NULL, created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT, provider TEXT NOT NULL,
      audio_seconds REAL DEFAULT 0, input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0, units TEXT, created_at INTEGER NOT NULL
    );

    -- The account a call belongs to -- and the CRM record for it. One object, not two: a
    -- "company profile" and a "deal" are the same thing here, so stage lives on this row rather
    -- than on a parallel deal entity.
    --
    -- detail is a JSON blob, following the precedent set by the extractions table: the queryable
    -- fields are columns, and the richer demo detail (contacts, prior activity, deal numbers)
    -- rides along as a blob rather than as fifteen more columns.
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, industry TEXT, size_band TEXT,
      website TEXT, notes TEXT, stage TEXT NOT NULL DEFAULT 'Discovery',
      created_at INTEGER NOT NULL, detail TEXT
    );

    -- A JOIN TABLE rather than a calls.company_id column, deliberately.
    --
    -- This schema is created by one CREATE TABLE IF NOT EXISTS block with no migration system
    -- behind it. Adding a column to calls would therefore be a silent no-op on every database
    -- that already exists -- including a mounted Railway volume -- and would then throw
    -- "no column named company_id" at INSERT time, mid-run, after openRun had already written a
    -- row. A new table IS created on an existing database, so this is the version that works
    -- everywhere. It also lets the link be written before transcription succeeds, which a column
    -- on calls could not: insertCall only runs after STT returns.
    -- What each call taught us about an account. APPEND-ONLY: a row is a thing a specific call
    -- established, never edited afterwards, so the account's history stays auditable. Modelled on
    -- gate_rejections, and a new TABLE rather than a column on companies because this schema has no
    -- migration system -- a new column would be a silent no-op on every database that already exists.
    --
    -- Every row carries the evidence the claim was gated on, so a learning can be clicked back to
    -- the exact line that established it, and the extractor that produced it.
    CREATE TABLE IF NOT EXISTS company_learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id TEXT NOT NULL, call_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      kind TEXT NOT NULL, text TEXT NOT NULL,
      segment_id TEXT, start_ms INTEGER, speaker TEXT, quote TEXT,
      support REAL, verdict TEXT, extracted_by TEXT,
      promoted INTEGER NOT NULL DEFAULT 0
    );

        CREATE TABLE IF NOT EXISTS call_companies (
      call_id TEXT PRIMARY KEY, company_id TEXT NOT NULL
    );
  `);
  _db = d;
  return d;
}

// ── calls ────────────────────────────────────────────────────────────────────

function insertCall(c: Call) {
  db()
    .prepare(
      `INSERT OR REPLACE INTO calls (id,title,audio_path,duration_ms,separation,created_at,share_id)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(c.id, c.title, c.audio_path, c.duration_ms, c.separation, c.created_at, c.share_id);
}

/**
 * Rename a call.
 *
 * A plain UPDATE, deliberately NOT `insertCall`: that is INSERT OR REPLACE, so writing a partial
 * row would blank `audio_path` and `duration_ms`, and replacing the row churns the UNIQUE
 * `share_id` — quietly breaking any share link already handed out.
 */
function renameCall(id: string, title: string) {
  db().prepare(`UPDATE calls SET title = ? WHERE id = ?`).run(title, id);
}

/**
 * `node:sqlite` hands back rows with a NULL PROTOTYPE. React Server Components refuse to
 * serialize those across the server/client boundary ("Classes or null prototypes are not
 * supported"), so every read here rebuilds a plain object explicitly rather than casting the row.
 *
 * That is also just better practice: the DB layer returns values shaped by our data contract, and
 * a schema change surfaces as a type error here instead of as `undefined` in the UI.
 */
function toCall(r: Record<string, unknown>): Call {
  return {
    id: r.id as string,
    title: r.title as string,
    audio_path: r.audio_path as string,
    duration_ms: r.duration_ms as number,
    separation: r.separation as Call['separation'],
    created_at: r.created_at as number,
    share_id: (r.share_id as string | null) ?? null,
  };
}

function getCall(id: string): Call | null {
  const r = db().prepare(`SELECT * FROM calls WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? toCall(r) : null;
}

function getCallByShareId(shareId: string): Call | null {
  const r = db().prepare(`SELECT * FROM calls WHERE share_id = ?`).get(shareId) as
    | Record<string, unknown>
    | undefined;
  return r ? toCall(r) : null;
}

function listCalls(): Call[] {
  const rows = db()
    .prepare(`SELECT * FROM calls ORDER BY created_at DESC`)
    .all() as Record<string, unknown>[];
  return rows.map(toCall);
}

// ── segments ─────────────────────────────────────────────────────────────────

function replaceSegments(callId: string, segs: TranscriptSegment[]) {
  const d = db();
  d.prepare(`DELETE FROM segments WHERE call_id = ?`).run(callId);
  const ins = d.prepare(
    `INSERT INTO segments (call_id,id,seq,speaker,start_ms,end_ms,text,display_text,channel)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  segs.forEach((s, i) =>
    ins.run(
      callId,
      s.id,
      i,
      s.speaker,
      s.start_ms,
      s.end_ms,
      s.text,
      s.display_text ?? null,
      s.channel ?? null,
    ),
  );
}

function getSegments(callId: string): TranscriptSegment[] {
  const rows = db()
    .prepare(`SELECT * FROM segments WHERE call_id = ? ORDER BY seq`)
    .all(callId) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    speaker: r.speaker as string,
    start_ms: r.start_ms as number,
    end_ms: r.end_ms as number,
    text: r.text as string,
    ...(r.display_text ? { display_text: r.display_text as string } : {}),
    ...(r.channel !== null ? { channel: r.channel as number } : {}),
  }));
}

// ── extractions ──────────────────────────────────────────────────────────────

function saveExtraction(callId: string, ex: ExtractionResult) {
  db()
    .prepare(
      `INSERT OR REPLACE INTO extractions (call_id,json,run_status,created_at) VALUES (?,?,?,?)`,
    )
    .run(callId, JSON.stringify(ex), ex.run_status, Date.now());
}

function getExtraction(callId: string): ExtractionResult | null {
  const r = db()
    .prepare(`SELECT json FROM extractions WHERE call_id = ?`)
    .get(callId) as { json?: string } | undefined;
  return r?.json ? (JSON.parse(r.json) as ExtractionResult) : null;
}

// ── runs (failure invariant) ──────────────────────────────────────────────────

function openRun(runId: string, callId: string, step: string) {
  db()
    .prepare(
      `INSERT OR REPLACE INTO runs (id,call_id,step,status,attempts,started_at) VALUES (?,?,?,?,?,?)`,
    )
    .run(runId, callId, step, 'running', 0, Date.now());
}

function closeRun(
  runId: string,
  status: RunStatus | 'running',
  opts: { attempts?: number; error?: string; notes?: string } = {},
) {
  db()
    .prepare(`UPDATE runs SET status=?, ended_at=?, attempts=?, error=?, notes=? WHERE id=?`)
    .run(
      status,
      Date.now(),
      opts.attempts ?? 0,
      opts.error ?? null,
      opts.notes ?? null,
      runId,
    );
}


/**
 * How long recent successful runs actually took, as a median.
 *
 * This is the only honest thing a progress screen can say about "how much longer" — the extract
 * call is a single opaque await with no token callback, so any percentage would be invented. A
 * median over runs that really happened is a measurement, and it is presented in the past tense
 * ("similar runs took about 48s") rather than as a prediction.
 *
 * Returns null below three samples: a confident number derived from one cold-start run would be
 * exactly the sort of authoritative-sounding guess this codebase avoids elsewhere.
 */
function medianRecentRunMs(sample = 15): number | null {
  const rows = db()
    .prepare(
      `SELECT started_at, ended_at FROM runs
       WHERE ended_at IS NOT NULL AND status IN ('shipped','partial')
       ORDER BY started_at DESC LIMIT ?`,
    )
    .all(sample) as Record<string, unknown>[];

  const durations = rows
    .map((r) => (r.ended_at as number) - (r.started_at as number))
    .filter((ms) => Number.isFinite(ms) && ms > 0)
    .sort((a, b) => a - b);

  if (durations.length < 3) return null;
  const mid = Math.floor(durations.length / 2);
  return durations.length % 2 === 0
    ? Math.round((durations[mid - 1] + durations[mid]) / 2)
    : durations[mid];
}

function listRuns(limit = 50): RunRow[] {
  const rows = db()
    .prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`)
    .all(limit) as Record<string, unknown>[];
  // Rebuilt as plain objects for the same null-prototype reason as toCall() above.
  return rows.map((r) => ({
    id: r.id as string,
    call_id: r.call_id as string,
    step: r.step as string,
    status: r.status as string,
    attempts: (r.attempts as number) ?? 0,
    started_at: r.started_at as number,
    ended_at: (r.ended_at as number | null) ?? null,
    error: (r.error as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
  }));
}

/**
 * Any run still marked 'running' from a previous process is by definition a crash — the
 * failure invariant says it must end up as a record, not a mystery.
 */
function reconcileOrphanRuns(): number {
  const res = db()
    .prepare(
      `UPDATE runs SET status='failed', ended_at=?, error='process exited before this run completed'
       WHERE status='running' AND started_at < ?`,
    )
    .run(Date.now(), Date.now() - 10 * 60_000);
  return Number(res.changes ?? 0);
}

// ── gate rejections ──────────────────────────────────────────────────────────

function recordRejections(callId: string, runId: string, rs: GateRejection[]) {
  const ins = db().prepare(
    `INSERT INTO gate_rejections (call_id,run_id,field,claim,reason,detail,dropped,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  const now = Date.now();
  for (const r of rs)
    ins.run(callId, runId, r.field, r.claim, r.reason, r.detail, r.dropped ? 1 : 0, now);
}

function countRejections(): { total: number; dropped: number } {
  const r = db()
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(dropped),0) AS dropped FROM gate_rejections`,
    )
    .get() as { total: number; dropped: number };
  return { total: Number(r.total), dropped: Number(r.dropped) };
}

// ── usage (API gravity) ──────────────────────────────────────────────────────

function recordUsage(
  callId: string | null,
  provider: string,
  u: { audio_seconds?: number; input_tokens?: number; output_tokens?: number; units?: string },
) {
  db()
    .prepare(
      `INSERT INTO usage_events (call_id,provider,audio_seconds,input_tokens,output_tokens,units,created_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      callId,
      provider,
      u.audio_seconds ?? 0,
      u.input_tokens ?? 0,
      u.output_tokens ?? 0,
      u.units ?? null,
      Date.now(),
    );
}


function usageTotals(): UsageTotals {
  const u = db()
    .prepare(
      `SELECT COALESCE(SUM(audio_seconds),0) AS a, COALESCE(SUM(input_tokens),0) AS i,
              COALESCE(SUM(output_tokens),0) AS o FROM usage_events`,
    )
    .get() as { a: number; i: number; o: number };
  const c = db().prepare(`SELECT COUNT(*) AS n FROM calls`).get() as { n: number };
  const rej = countRejections();
  return {
    audio_seconds: Number(u.a),
    minutes: Number(u.a) / 60,
    input_tokens: Number(u.i),
    output_tokens: Number(u.o),
    calls_processed: Number(c.n),
    claims_blocked: rej.dropped,
  };
}

// ── companies ────────────────────────────────────────────────────────────────

/** Same null-prototype rule as toCall: rebuild explicitly, and never let a bad blob crash a page. */
function toCompany(r: Record<string, unknown>): Company {
  let detail: Company['detail'] = null;
  if (typeof r.detail === 'string' && r.detail) {
    try {
      detail = JSON.parse(r.detail) as Company['detail'];
    } catch {
      detail = null;
    }
  }
  return {
    id: r.id as string,
    name: r.name as string,
    industry: (r.industry as string | null) ?? null,
    size_band: (r.size_band as string | null) ?? null,
    website: (r.website as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    stage: (r.stage as Company['stage']) ?? 'Discovery',
    created_at: r.created_at as number,
    detail,
  };
}

// ── learnings ────────────────────────────────────────────────────────────────

function toLearning(r: Record<string, unknown>): Learning {
  return {
    id: r.id as number,
    company_id: r.company_id as string,
    call_id: r.call_id as string,
    created_at: r.created_at as number,
    kind: r.kind as Learning['kind'],
    text: r.text as string,
    segment_id: (r.segment_id as string | null) ?? null,
    start_ms: (r.start_ms as number | null) ?? null,
    speaker: (r.speaker as string | null) ?? null,
    quote: (r.quote as string | null) ?? null,
    support: (r.support as number | null) ?? null,
    verdict: (r.verdict as string | null) ?? null,
    extracted_by: (r.extracted_by as string | null) ?? null,
    promoted: Boolean(r.promoted),
  };
}

/**
 * The contract, over SQLite. Thin async wrappers around the synchronous statements above.
 */
export const sqliteStore: Store = {
  name: 'sqlite',

  async insertCall(c) { insertCall(c); },
  async renameCall(id, title) { renameCall(id, title); },
  async getCall(id) { return getCall(id); },
  async getCallByShareId(shareId) { return getCallByShareId(shareId); },
  async listCalls() { return listCalls(); },

  async replaceSegments(callId, segs) { replaceSegments(callId, segs); },
  async getSegments(callId) { return getSegments(callId); },

  async saveExtraction(callId, ex) { saveExtraction(callId, ex); },
  async getExtraction(callId) { return getExtraction(callId); },

  async openRun(runId, callId, step) { openRun(runId, callId, step); },
  async closeRun(runId, status, opts) { closeRun(runId, status, opts); },
  async listRuns(limit) { return listRuns(limit); },
  async medianRecentRunMs(sample) { return medianRecentRunMs(sample); },
  async reconcileOrphanRuns() { return reconcileOrphanRuns(); },

  async recordRejections(callId, runId, rs) { recordRejections(callId, runId, rs); },
  async countRejections() { return countRejections(); },

  async recordUsage(callId, provider, u) { recordUsage(callId, provider, u); },
  async usageTotals() { return usageTotals(); },

  async listCompanies() {
    return (
      db().prepare(`SELECT * FROM companies ORDER BY name COLLATE NOCASE`).all() as Record<
        string,
        unknown
      >[]
    ).map(toCompany);
  },
  async getCompany(id) {
    const r = db().prepare(`SELECT * FROM companies WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? toCompany(r) : null;
  },
  async upsertCompany(c) {
    db()
      .prepare(
        `INSERT OR REPLACE INTO companies
           (id,name,industry,size_band,website,notes,stage,created_at,detail)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        c.id, c.name, c.industry, c.size_band, c.website, c.notes, c.stage, c.created_at,
        c.detail ? JSON.stringify(c.detail) : null,
      );
  },
  async linkCallToCompany(callId, companyId) {
    db()
      .prepare(`INSERT OR REPLACE INTO call_companies (call_id, company_id) VALUES (?,?)`)
      .run(callId, companyId);
  },
  async companyIdForCall(callId) {
    const r = db().prepare(`SELECT company_id FROM call_companies WHERE call_id = ?`).get(callId) as
      | { company_id?: string }
      | undefined;
    return r?.company_id ?? null;
  },

  async replaceLearningsForCall(callId, rows) {
    const d = db();
    d.prepare(`DELETE FROM company_learnings WHERE call_id = ?`).run(callId);
    const ins = d.prepare(
      `INSERT INTO company_learnings
         (company_id,call_id,created_at,kind,text,segment_id,start_ms,speaker,quote,support,verdict,extracted_by,promoted)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const r of rows) {
      ins.run(
        r.company_id, r.call_id, r.created_at, r.kind, r.text,
        r.segment_id, r.start_ms, r.speaker, r.quote,
        r.support, r.verdict, r.extracted_by, r.promoted ? 1 : 0,
      );
    }
    return rows.length;
  },
  async learningsForCompany(companyId, limit = 100) {
    return (
      db()
        .prepare(
          `SELECT * FROM company_learnings WHERE company_id = ?
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(companyId, limit) as Record<string, unknown>[]
    ).map(toLearning);
  },
  async getLearning(id) {
    const r = db().prepare(`SELECT * FROM company_learnings WHERE id = ?`).get(Number(id)) as
      | Record<string, unknown>
      | undefined;
    return r ? toLearning(r) : null;
  },
  async markLearningPromoted(id) {
    db().prepare(`UPDATE company_learnings SET promoted = 1 WHERE id = ?`).run(Number(id));
  },
};
