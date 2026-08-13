/**
 * Extraction provider: Claude on AWS Bedrock.
 *
 * Uses the **Mantle** client — the Messages-API endpoint
 * (`https://bedrock-mantle.{region}.api.aws/anthropic`). This is deliberate, because there are two
 * AWS integrations and only one of them works here:
 *
 *   • Legacy `InvokeModel`/`Converse`, whose ids are ARN-versioned and `anthropic.`-prefixed
 *     (`anthropic.claude-...-v1:0`) — a different product, and Claude Opus 5 has no such id.
 *   • Mantle, an Anthropic **Messages API** surface — this one. Its ids are the plain first-party
 *     strings: `claude-opus-5`, with **NO** provider prefix.
 *
 * MODEL IDS ARE BARE HERE, and an earlier version of this file got that wrong in a way worth
 * recording. It applied `anthropic.` to every id, and the comment in this spot confidently
 * explained why that was correct. It was not: the first real request returned
 * `404 not_found_error: The model 'anthropic.claude-opus-5' does not exist` — an authenticated
 * response, in Anthropic's own error envelope, rejecting only the model string. The prefix rule was
 * carried over from legacy Bedrock and written into a comment without the path ever being executed,
 * while §08 of the docs listed this provider as "Blocked · never executed" the whole time. If you
 * are tempted to add a prefix back, run `npm run check:model` first — it will tell you.
 *
 * What the SDK itself says (`node_modules/@anthropic-ai/bedrock-sdk/mantle-client.d.ts`): "Only the
 * `messages` and `beta.messages` resources are supported", and it wires up the same
 * `Resources.Messages` as the first-party client. So `messages.parse` and structured outputs behave
 * exactly as they do first-party — which is why this provider needs no JSON repair path.
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

function hasAwsCredentials(): boolean {
  return Boolean(
    (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
      process.env.AWS_BEARER_TOKEN_BEDROCK ||
      process.env.AWS_PROFILE ||
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
      process.env.AWS_WEB_IDENTITY_TOKEN_FILE,
  );
}

/** What a model-id probe found. `denied` means the id is right but unusable here. */
export type ModelProbe = { outcome: 'resolved' | 'not_found' | 'denied' | 'error'; detail: string };

/**
 * Ask the endpoint whether it resolves one model id, with the smallest legal request.
 *
 * Lives HERE rather than in the diagnostic script for two reasons: nothing outside
 * `lib/registry/providers/` may import a vendor SDK (asserted by `check:ship`, which caught exactly
 * this), and the probe must construct its client the same way extraction does or it can answer a
 * question about a different code path than the one that failed.
 *
 * Deliberately does not use `extractParams` — effort and adaptive thinking are themselves things an
 * endpoint can reject, and that would confound a test about model naming.
 */
export async function probeBedrockModel(region: string, model: string): Promise<ModelProbe> {
  const client = new AnthropicBedrockMantle({ awsRegion: region });
  try {
    await client.messages.create({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });
    return { outcome: 'resolved', detail: '' };
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 160);
    if (/not_found_error|does not exist|404/i.test(msg)) return { outcome: 'not_found', detail: msg };
    if (/AccessDenied|not authorized|don't have access|model access|403/i.test(msg)) {
      return { outcome: 'denied', detail: msg };
    }
    return { outcome: 'error', detail: msg };
  }
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

      // The configured id is sent VERBATIM. Nothing here rewrites it — see the header comment.
      // `OPENGONG_MODEL` is therefore genuinely authoritative, which matters: while this function
      // silently prefixed ids, setting OPENGONG_MODEL=claude-opus-5 still sent
      // `anthropic.claude-opus-5`, so the documented override could not work around the bug.
      const model = REGISTRY_CONFIG.extractModel;

      try {
        const res = await client.messages.parse({
          model,
          ...extractParams(buildExtractUserMessage(req), zodOutputFormat(ExtractionDraftSchema)),
        });
        return toExtractResult(res, 'bedrock');
      } catch (err) {
        // The failures most likely on a first run, called out so nobody debugs the prompt when the
        // real problem is a model id, an AWS console checkbox, or an unsupported parameter.
        const msg = err instanceof Error ? err.message : String(err);

        // A 404 here is NOT a credentials problem, and it reads like one. The request was signed,
        // accepted and answered; only the model string was rejected. Say so, because the instinct
        // on seeing 404 is to re-check the keys.
        if (/not_found_error|does not exist|404/i.test(msg)) {
          throw new Error(
            `The endpoint accepted your credentials but does not recognise the model "${model}" ` +
              `in ${region}. This is not an auth failure — the request was signed and answered.\n` +
              `  • Run \`npm run check:model\` to see which ids this account actually accepts.\n` +
              `  • Then set OPENGONG_MODEL to one of them.\n` +
              `  • Note ids on this endpoint are BARE (claude-opus-5); an "anthropic." prefix is ` +
              `legacy Bedrock InvokeModel and will 404 here.\n` +
              `Original: ${msg}`,
          );
        }
        if (/AccessDenied|not authorized|don't have access|model access/i.test(msg)) {
          throw new Error(
            `Bedrock denied access to ${model} in ${region}. ` +
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
