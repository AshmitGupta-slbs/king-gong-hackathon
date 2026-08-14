/**
 * The Bedrock counterpart to scoring-claude.ts, for deployments where the main extractor is
 * `bedrock` (AWS SigV4, no Anthropic API key at all — see bedrock-extract.ts's own header comment).
 *
 * Deliberately simpler than `bedrockExtractor()`'s structured-output → tool-call fallback dance:
 * scoring is a best-effort enrichment, so if this endpoint ever rejects `output_config`/`thinking`,
 * this throws, the caller's existing try/catch (lib/harness/loop.ts) catches it, and scoring is
 * skipped for that run — exactly like a missing credential is handled today. Not worth duplicating
 * ~80 lines of fallback logic for a feature whose failure has zero effect on the call itself.
 */
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { ZodType } from 'zod';
import { REGISTRY_CONFIG } from '..';
import { bedrockClient, hasAwsCredentials, resolveBedrockModelId } from './bedrock-extract';
import type { ScoringModelResult } from './scoring-claude';

export function hasBedrockCredentials(): boolean {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  return Boolean(region) && hasAwsCredentials();
}

export async function runScoringModelBedrock<T>(
  system: string,
  userMessage: string,
  schema: ZodType<T>,
): Promise<ScoringModelResult<T>> {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!region) {
    throw new Error('AWS_REGION is not set — required for the Bedrock scoring path.');
  }
  const client = bedrockClient(region);
  const model = await resolveBedrockModelId(REGISTRY_CONFIG.extractModel, region);

  const res = await client.messages.parse({
    model,
    max_tokens: 12_000,
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
