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
