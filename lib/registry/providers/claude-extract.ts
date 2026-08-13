/**
 * Extraction provider: Claude via the first-party Anthropic API.
 *
 * PyAI's Recap would nominally do this job, but the sandbox key carries neither `recap:read` nor
 * `recap:configure` and Recap additionally needs an org add-on (docs/api-truth.md). PyAI's own
 * conversation-intelligence guide says to bring your own model for this step, so we do.
 *
 * Structured outputs (`output_config.format`) guarantee a schema-valid object, which is why there
 * is no free-text JSON parsing and no parse-and-repair loop anywhere in this repo. The bounded
 * retry that does exist is for SEMANTIC failure (a citation that doesn't resolve), not bad JSON.
 *
 * Prompt, params and response handling live in extract-shared.ts, shared with bedrock-extract.ts.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { REGISTRY_CONFIG } from '..';
import type { ExtractProvider, ExtractRequest, ExtractResult } from '../types';
import {
  buildExtractUserMessage,
  ExtractionDraftSchema,
  extractParams,
  toExtractResult,
} from './extract-shared';

export function claudeExtractor(): ExtractProvider {
  return {
    name: 'claude',

    async extract(req: ExtractRequest): Promise<ExtractResult> {
      if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
        throw new Error(
          'No Anthropic credential found (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN, or an ' +
            '`ant auth login` profile). Set one, use LLM_PROVIDER=anthropic_bedrock with AWS creds, or ' +
            'view a pre-processed sample call, which needs no credential at all.',
        );
      }
      const client = new Anthropic();

      const res = await client.messages.parse({
        model: REGISTRY_CONFIG.extractModel,
        ...extractParams(buildExtractUserMessage(req), zodOutputFormat(ExtractionDraftSchema)),
      });

      return toExtractResult(res, 'claude');
    },
  };
}
