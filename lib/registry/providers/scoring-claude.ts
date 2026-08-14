/**
 * The one place lib/scoring/ is allowed to reach a vendor SDK from — check:ship enforces that no
 * vendor SDK is ever imported outside lib/registry/providers/, with no exception for new features.
 *
 * Deliberately NOT registered in the extract/STT/TTS factory tables in lib/registry/index.ts: this
 * isn't a swappable capability the rest of the app asks the registry for, it's a single narrow call
 * the scoring feature makes for itself. It still belongs here, and only here, because the boundary
 * check:ship enforces is about where a vendor SDK may be imported, not about what registers as a
 * capability.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { ZodType } from 'zod';
import { REGISTRY_CONFIG } from '..';

export type ScoringModelResult<T> = {
  parsed_output?: T;
  stop_reason?: string | null;
  stop_details?: { category?: string | null } | null;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
};

/**
 * A schema-forced Claude call for the scoring feature. The caller is responsible for checking a
 * credential exists before calling this — it does not itself decide whether scoring should be
 * attempted, only how to make the request once the caller has.
 */
export async function runScoringModel<T>(
  system: string,
  userMessage: string,
  schema: ZodType<T>,
): Promise<ScoringModelResult<T>> {
  const client = new Anthropic();
  const res = await client.messages.parse({
    model: REGISTRY_CONFIG.extractModel,
    max_tokens: 8_000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: REGISTRY_CONFIG.extractEffort,
      format: zodOutputFormat(schema),
    },
    system,
    messages: [{ role: 'user', content: userMessage }],
  });
  return res as unknown as ScoringModelResult<T>;
}
