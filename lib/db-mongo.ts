/**
 * The MongoDB implementation of the storage contract.
 *
 * Identical behaviour to the SQLite store, expressed as documents. Two translation rules run
 * throughout and are worth stating once:
 *
 *   • **`_id` is the primary key**, so a call's `id` and a company's `id` are stored as `_id` and
 *     mapped back on read. That is what makes `getCall` a primary-key lookup rather than a scan.
 *   • **Every read rebuilds a plain object field by field**, exactly as the SQLite store does for
 *     null-prototype rows. The reason is the same in a different costume: BSON hands back values
 *     React Server Components refuse to serialize, so a raw document must never reach a component.
 *
 * Auto-increment ids do not exist in Mongo, so learnings get a string `_id`. The contract types the
 * id as `number | string` for that reason.
 */
import { randomUUID } from 'node:crypto';
import { collections, getDatabase } from './store';
import type { Doc } from './store';
import type { Call, ExtractionResult, GateRejection, RunStatus, TranscriptSegment } from './types';
import type { Company } from './company-types';
import type { Learning } from './learning-types';
import type { RunRow, Store, UsageInput, UsageTotals } from './db-types';

const col = (name: string) => getDatabase().collection(name);

const toCall = (r: Doc): Call => ({
  id: r._id as string,
  title: r.title as string,
  audio_path: r.audio_path as string,
  duration_ms: r.duration_ms as number,
  separation: r.separation as Call['separation'],
  created_at: r.created_at as number,
  share_id: (r.share_id as string | null) ?? null,
});

const toCompany = (r: Doc): Company => ({
  id: r._id as string,
  name: r.name as string,
  industry: (r.industry as string | null) ?? null,
  size_band: (r.size_band as string | null) ?? null,
  website: (r.website as string | null) ?? null,
  notes: (r.notes as string | null) ?? null,
  stage: (r.stage as Company['stage']) ?? 'Discovery',
  created_at: r.created_at as number,
  detail: (r.detail as Company['detail']) ?? null,
});

const toLearning = (r: Doc): Learning => ({
  id: r._id as unknown as number,
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
});

const toRun = (r: Doc): RunRow => ({
  id: r._id as string,
  call_id: r.call_id as string,
  step: r.step as string,
  status: r.status as string,
  attempts: (r.attempts as number) ?? 0,
  started_at: r.started_at as number,
  ended_at: (r.ended_at as number | null) ?? null,
  error: (r.error as string | null) ?? null,
  notes: (r.notes as string | null) ?? null,
});

