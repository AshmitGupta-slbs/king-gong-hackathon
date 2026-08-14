import { z } from 'zod';
/**
 * Capability interfaces.
 *
 * Every provider adapts its vendor's response into OUR data contract (lib/types.ts) before
 * returning. Nothing outside lib/registry/providers/ ever sees a raw vendor payload — that is
 * what makes swapping a provider a one-file change instead of a rewrite.
 */
import type { ExtractionDraft, SeparationModeSchema, TranscriptSegment } from '@/lib/types';

/** Metered work a provider performed, so the harness can surface real minute/token burn. */
export type UsageReport = {
  /** Audio seconds processed — PyAI's jobs endpoints do NOT return x-pyai-units, so this
   *  comes from `result.audio_seconds`. See docs/api-truth.md. */
  audio_seconds?: number;
  input_tokens?: number;
  output_tokens?: number;
  /** Raw `x-pyai-units` header when the endpoint bothers to send one. */
  units?: string;
};

// ── STT ──────────────────────────────────────────────────────────────────────

/**
 * `channel` — stereo, one party per channel. Exact, model-free separation. Use for our samples.
 * `diarize` — mono. Model-based speaker attribution. Use for real uploads.
 */
export type SeparationMode = z.infer<typeof SeparationModeSchema>;

export type STTRequest = {
  audio: Uint8Array;
  filename: string;
  mode: SeparationMode;
  /** Format spoken numbers as digits — worth it on money-heavy sales calls. */
  numerals?: boolean;
};

export type STTResult = {
  /** Already in our contract: seg_NNN ids, integer ms, mapped speaker roles. */
  segments: TranscriptSegment[];
  audio_seconds: number;
  speakers: number;
  usage: UsageReport;
};

export interface STTProvider {
  readonly name: string;
  transcribe(req: STTRequest): Promise<STTResult>;
}

// ── Extraction ───────────────────────────────────────────────────────────────

export type ExtractRequest = {
  callTitle: string;
  segments: TranscriptSegment[];
  /**
   * Set on a retry: the specific reason the previous attempt failed, so the retry can fix the
   * actual problem instead of repeating the same call (bounded aimed retry).
   */
  priorFailure?: string;
  /**
   * Pre-rendered account context the user entered for this company — background the model may use
   * to interpret the call, never a source it may cite.
   *
   * A plain string on purpose: the CRM types must not cross into the registry, whose whole job is
   * that nothing outside `providers/` sees a vendor shape. Rendering happens in lib/companies.ts.
   */
  accountContext?: string;
  /**
   * What earlier calls with this account established — this system's own inference, not a human's.
   * Banner'd separately from `accountContext` in the prompt so the model is told which is which.
   */
  learnedContext?: string;
  /**
   * Pre-rendered skill instructions — HOW to read this call, never anything about it.
   *
   * Categorically different from the two context fields above, which carry facts. These are
   * directions, and they are banner'd as such so the model cannot mistake an instruction to look
   * for something for an assertion that it happened.
   */
  skillContext?: string;
  /**
   * Commitments still open from earlier calls, each carrying the stable id the model quotes back.
   * A plain string for the same reason as `accountContext`: rendering belongs to the caller, and
   * the registry must not learn what an action item is.
   */
  openActionItems?: string;
  /**
   * This call's stable id, when the caller has one.
   *
   * Optional because two callers legitimately do not: `scripts/extract-samples.ts` re-extracts
   * committed transcripts that are not calls yet. Prompt-driven providers ignore this entirely — it
   * exists for engines that key their own server-side record by call id (Recap does), where reusing
   * an id is what makes a re-run idempotent instead of a second billable extraction.
   */
  callId?: string;
  /** Account name, when known. Only used by engines that take call metadata instead of a prompt. */
  customerName?: string;
};

export type ExtractResult = {
  /** Ungated. Must go through the citation gate before anyone sees it. */
  draft: ExtractionDraft;
  usage: UsageReport;
};

/**
 * Re-exported so provider files can name the type without a second definition. It LIVES in
 * lib/engine-availability.ts, which is dependency-free on purpose -- describeRegistry() needs the same
 * answer and must not reach into a provider that imports a vendor SDK.
 */
import type { EngineAvailability } from '@/lib/engine-availability';
export type { EngineAvailability };

export interface ExtractProvider {
  readonly name: string;
  /**
   * Can this engine possibly work on this machine, right now?
   *
   * MUST NOT make a network call, because the harness calls it before spending anything and a slow or
   * flaky check would defeat the purpose. Env vars and key prefixes only.
   *
   * This exists because of a real cost. `processCall` used to resolve the extractor AFTER
   * transcription, so choosing PyAI Recap with a self-minted sandbox key transcribed the audio, then
   * failed on a 403 for a scope that key can never have. A tester did it six times and spent 3.2
   * minutes of Hear on nothing. The error message was already clear; it just arrived after the money.
   *
   * Optional so a provider that cannot fail this way need not implement it.
   */
  precheck?(): EngineAvailability;
  /**
   * TRUE for engines that cannot be given instructions — an external notes API that takes a
   * transcript and returns notes, with no system prompt.
   *
   * The harness reads this to decide what it may honestly RECORD about a run: `skills_used` and
   * `company_context` are claims that the prompt contained those things, so stamping them for an
   * engine that never saw a prompt would make the workspace assert something untrue. Absent or
   * false on every prompt-driven provider, which is why it is optional.
   */
  readonly ignoresPromptContext?: boolean;
  extract(req: ExtractRequest): Promise<ExtractResult>;
}

// ── TTS (sample-call generation only; never on the request path) ─────────────

export type TTSRequest = { text: string; voice: string };

/** Mono 16-bit little-endian PCM plus its sample rate — what we interleave into stereo. */
export type TTSResult = { pcm16: Uint8Array; sampleRate: number; usage: UsageReport };

export interface TTSProvider {
  readonly name: string;
  /** Voice ids for the two roles, so callers don't hardcode vendor-specific strings. */
  readonly voices: { rep: string; prospect: string };
  synthesize(req: TTSRequest): Promise<TTSResult>;
}
