/**
 * Extraction provider: Claude on AWS Bedrock.
 *
 * Uses the **Mantle** client — the Messages-API endpoint
 * (`https://bedrock-mantle.{region}.api.aws/anthropic`). Three AWS surfaces are easy to confuse,
 * and the difference is the model-id format:
 *
 *   • Legacy `InvokeModel`/`Converse` — ARN-versioned ids (`anthropic.claude-...-v1:0`), different
 *     request shape. Not used here.
 *   • **Mantle — Claude in Amazon Bedrock. THIS ONE.** Serves the same Messages API shape as
 *     first-party, and ids carry an `anthropic.` **provider prefix**: `anthropic.claude-opus-5`.
 *   • Claude Platform on AWS — `AnthropicAws` on `aws-external-anthropic.{region}.api.aws`,
 *     Anthropic-operated, **bare** ids. A separate product; not this client.
 *
 * THE PREFIX IS REQUIRED HERE, and it took two opposite mistakes to establish that, both worth
 * recording because the reasoning that produced them is seductive:
 *
 *  1. The original prefix was correct, but its comment was written from recall without the path
 *     ever being executed — §08 carried this provider as "Blocked · never executed" throughout.
 *     Right answer, unearned.
 *  2. It was then *removed*, on the inference that a Messages-API surface must take first-party
 *     ids. That does not follow, and the authoritative doc pre-empts it in one sentence: Mantle
 *     "serves the same Messages API shape — but model IDs carry an `anthropic.` provider prefix",
 *     with an explicit mapping `claude-opus-5` → `anthropic.claude-opus-5` and the warning "do not
 *     generate a first-party `claude-*` ID for a Bedrock client — it will 400". The bare-id rule
 *     belongs to Claude Platform on AWS, a *different* offering whose docs say so on their first
 *     line. Messages-shaped and bare-id are independent properties.
 *
 * So a 404 on `anthropic.claude-opus-5` is a well-formed id the account or region cannot serve —
 * not a naming problem. `npm run check:model` distinguishes those two empirically; prefer it over
 * anyone's reading, including this comment's.
 *
 * Structured outputs: the SDK wires the same `Resources.Messages` as the first-party client
 * (`mantle-client.d.ts` — "only the `messages` and `beta.messages` resources are supported"), so
 * `messages.parse` behaves as it does first-party and this provider needs no JSON repair path.
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

/**
 * Bedrock ids carry the `anthropic.` provider prefix. An id that already has one is passed through
 * untouched, so `LLM_MODEL` can name either form and still mean what it says.
 */
export function bedrockModelId(model: string): string {
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

      const model = bedrockModelId(REGISTRY_CONFIG.extractModel);

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
            `Bedrock has no "${model}" available in ${region}.\n` +
              `This is NOT an auth failure — the request was signed, accepted and answered, and the ` +
              `id format is correct for Bedrock (the "anthropic." prefix is required here).\n` +
              `So the variable is the region or model access, not the name:\n` +
              `  • Run \`npm run check:model\` — it probes every candidate id and separates ` +
              `"not offered here" from "offered but not enabled for you".\n` +
              `  • Try a region that serves this model (us-east-1 / us-west-2) and enable Anthropic ` +
              `model access there in the Bedrock console.\n` +
              `  • Or pick a model the region does serve: LLM_MODEL=claude-sonnet-5.\n` +
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