export const mongoStore: Store = {
  name: 'mongo',

  // ── calls ──────────────────────────────────────────────────────────────────
  async insertCall(c: Call) {
    const { id, ...rest } = c;
    await col(collections().calls).updateOne({ _id: id }, { $set: { ...rest } }, { upsert: true });
  },
  async renameCall(id, title) {
    await col(collections().calls).updateOne({ _id: id }, { $set: { title } });
  },
  async getCall(id) {
    const r = await col(collections().calls).findOne({ _id: id });
    return r ? toCall(r) : null;
  },
  async getCallByShareId(shareId) {
    const r = await col(collections().calls).findOne({ share_id: shareId });
    return r ? toCall(r) : null;
  },
  async listCalls() {
    const rows = await col(collections().calls).find({}).sort('created_at', -1).toArray();
    return rows.map(toCall);
  },

  // ── segments ───────────────────────────────────────────────────────────────
  async replaceSegments(callId, segs) {
    const c = col(collections().segments);
    await c.deleteMany({ call_id: callId });
    if (segs.length === 0) return;
    await c.insertMany(
      segs.map((s, i) => ({
        // Composite key: a segment id is only unique WITHIN a call, exactly as the SQLite
        // PRIMARY KEY (call_id, id) says.
        _id: `${callId}:${s.id}`,
        call_id: callId,
        seq: i,
        id: s.id,
        speaker: s.speaker,
        start_ms: s.start_ms,
        end_ms: s.end_ms,
        text: s.text,
        display_text: s.display_text ?? null,
        channel: s.channel ?? null,
      })),
    );
  },
  async getSegments(callId) {
    const rows = await col(collections().segments)
      .find({ call_id: callId })
      .sort('seq', 1)
      .toArray();
    return rows.map((r) => ({
      id: r.id as string,
      speaker: r.speaker as string,
      start_ms: r.start_ms as number,
      end_ms: r.end_ms as number,
      text: r.text as string,
      ...(r.display_text ? { display_text: r.display_text as string } : {}),
      ...(r.channel !== null && r.channel !== undefined ? { channel: r.channel as number } : {}),
    })) as TranscriptSegment[];
  },

  // ── extractions ────────────────────────────────────────────────────────────
  async saveExtraction(callId, ex: ExtractionResult) {
    await col(collections().extractions).updateOne(
      { _id: callId },
      {
        // Stored as a JSON string rather than a nested document, matching the SQLite column. Keeps
        // one representation of the result and avoids BSON key restrictions inside claim text.
        $set: { json: JSON.stringify(ex), run_status: ex.run_status, created_at: Date.now() },
      },
      { upsert: true },
    );
  },
  async getExtraction(callId) {
    const r = await col(collections().extractions).findOne({ _id: callId });
    return r?.json ? (JSON.parse(r.json as string) as ExtractionResult) : null;
  },

  // ── runs ───────────────────────────────────────────────────────────────────
  async openRun(runId, callId, step) {
    await col(collections().runs).updateOne(
      { _id: runId },
      { $set: { call_id: callId, step, status: 'running', attempts: 0, started_at: Date.now() } },
      { upsert: true },
    );
  },
  async closeRun(runId, status: RunStatus | 'running', opts = {}) {
    await col(collections().runs).updateOne(
      { _id: runId },
      {
        $set: {
          status,
          ended_at: Date.now(),
          attempts: opts.attempts ?? 0,
          error: opts.error ?? null,
          notes: opts.notes ?? null,
        },
      },
    );
  },
  async listRuns(limit = 50) {
    const rows = await col(collections().runs).find({}).sort('started_at', -1).limit(limit).toArray();
    return rows.map(toRun);
  },
  async medianRecentRunMs(sample = 15) {
    const rows = await col(collections().runs)
      .find({ status: { $in: ['shipped', 'partial'] } })
      .sort('started_at', -1)
      .limit(sample)
      .toArray();
    const durations = rows
      .filter((r) => r.ended_at != null)
      .map((r) => (r.ended_at as number) - (r.started_at as number))
      .filter((ms) => Number.isFinite(ms) && ms > 0)
      .sort((a, b) => a - b);
    if (durations.length < 3) return null;
    const mid = Math.floor(durations.length / 2);
    return durations.length % 2 === 0
      ? Math.round((durations[mid - 1] + durations[mid]) / 2)
      : durations[mid];
  },
  async reconcileOrphanRuns() {
    const cutoff = Date.now() - 10 * 60_000;
    const stale = await col(collections().runs)
      .find({ status: 'running' })
      .toArray();
    const orphans = stale.filter((r) => (r.started_at as number) < cutoff);
    for (const o of orphans) {
      await col(collections().runs).updateOne(
        { _id: o._id },
        {
          $set: {
            status: 'failed',
            ended_at: Date.now(),
            error: 'process exited before this run completed',
          },
        },
      );
    }
    return orphans.length;
  },

  // ── gate rejections ────────────────────────────────────────────────────────
  async recordRejections(callId, runId, rs: GateRejection[]) {
    if (rs.length === 0) return;
    const now = Date.now();
    await col(collections().gateRejections).insertMany(
      rs.map((r) => ({
        _id: randomUUID(),
        call_id: callId,
        run_id: runId,
        field: r.field,
        claim: r.claim,
        reason: r.reason,
        detail: r.detail,
        dropped: r.dropped ? 1 : 0,
        created_at: now,
      })),
    );
  },
  async countRejections() {
    const rows = await col(collections().gateRejections).find({}).toArray();
    return {
      total: rows.length,
      dropped: rows.reduce((n, r) => n + (Number(r.dropped) ? 1 : 0), 0),
    };
  },

  // ── usage ──────────────────────────────────────────────────────────────────
  async recordUsage(callId, provider, u: UsageInput) {
    await col(collections().usageEvents).insertOne({
      _id: randomUUID(),
      call_id: callId,
      provider,
      audio_seconds: u.audio_seconds ?? 0,
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      units: u.units ?? null,
      created_at: Date.now(),
    });
  },
  async usageTotals(): Promise<UsageTotals> {
    const rows = await col(collections().usageEvents).find({}).toArray();
    const sum = (k: string) => rows.reduce((n, r) => n + (Number(r[k]) || 0), 0);
    const audio = sum('audio_seconds');
    const calls = await col(collections().calls).countDocuments({});
    const rej = await mongoStore.countRejections();
    return {
      audio_seconds: audio,
      minutes: audio / 60,
      input_tokens: sum('input_tokens'),
      output_tokens: sum('output_tokens'),
      calls_processed: calls,
      claims_blocked: rej.dropped,
    };
  },

  // ── companies ──────────────────────────────────────────────────────────────
  async listCompanies() {
    const rows = await col(collections().companies).find({}).sort('name', 1).toArray();
    return rows.map(toCompany);
  },
  async getCompany(id) {
    const r = await col(collections().companies).findOne({ _id: id });
    return r ? toCompany(r) : null;
  },
  async upsertCompany(c: Company) {
    const { id, ...rest } = c;
    await col(collections().companies).updateOne({ _id: id }, { $set: { ...rest } }, { upsert: true });
  },
  async linkCallToCompany(callId, companyId) {
    await col(collections().callCompanies).updateOne(
      { _id: callId },
      { $set: { call_id: callId, company_id: companyId } },
      { upsert: true },
    );
  },
  async companyIdForCall(callId) {
    const r = await col(collections().callCompanies).findOne({ _id: callId });
    return (r?.company_id as string | undefined) ?? null;
  },

  // ── learnings ──────────────────────────────────────────────────────────────
  async replaceLearningsForCall(callId, rows) {
    const c = col(collections().companyLearnings);
    await c.deleteMany({ call_id: callId });
    if (rows.length === 0) return 0;
    await c.insertMany(rows.map((r) => ({ ...r, _id: randomUUID(), promoted: r.promoted ? 1 : 0 })));
    return rows.length;
  },
  async learningsForCompany(companyId, limit = 100) {
    const rows = await col(collections().companyLearnings)
      .find({ company_id: companyId })
      .sort('created_at', -1)
      .limit(limit)
      .toArray();
    return rows.map(toLearning);
  },
  async getLearning(id) {
    const r = await col(collections().companyLearnings).findOne({ _id: String(id) });
    return r ? toLearning(r) : null;
  },
  async markLearningPromoted(id) {
    await col(collections().companyLearnings).updateOne(
      { _id: String(id) },
      { $set: { promoted: 1 } },
    );
  },
};
