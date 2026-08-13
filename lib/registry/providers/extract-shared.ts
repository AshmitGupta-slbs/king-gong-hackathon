/**
 * Everything the extraction providers share: the prompt, the request shape, and the response
 * handling. `claude-extract.ts` (first-party) and `bedrock-extract.ts` (AWS) differ ONLY in how
 * the client is constructed and which model id they pass.
 *
 * Keeping the prompt in one place matters more than it looks: the prompt is the part that decides
 * whether citations resolve, so two copies drifting apart would mean two different products with
 * the same gate.
 */
import type { TranscriptSegment } from '@/lib/types';
import { ExtractionDraftSchema } from '@/lib/types';
import { REGISTRY_CONFIG } from '..';
import type { ExtractRequest, ExtractResult } from '../types';

export const EXTRACT_SYSTEM = `You analyse recorded B2B sales calls and produce deal notes that a rep can act on.

THE ONE RULE: every claim you make must point at the exact transcript line that proves it.

You are given a transcript as numbered segments, each tagged with its id and speaker:
  [seg_000] rep: hi sarah thanks for making the time today
  [seg_001] prospect: we've been looking at gong and chorus honestly

For every objection, next step, intent label, key moment, and the follow-up email, populate
segment_ids with the ids of the segments that support it.

Hard requirements:
- Use ONLY segment ids that appear in the transcript you were given. Never invent an id, never
  guess at one, and never cite a segment from a different call. A citation that does not resolve
  causes the claim to be deleted by a downstream gate, so an uncited true claim is worth more to
  you than a confidently-cited false one.
- If the call genuinely contains no objections, return an empty list. Do not manufacture one to
  fill the shape. An empty list is a correct answer.
- Do not quote or paraphrase timestamps, and do not reproduce segment text in your claims — the
  system pulls the exact wording and timing from the segment you cite. Write the claim itself in
  clean, capitalised English prose.
- The transcript is raw speech-to-text output: lowercase, unpunctuated, and it will contain
  transcription errors. Read through them. Do not comment on transcript quality.

Style: write like a sharp colleague summarising the call for the rep, not like a report
generator. Claims are one specific sentence each. The follow-up email is short, concrete, and
references only what was actually agreed on the call.`;

/** `[seg_000] rep: text` — the exact shape the system prompt documents. */
export function renderTranscript(segments: TranscriptSegment[]): string {
  return segments.map((s) => `[${s.id}] ${s.speaker}: ${s.text}`).join('\n');
}

export function buildExtractUserMessage(req: ExtractRequest): string {
  const ids = req.segments.map((s) => s.id);
  let user =
    `Call: ${req.callTitle}\n` +
    `Valid segment ids for this call: ${ids[0]} … ${ids[ids.length - 1]} (${ids.length} segments)\n\n` +
    `TRANSCRIPT\n${renderTranscript(req.segments)}`;

  // Bounded AIMED retry: the previous attempt's actual failure goes into the prompt, so the retry
  // can fix the specific problem instead of repeating the same call.
  if (req.priorFailure) {
    user +=
      `\n\nYour previous attempt was rejected by the citation gate:\n${req.priorFailure}\n` +
      `Fix exactly that. Cite only ids present in the list above, and drop any claim you cannot ` +
      `ground in a real segment rather than re-citing a missing one.`;
  }
  return user;
}

/**
 * Request params shared by both providers. `model` is supplied by the caller.
 * Generic over the format so the SDK's concrete `JSONOutputFormat` type survives.
 */
export function extractParams<F>(userMessage: string, outputFormat: F) {
  return {
    max_tokens: REGISTRY_CONFIG.budget.maxOutputTokens,
    thinking: { type: 'adaptive' as const },
    output_config: {
      effort: REGISTRY_CONFIG.extractEffort,
      format: outputFormat,
    },
    system: EXTRACT_SYSTEM,
    messages: [{ role: 'user' as const, content: userMessage }],
  };
}

/** The zod schema both providers force output against. */
export { ExtractionDraftSchema };

type ParsedResponse = {
  parsed_output?: unknown;
  stop_reason?: string | null;
  stop_details?: { category?: string | null } | null;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
};

/**
 * Shared response handling, including the refusal path.
 *
 * The parsed output is re-validated against the schema at this boundary. Structured outputs
 * should already guarantee the shape, but validating here means a provider quirk — Bedrock's
 * endpoint returning something subtly different, say — fails loudly right here instead of
 * flowing into the gate and producing a confidently wrong result.
 */
export function toExtractResult(res: ParsedResponse, providerLabel: string): ExtractResult {
  if (res.stop_reason === 'refusal') {
    throw new Error(
      `${providerLabel} refused the extraction (category: ${res.stop_details?.category ?? 'unknown'})`,
    );
  }
  if (res.stop_reason === 'max_tokens') {
    // Structured output that hit the cap is truncated and therefore untrustworthy — better to
    // fail loudly than to hand a half-built object to the gate.
    throw new Error(
      `${providerLabel} hit max_tokens before completing the object; raise OPENGONG_MAX_OUTPUT_TOKENS`,
    );
  }
  if (!res.parsed_output) {
    throw new Error(`${providerLabel} returned no parsed output (stop_reason=${res.stop_reason})`);
  }

  const validated = ExtractionDraftSchema.safeParse(res.parsed_output);
  if (!validated.success) {
    throw new Error(
      `${providerLabel} returned output that does not match the extraction contract: ` +
        validated.error.issues
          .slice(0, 4)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; '),
    );
  }

  return {
    draft: validated.data,
    usage: {
      input_tokens: res.usage?.input_tokens ?? 0,
      output_tokens: res.usage?.output_tokens ?? 0,
    },
  };
}
