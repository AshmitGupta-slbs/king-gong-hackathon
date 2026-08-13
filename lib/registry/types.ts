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
};

export type ExtractResult = {
  /** Ungated. Must go through the citation gate before anyone sees it. */
  draft: ExtractionDraft;
  usage: UsageReport;
};

export interface ExtractProvider {
  readonly name: string;
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
