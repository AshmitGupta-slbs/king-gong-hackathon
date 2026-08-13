/**
 * Storage: SQLite via Node's BUILT-IN `node:sqlite`. No native module, no node-gyp, nothing to
 * compile. That is a deliberate choice in service of the "five-minute setup that actually takes
 * five minutes" gate — `better-sqlite3` would add a compile step that can fail on a stranger's
 * machine, and every extra service is something that breaks a stranger's clone.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Call, ExtractionResult, GateRejection, RunStatus, TranscriptSegment } from './types';

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
  `);
  _db = d;
  return d;
}

// ── calls ────────────────────────────────────────────────────────────────────

export function insertCall(c: Call) {
  db()
    .prepare(
      `INSERT OR REPLACE INTO calls (id,title,audio_path,duration_ms,separation,created_at,share_id)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(c.id, c.title, c.audio_path, c.duration_ms, c.separation, c.created_at, c.share_id);
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

export function getCall(id: string): Call | null {
  const r = db().prepare(`SELECT * FROM calls WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? toCall(r) : null;
}

export function getCallByShareId(shareId: string): Call | null {
  const r = db().prepare(`SELECT * FROM calls WHERE share_id = ?`).get(shareId) as
    | Record<string, unknown>
    | undefined;
  return r ? toCall(r) : null;
}

export function listCalls(): Call[] {
  const rows = db()
    .prepare(`SELECT * FROM calls ORDER BY created_at DESC`)
    .all() as Record<string, unknown>[];
  return rows.map(toCall);
}

// ── segments ─────────────────────────────────────────────────────────────────

export function replaceSegments(callId: string, segs: TranscriptSegment[]) {
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

export function getSegments(callId: string): TranscriptSegment[] {
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

export function saveExtraction(callId: string, ex: ExtractionResult) {
  db()
    .prepare(
      `INSERT OR REPLACE INTO extractions (call_id,json,run_status,created_at) VALUES (?,?,?,?)`,
    )
    .run(callId, JSON.stringify(ex), ex.run_status, Date.now());
}

export function getExtraction(callId: string): ExtractionResult | null {
  const r = db()
    .prepare(`SELECT json FROM extractions WHERE call_id = ?`)
    .get(callId) as { json?: string } | undefined;
  return r?.json ? (JSON.parse(r.json) as ExtractionResult) : null;
}

// ── runs (failure invariant) ──────────────────────────────────────────────────

export function openRun(runId: string, callId: string, step: string) {
  db()
    .prepare(
      `INSERT OR REPLACE INTO runs (id,call_id,step,status,attempts,started_at) VALUES (?,?,?,?,?,?)`,
    )
    .run(runId, callId, step, 'running', 0, Date.now());
}

export function closeRun(
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

export type RunRow = {
  id: string;
  call_id: string;
  step: string;
  status: string;
  attempts: number;
  started_at: number;
  ended_at: number | null;
  error: string | null;
  notes: string | null;
};

export function listRuns(limit = 50): RunRow[] {
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
export function reconcileOrphanRuns(): number {
  const res = db()
    .prepare(
      `UPDATE runs SET status='failed', ended_at=?, error='process exited before this run completed'
       WHERE status='running' AND started_at < ?`,
    )
    .run(Date.now(), Date.now() - 10 * 60_000);
  return Number(res.changes ?? 0);
}

// ── gate rejections ──────────────────────────────────────────────────────────

export function recordRejections(callId: string, runId: string, rs: GateRejection[]) {
  const ins = db().prepare(
    `INSERT INTO gate_rejections (call_id,run_id,field,claim,reason,detail,dropped,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  const now = Date.now();
  for (const r of rs)
    ins.run(callId, runId, r.field, r.claim, r.reason, r.detail, r.dropped ? 1 : 0, now);
}

export function countRejections(): { total: number; dropped: number } {
  const r = db()
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(dropped),0) AS dropped FROM gate_rejections`,
    )
    .get() as { total: number; dropped: number };
  return { total: Number(r.total), dropped: Number(r.dropped) };
}

// ── usage (API gravity) ──────────────────────────────────────────────────────

export function recordUsage(
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

export type UsageTotals = {
  audio_seconds: number;
  minutes: number;
  input_tokens: number;
  output_tokens: number;
  calls_processed: number;
  claims_blocked: number;
};

export function usageTotals(): UsageTotals {
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
