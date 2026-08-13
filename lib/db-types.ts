/**
 * The storage contract, implemented twice: once over SQLite, once over MongoDB.
 *
 * Everything is async, including the SQLite side where the underlying calls are synchronous. That
 * is deliberate — if the fast path were sync, every call site would be written against the sync
 * shape and switching backends would become a rewrite instead of an environment variable.
 */
import type {
  Call,
  ExtractionResult,
  GateRejection,
  RunStatus,
  TranscriptSegment,
} from './types';
import type { Company } from './company-types';
import type { Learning } from './learning-types';

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

export type UsageTotals = {
  audio_seconds: number;
  minutes: number;
  input_tokens: number;
  output_tokens: number;
  calls_processed: number;
  claims_blocked: number;
};

/**
 * A call plus the handful of derived facts the call LIST needs.
 *
 * It exists because the list has to answer "did this call's notes survive the gate?" for every row,
 * and the honest source of that answer is the extraction, not a build artefact. Fetching it per row
 * would be two round trips per call and would drag every segment's full text across the wire; both
 * backends answer this in a fixed number of queries regardless of how many calls there are.
 *
 * `run_status` is null when a call has been transcribed but never extracted — a real state the list
 * should show as such, not a missing value to paper over.
 */
export type CallSummary = Call & {
  run_status: RunStatus | null;
  extracted_by: string | null;
  company_id: string | null;
};

export type UsageInput = {
  audio_seconds?: number;
  input_tokens?: number;
  output_tokens?: number;
  units?: string;
};

export interface Store {
  readonly name: string;

  // calls
  insertCall(c: Call): Promise<void>;
  renameCall(id: string, title: string): Promise<void>;
  getCall(id: string): Promise<Call | null>;
  getCallByShareId(shareId: string): Promise<Call | null>;
  listCalls(): Promise<Call[]>;
  /** Every call with its extraction status, in a fixed number of round trips. See CallSummary. */
  listCallSummaries(): Promise<CallSummary[]>;

  // segments
  replaceSegments(callId: string, segs: TranscriptSegment[]): Promise<void>;
  getSegments(callId: string): Promise<TranscriptSegment[]>;

  // extractions
  saveExtraction(callId: string, ex: ExtractionResult): Promise<void>;
  getExtraction(callId: string): Promise<ExtractionResult | null>;

  // runs — the failure invariant
  openRun(runId: string, callId: string, step: string): Promise<void>;
  closeRun(
    runId: string,
    status: RunStatus | 'running',
    opts?: { attempts?: number; error?: string; notes?: string },
  ): Promise<void>;
  listRuns(limit?: number): Promise<RunRow[]>;
  medianRecentRunMs(sample?: number): Promise<number | null>;
  reconcileOrphanRuns(): Promise<number>;

  // gate rejections
  recordRejections(callId: string, runId: string, rs: GateRejection[]): Promise<void>;
  countRejections(): Promise<{ total: number; dropped: number }>;

  // usage
  recordUsage(callId: string | null, provider: string, u: UsageInput): Promise<void>;
  usageTotals(): Promise<UsageTotals>;

  // companies
  listCompanies(): Promise<Company[]>;
  getCompany(id: string): Promise<Company | null>;
  upsertCompany(c: Company): Promise<void>;
  linkCallToCompany(callId: string, companyId: string): Promise<void>;
  companyIdForCall(callId: string): Promise<string | null>;

  // learnings
  replaceLearningsForCall(callId: string, rows: Omit<Learning, 'id'>[]): Promise<number>;
  learningsForCompany(companyId: string, limit?: number): Promise<Learning[]>;
  getLearning(id: number | string): Promise<Learning | null>;
  markLearningPromoted(id: number | string): Promise<void>;
}
