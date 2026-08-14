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
  renameCall,
  openRun,
  recordRejections,
  recordUsage,
  replaceSegments,
  saveExtraction,
} from '@/lib/db';
import { deriveCallTitle, subjectFromTranscript } from '../call-title';
import { recordLearnings } from '../learnings';
import { selectSkills } from '../skills';
import { applyOutcomes, recordActionItems, renderOpenForCompany } from '../action-items';
// Our own prompt text, not a vendor shape — the registry boundary is about vendor payloads, and
// asking the prompt builder how large its own output is keeps the estimate honest.
import { extractPromptText } from '../registry/providers/extract-shared';
import { BudgetGovernor, DeadlineError, estimateTokens, type BudgetCaps } from './budget';
import {
  companyForCall,
  getCompany,
  linkCallToCompany,
  renderAccountContext,
  renderLearnedForCompany,
} from '../companies';
import { runCitationGate } from './gate';
import { withLock } from './parallel';
import { safeStage, type OnStage } from './progress';
import { retryAimed } from './retry';
import { scoreCall, scoringPromptText } from '../scoring/score';

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
  /** Account this call belongs to. Its context grounds the extraction; optional by design. */
  companyId?: string;
  /**
   * Optional narration for a progress UI. Purely additive — the run's behaviour, its outcome and
   * its recorded status do not depend on whether anyone is listening.
   */
  onStage?: OnStage;
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
  /** The call's title AFTER analysis — auto-derived from what the call turned out to be about. */
  title: string;
  error?: string;
  /** Provider error code, when the failure had one (e.g. 'daily_cap_exceeded'). */
  errorCode?: string;
  /**
   * Human guidance for a failure the user can actually act on. Distinct from `error`, which is the
   * provider's own wording: a raw `PyAI 429 daily_cap_exceeded` tells someone nothing about what to
   * do next, and this is the field that does.
   */
  remedy?: string;
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
    const on = safeStage(input.onStage);

    // FAILURE INVARIANT: the record exists before any work does, so a crash is still a record.
    await openRun(runId, callId, 'ingest+extract+gate');
    // The first moment the run is addressable: the row now exists, so a client can be told about it.
    on({ t: 'run', callId, runId });

    const budget = new BudgetGovernor(input.budgetCaps ?? {});
    let segments: TranscriptSegment[] = [];
    let extraction: ExtractionResult | null = null;
    let sttAttempts = 0;
    let extractAttempts = 0;
    let status: RunStatus = 'failed';
    /** Starts as whatever was typed at upload; replaced once we know what the call was about. */
    let title = input.title;
    let error: string | undefined;
    let errorCode: string | undefined;
    let remedy: string | undefined;

    try {
      // ── 1. Transcribe (registry-provided; retried on transient provider errors) ────
      const stt = await getSTT(input.sttProvider);
      on({ t: 'stage', stage: 'transcribe', state: 'start' });
      const tTranscribe = Date.now();
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
        onRetry: (attempt, reason) =>
          on({ t: 'stage', stage: 'transcribe', state: 'retry', attempt, reason }),
      });
      sttAttempts = sttRun.attempts;
      segments = sttRun.value.segments;

      await insertCall({
        id: callId,
        title: input.title,
        audio_path: input.audioPath,
        duration_ms: Math.round(sttRun.value.audio_seconds * 1000),
        separation: input.mode,
        created_at: Date.now(),
        share_id: callId,
      });
      await replaceSegments(callId, segments);
      await recordUsage(callId, stt.name, sttRun.value.usage);
      if (input.companyId) await linkCallToCompany(callId, input.companyId);
      /**
       * Emitted AFTER insertCall, deliberately: from this instant `/calls/<id>` is a real page, so
       * a client that later sees a failure can still offer to open the partial call rather than
       * handing back a dead id.
       */
      on({
        t: 'stage',
        stage: 'transcribe',
        state: 'done',
        ms: Date.now() - tTranscribe,
        detail: `${segments.length} segments · ${Math.round(sttRun.value.audio_seconds)}s of audio`,
      });

      // ── 2. Extract, then GATE, with the gate's own complaint aimed at the retry ────
      const extractor = await getExtractor();
      /**
       * Rendered ONCE and reused across retries, so every attempt sees identical context and the
       * snapshot we persist is exactly what the model was given.
       */
      const company = input.companyId
        ? await getCompany(input.companyId)
        : await companyForCall(callId);
      const accountContext = renderAccountContext(company) ?? undefined;
      /**
       * Read BEFORE this call's own learnings are written, so a call is never grounded in
       * conclusions drawn from itself.
       */
      const learnedContext = (await renderLearnedForCompany(company)) ?? undefined;
      /**
       * Which instructions are live for this call. Resolved here, once, alongside the other context
       * — the model never selects its own skills, so the set is knowable before the request and
       * recordable after it.
       */
      const skills = selectSkills({ companyId: company?.id, stage: company?.stage });
      /**
       * Read BEFORE this call's own next steps are recorded, for the same reason as the learned
       * block: a call must never be asked whether it delivered on a commitment it just made.
       */
      const openItems = await renderOpenForCompany(company);

      const tExtract = Date.now();
      const exRun = await retryAimed({
        attempts: REGISTRY_CONFIG.maxAttempts,
        run: async (_n, priorFailure) => {
          on({ t: 'stage', stage: 'extract', state: 'start', attempt: _n });

          const request = {
            callTitle: input.title,
            segments,
            priorFailure,
            accountContext,
            learnedContext,
            skillContext: skills.text ?? undefined,
            openActionItems: openItems.text ?? undefined,
          };

          /*
            BUDGET GOVERNOR: checked before the model call, not after it.

            Estimated from the message that is ACTUALLY SENT, not from the transcript alone. It used
            to be the transcript, which under-reported by the whole system prompt and every context
            block — tolerable while those were fixed and small, and wrong the moment skills made the
            preamble something a user can grow. A cap that does not see the text it is capping is
            not a cap.
          */
          budget.preflight(estimateTokens(extractPromptText(request)));

          const { draft, usage } = await extractor.extract(request);
          budget.record(usage);
          await recordUsage(callId, extractor.name, usage);
          /**
           * The gate is synchronous and finishes in single-digit milliseconds, so it is reported as
           * an instant result rather than something to wait on. What matters is WHAT it rejected.
           */
          const tGate = Date.now();
          const gated = runCitationGate(
            draft,
            segments,
            extractor.name,
            openItems.items.map((i) => i.id),
          );
          const dropped = gated.result.rejections.filter((r) => r.dropped).length;
          const flagged = gated.result.rejections.length - dropped;
          on({
            t: 'stage',
            stage: 'gate',
            state: 'done',
            ms: Date.now() - tGate,
            detail: `${dropped} dropped · ${flagged} flagged`,
          });
          return gated;
        },
        // Spend another attempt only if the gate had to delete claims outright.
        validate: (outcome) => {
          const drops = unresolvableDrops(outcome.result);
          return drops.length === 0
            ? { ok: true }
            : { ok: false, reason: `Claims deleted for citing non-existent segments — ${drops.join('; ')}` };
        },
        // The harness's whole thesis, made visible while it happens.
        onRetry: (attempt, reason) =>
          on({ t: 'stage', stage: 'extract', state: 'retry', attempt, reason }),
      });
      extractAttempts = exRun.attempts;
      /**
       * The exact block that was fed to the model, kept with the notes.
       *
       * This is the only way a context-sourced claim can ever be caught: the gate never sees the
       * prompt, so a claim invented from context but cited to a real segment passes it. Keeping the
       * context makes that auditable after the fact, and survives the company record being edited
       * later.
       */
      extraction = {
        ...exRun.value.result,
        ...(accountContext ? { company_context: accountContext } : {}),
        // Same reasoning one level up: notes written under a playbook are a different output from
        // notes written without one, so "which instructions were live" has to survive the run the
        // way `extracted_by` records which model did.
        ...(skills.ids.length ? { skills_used: skills.ids } : {}),
      };
      on({
        t: 'stage',
        stage: 'extract',
        state: 'done',
        ms: Date.now() - tExtract,
        detail: extractor.name,
      });

      /**
       * Name the call after what it turned out to be about.
       *
       * After the gate, so the title reflects claims that survived rather than a draft that may
       * have been partly deleted. With no account linked and no repeated proper noun in the
       * transcript it falls back to the theme alone rather than inventing a company name.
       */
      title = deriveCallTitle({
        draft: extraction,
        companyName: company?.name,
        transcriptSubject: subjectFromTranscript(segments),
      });
      await renameCall(callId, title);

      /**
       * What this call established about the account. Derived only from claims that already passed
       * the citation gate, so each one keeps the evidence it was gated on and stays clickable back
       * to the line that proves it. Written to its own ledger, never into the user's notes.
       */
      if (company) await recordLearnings(company.id, callId, extraction);

      /**
       * Settle what this call closed, THEN open what it promised — in that order.
       *
       * Reversed, a commitment made on this call would be in the open set that this call's own
       * judgements are applied against, and a model that restated an old commitment as a new one
       * could close the copy it had just created.
       */
      if (company) {
        await applyOutcomes(callId, extraction, segments);
        await recordActionItems(company.id, callId, extraction);
      }

      await saveExtraction(callId, extraction);
      await recordRejections(callId, runId, extraction.rejections);
      status = extraction.run_status;

      /**
       * SCORING: a best-effort enrichment, deliberately AFTER `status` is already decided.
       *
       * Scored from `extraction`'s own already-cited fields (summary, objections, next_steps,
       * key_moments, follow_up_email, outcomes) rather than from `segments` directly, so every
       * citation it can possibly produce is one a real claim already earned through the gate above
       * — see lib/scoring/score.ts. Its own try/catch is load-bearing: anything that goes wrong here
       * must never reach the outer catch below and flip an already-shipped call to 'failed'.
       */
      try {
        // Same governor instance, same caps as the main extraction above — a run's total spend is
        // capped, not just the main call's. If the extraction's own retries already used the
        // budget up, this throws DeadlineError and is caught below like any other scoring failure.
        budget.preflight(estimateTokens(scoringPromptText(extraction)));
        const scored = await scoreCall(extraction, segments);
        if (scored) {
          extraction = { ...extraction, scoring: scored.scoring };
          budget.record(scored.usage);
          await recordUsage(callId, 'scoring', scored.usage);
          await saveExtraction(callId, extraction);
        }
      } catch {
        // Scoring is additive. The call still ships/partials/fails exactly as it would have
        // without this feature, and simply has no scoring section.
      }
    } catch (err) {
      if (err instanceof DeadlineError) {
        status = 'deadline';
        error = `budget cap ${err.cap}: ${err.message}`;
      } else {
        status = 'failed';
        error = err instanceof Error ? err.message : String(err);
        /**
         * Structural, not `instanceof PyaiError`: importing the PyAI client into the harness would
         * put a vendor module on the wrong side of the registry boundary that check:ship enforces.
         * These two fields are part of our own contract, so reading them by shape is correct here.
         */
        if (typeof err === 'object' && err !== null) {
          const e = err as { code?: unknown; remedy?: unknown };
          if (typeof e.code === 'string') errorCode = e.code;
          if (typeof e.remedy === 'string') remedy = e.remedy;
        }
      }
    } finally {
      /**
       * Exactly one terminal status, always written — and now awaited.
       *
       * A `finally` that starts an async write without awaiting it would let the function return
       * while the row was still 'running', which is precisely the state the failure invariant
       * exists to prevent. Awaiting here is safe: an await in `finally` does not swallow the
       * in-flight exception, it only delays it.
       */
      await closeRun(runId, status, {
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
      title,
      error,
      errorCode,
      remedy,
    };
  });
}
