/**
 * THE NAMED LOOP — harness part 1.
 *
 * ingest → extract → gate → output. Every run of this pipeline ends in EXACTLY ONE of
 * shipped / partial / failed / deadline. No run is allowed to just trail off, and every run
 * leaves a row in `runs` whether it succeeds or explodes.
 *
 * This is the only place the seven harness parts meet:
 *   1 named loop + exit status ....... this file
 *   2 blocking gate .................. runCitationGate()
 *   3 bounded aimed retry ............ retryAimed(), with the gate's reason fed back in
 *   4 failure invariant .............. openRun() before work, closeRun() in finally
 *   5 capability registry ............ getSTT() / getExtractor()
 *   6 safe parallelism ............... withLock(callId)
 *   7 budget governor ................ BudgetGovernor.preflight() before each model call
 */
import { randomUUID } from 'node:crypto';
import { getExtractor, getSTT, REGISTRY_CONFIG } from '@/lib/registry';
import type { SeparationMode } from '@/lib/registry/types';
import type { ExtractionResult, RunStatus, TranscriptSegment } from '@/lib/types';
import {
  closeRun,
  insertCall,
  openRun,
  recordRejections,
  recordUsage,
  replaceSegments,
  saveExtraction,
} from '@/lib/db';
import { BudgetGovernor, DeadlineError, estimateTokens, type BudgetCaps } from './budget';
import { runCitationGate } from './gate';
import { withLock } from './parallel';
import { retryAimed } from './retry';

export type ProcessInput = {
  title: string;
  audio: Uint8Array;
  filename: string;
  /** Public URL the player will load (we persist the file before calling this). */
  audioPath: string;
  mode: SeparationMode;
  callId?: string;
  numerals?: boolean;
  /** Per-run budget overrides; defaults come from the registry config. */
  budgetCaps?: Partial<BudgetCaps>;
  /** Override the STT provider for this run (e.g. 'fixture' to replay a committed transcript). */
  sttProvider?: string;
};

export type ProcessOutcome = {
  callId: string;
  runId: string;
  run_status: RunStatus;
  segments: number;
  rejections: number;
  attempts: { stt: number; extract: number };
  budget: ReturnType<BudgetGovernor['snapshot']>;
  extraction: ExtractionResult | null;
  error?: string;
};

/** The retry trigger: claims the gate had to DELETE because their citations did not resolve. */
function unresolvableDrops(ex: ExtractionResult): string[] {
  return ex.rejections
    .filter((r) => r.dropped && r.reason === 'unresolvable_citation')
    .map((r) => `${r.field}: ${r.detail}`);
}

export async function processCall(input: ProcessInput): Promise<ProcessOutcome> {
  const callId = input.callId ?? randomUUID().slice(0, 8);
  const runId = randomUUID();

  return withLock(callId, async () => {
    // FAILURE INVARIANT: the record exists before any work does, so a crash is still a record.
    openRun(runId, callId, 'ingest+extract+gate');

    const budget = new BudgetGovernor(input.budgetCaps ?? {});
    let segments: TranscriptSegment[] = [];
    let extraction: ExtractionResult | null = null;
    let sttAttempts = 0;
    let extractAttempts = 0;
    let status: RunStatus = 'failed';
    let error: string | undefined;

    try {
      // ── 1. Transcribe (registry-provided; retried on transient provider errors) ────
      const stt = await getSTT(input.sttProvider);
      const sttRun = await retryAimed({
        attempts: REGISTRY_CONFIG.maxAttempts,
        run: () =>
          stt.transcribe({
            audio: input.audio,
            filename: input.filename,
            mode: input.mode,
            numerals: input.numerals,
          }),
        // A 4xx means bad scope or bad request; retrying cannot help.
        isFatal: (e) =>
          typeof e === 'object' && e !== null && 'retryable' in e
            ? !(e as { retryable: boolean }).retryable
            : false,
      });
      sttAttempts = sttRun.attempts;
      segments = sttRun.value.segments;

      insertCall({
        id: callId,
        title: input.title,
        audio_path: input.audioPath,
        duration_ms: Math.round(sttRun.value.audio_seconds * 1000),
        separation: input.mode,
        created_at: Date.now(),
        share_id: callId,
      });
      replaceSegments(callId, segments);
      recordUsage(callId, stt.name, sttRun.value.usage);

      // ── 2. Extract, then GATE, with the gate's own complaint aimed at the retry ────
      const extractor = await getExtractor();
      const transcriptChars = segments.reduce((n, s) => n + s.text.length + 24, 0);

      const exRun = await retryAimed({
        attempts: REGISTRY_CONFIG.maxAttempts,
        run: async (_n, priorFailure) => {
          // BUDGET GOVERNOR: checked before the model call, not after it.
          budget.preflight(estimateTokens(transcriptChars > 0 ? 'x'.repeat(transcriptChars) : ''));
          const { draft, usage } = await extractor.extract({
            callTitle: input.title,
            segments,
            priorFailure,
          });
          budget.record(usage);
          recordUsage(callId, extractor.name, usage);
          return runCitationGate(draft, segments, extractor.name);
        },
        // Spend another attempt only if the gate had to delete claims outright.
        validate: (outcome) => {
          const drops = unresolvableDrops(outcome.result);
          return drops.length === 0
            ? { ok: true }
            : { ok: false, reason: `Claims deleted for citing non-existent segments — ${drops.join('; ')}` };
        },
      });
      extractAttempts = exRun.attempts;
      extraction = exRun.value.result;

      saveExtraction(callId, extraction);
      recordRejections(callId, runId, extraction.rejections);
      status = extraction.run_status;
    } catch (err) {
      if (err instanceof DeadlineError) {
        status = 'deadline';
        error = `budget cap ${err.cap}: ${err.message}`;
      } else {
        status = 'failed';
        error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      // Exactly one terminal status, always written.
      closeRun(runId, status, {
        attempts: sttAttempts + extractAttempts,
        error,
        notes: JSON.stringify(budget.snapshot()),
      });
    }

    return {
      callId,
      runId,
      run_status: status,
      segments: segments.length,
      rejections: extraction?.rejections.length ?? 0,
      attempts: { stt: sttAttempts, extract: extractAttempts },
      budget: budget.snapshot(),
      extraction,
      error,
    };
  });
}
