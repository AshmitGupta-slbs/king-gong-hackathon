/**
 * Extraction provider: Claude on AWS Bedrock.
 *
 * Uses the **Mantle** client — the Messages-API Bedrock endpoint
 * (`https://bedrock-mantle.{region}.api.aws/anthropic`). This is deliberate and worth stating,
 * because there are two Bedrock integrations and only one of them works here:
 *
 *   • Legacy `InvokeModel`/`Converse` with ARN-versioned ids (`anthropic.claude-...-v1:0`) —
 *     Claude Opus 5 has NO ARN-versioned id, so it does not appear in that model table at all.
 *   • Mantle / Messages API with bare prefixed ids (`anthropic.claude-opus-5`) — this one.
 *
 * Verified before writing this: `messages.parse` exists on the Mantle client, so structured
 * outputs work here exactly as on the first-party API, and Bedrock's feature list explicitly
 * includes structured outputs. Nothing this app uses is on Bedrock's unsupported list.
 *
 * Credentials resolve automatically, by the SDK's own precedence:
 *   apiKey arg > awsAccessKey/awsSecretAccessKey > AWS_BEARER_TOKEN_BEDROCK > default AWS chain
 *   region: awsRegion arg > AWS_REGION > AWS_DEFAULT_REGION
 * So exporting AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION is enough — there is
 * nothing to pass explicitly. Note the arg name is `awsSecretAccessKey` on this client (the
 * legacy `AnthropicBedrock` client and some docs examples use `awsSecretKey`).
 *
 * Also needed, and NOT something code can arrange: Anthropic model access must be enabled for
 * your account in the Bedrock console, in that region.
 */
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { REGISTRY_CONFIG } from '..';
import type { ExtractProvider, ExtractRequest, ExtractResult } from '../types';
import {
  buildExtractUserMessage,
  ExtractionDraftSchema,
  extractParams,
  toExtractResult,
} from './extract-shared';

/** Bedrock model ids carry an `anthropic.` prefix; first-party ids do not. */
function bedrockModelId(model: string): string {
  return model.startsWith('anthropic.') ? model : `anthropic.${model}`;
}

function hasAwsCredentials(): boolean {
  return Boolean(
    (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
      process.env.AWS_BEARER_TOKEN_BEDROCK ||
      process.env.AWS_PROFILE ||
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
      process.env.AWS_WEB_IDENTITY_TOKEN_FILE,
  );
}

export function bedrockExtractor(): ExtractProvider {
  return {
    name: 'bedrock',

    async extract(req: ExtractRequest): Promise<ExtractResult> {
      const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
      if (!region) {
        throw new Error(
          'AWS_REGION is not set. The Bedrock client does not read ~/.aws/config for the region, ' +
            'so it must come from AWS_REGION (or AWS_DEFAULT_REGION).',
        );
      }
      if (!hasAwsCredentials()) {
        throw new Error(
          'No AWS credentials found. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (or ' +
            'AWS_BEARER_TOKEN_BEDROCK, or AWS_PROFILE), plus AWS_REGION.',
        );
      }

      // No explicit credential args: let the SDK resolve them so env vars, profiles, and
      // container/IRSA roles all work without a code change.
      const client = new AnthropicBedrockMantle({ awsRegion: region });

      try {
        const res = await client.messages.parse({
          model: bedrockModelId(REGISTRY_CONFIG.extractModel),
          ...extractParams(buildExtractUserMessage(req), zodOutputFormat(ExtractionDraftSchema)),
        });
        return toExtractResult(res, 'bedrock');
      } catch (err) {
        // The two failures most likely on a first run, called out so nobody debugs the prompt
        // when the real problem is an AWS console checkbox.
        const msg = err instanceof Error ? err.message : String(err);
        if (/AccessDenied|not authorized|don't have access|model access/i.test(msg)) {
          throw new Error(
            `Bedrock denied access to ${bedrockModelId(REGISTRY_CONFIG.extractModel)} in ${region}. ` +
              `Enable Anthropic model access in the Bedrock console for this region, and check the ` +
              `IAM principal can call bedrock:InvokeModel. Original: ${msg}`,
          );
        }
        if (/ValidationException|invalid.*(effort|thinking|output_config)/i.test(msg)) {
          throw new Error(
            `Bedrock rejected a request parameter — likely effort or adaptive thinking on this ` +
              `endpoint. Try OPENGONG_EFFORT=high or drop effort, then re-run. Original: ${msg}`,
          );
        }
        throw err;
      }
    },
  };
}
