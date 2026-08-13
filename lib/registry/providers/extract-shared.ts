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

ACCOUNT CONTEXT, when present, is background a human typed in before the call. It was NOT said on
this call. It exists to sharpen what you look for — an account flagged price-sensitive means listen
harder for pricing objections — and for nothing else. Two absolute rules:
- NEVER cite a transcript segment for a claim that actually came from the account context. If the
  context says they are price-sensitive and the call contains no pricing objection, there is no
  pricing objection to report. Citing a line that does not say it silently destroys the one
  guarantee this product makes, and the gate cannot catch it for you.
- Write every claim in the vocabulary of the transcript, not of the context. Do not fold the
  industry, the deal stage, the amount, or wording from the notes into a claim; the claim is
  checked for overlap against the line you cite, so borrowed context words make a true claim look
  unsupported.

OPEN ACTION ITEMS, when present, are commitments made on EARLIER calls. Judge each one against this
call and return it in \`outcomes\`, quoting its id exactly as given:
- "done" ONLY if this call contains a line saying the thing happened. Cite that line. A promise to
  do it, a repeated promise, or an update that it is still pending are all NOT done.
- "not_discussed" otherwise. It needs no citation, because nothing to cite is the whole point, and
  it is the ordinary answer for most items on most calls. An item left open costs one line next
  time; an item wrongly closed means nobody ever chases it again.
Write the accompanying note in the words of THIS call. Do not restate the commitment's original
wording — the note is checked against the line you cite, and last call's phrasing will not match it.

HOW TO READ THIS CALL, when present, is a set of instructions — what to listen for, how to weigh
what you hear, what counts as a real commitment. It says nothing about what happened on this call.
Two rules follow, and they are the same shape as the ones above:
- An instruction to look for something is NEVER evidence that it is there. A direction to listen
  for who else has to approve the purchase does not mean anyone else has to approve it. If you
  looked and the call does not contain it, the correct answer is that there is nothing to report.
- Write in the words of the transcript, not the words of the instructions. The vocabulary in those
  instructions is there to help you read; a claim built out of it will not match the line you cite.

Style: write like a sharp colleague summarising the call for the rep, not like a report
generator. Claims are one specific sentence each. The follow-up email is short, concrete, and
references only what was actually agreed on the call.`;

/** `[seg_000] rep: text` — the exact shape the system prompt documents. */
export function renderTranscript(segments: TranscriptSegment[]): string {
  return segments.map((s) => `[${s.id}] ${s.speaker}: ${s.text}`).join('\n');
}

export function buildExtractUserMessage(req: ExtractRequest): string {
  const ids = req.segments.map((s) => s.id);
  /**
   * Account context goes ABOVE the transcript, clearly fenced and clearly labelled as not-said.
   * Below it would put it between the transcript and the retry instruction that gets appended on a
   * second attempt, which reads as a continuation of the call.
   */
  const context = req.accountContext
    ? `ACCOUNT CONTEXT (typed by the user, NOT said on this call — background only, never citable)\n` +
      `${req.accountContext}\n\n`
    : '';

  /**
   * Separately banner'd from the user's notes on purpose: this is what THIS SYSTEM concluded from
   * earlier recordings, not something a person asserted. Same prohibition applies — it is background
   * for interpretation, and a claim about THIS call still needs a line from THIS transcript.
   */
  const learned = req.learnedContext
    ? `LEARNED ON EARLIER CALLS WITH THIS ACCOUNT (derived by this system from previous ` +
      `recordings, NOT said on this call — background only, never citable)\n` +
      `${req.learnedContext}\n\n`
    : '';

  /**
   * Instructions, not facts — and the distinction is the entire reason this is its own block.
   *
   * The two blocks above carry claims about the world that the model must not cite. This one carries
   * directions about how to read, which it must not cite EITHER, and for a sharper reason: an
   * instruction to look for something reads a great deal like an assertion that it is there. A skill
   * saying "listen for who else has to approve" must never become "someone else has to approve".
   */
  const skills = req.skillContext
    ? `HOW TO READ THIS CALL (instructions, not facts — nothing here happened on this call, ` +
      `nothing here is citable, and no claim may be made because a skill mentions it)\n` +
      `${req.skillContext}\n\n`
    : '';

  /**
   * Open commitments sit with the rest of the background, above the transcript, because that is
   * what they are: things said on OTHER calls. Each carries the id the model must quote back, which
   * is what lets a judgement attach to a specific commitment instead of being matched on wording.
   */
  const openItems = req.openActionItems
    ? `OPEN ACTION ITEMS FROM EARLIER CALLS (agreed previously, NOT said on this call — never ` +
      `citable as evidence of anything). For each one, decide from THIS call whether it happened, ` +
      `and return it in \`outcomes\` quoting its id exactly.\n${req.openActionItems}\n\n`
    : '';

  let user =
    `Call: ${req.callTitle}\n` +
    `Valid segment ids for this call: ${ids[0]} … ${ids[ids.length - 1]} (${ids.length} segments)\n\n` +
    skills +
    context +
    learned +
    openItems +
    `TRANSCRIPT (cite these ids for every claim)\n${renderTranscript(req.segments)}`;

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
 * Everything that will be sent as input, as one string.
 *
 * Exists so the budget governor can size the real request without the harness having to know how a
 * prompt is assembled. Previously the governor estimated from the transcript alone and silently
 * ignored the system prompt and every context block; keeping the answer here means the estimate
 * cannot drift from the message again, because both come from the same builder.
 */
export function extractPromptText(req: ExtractRequest): string {
  return `${EXTRACT_SYSTEM}\n${buildExtractUserMessage(req)}`;
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
