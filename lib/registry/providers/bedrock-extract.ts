/**
 * Extraction provider: Claude on AWS Bedrock.
 *
 * Uses **`AnthropicBedrock`** — the Bedrock Runtime Messages API — matching the reference
 * implementation this deployment shares with its sibling services (dwight's
 * `_complete_anthropic_bedrock`, `agent-service/app/llm_client.py:702`, re-verified against the same
 * code in `org-agent/agent/engine/llm_client.py`). That reference is a working production path for
 * the exact configuration used here, which is why it is followed rather than reasoned about.
 *
 * There is no gateway, no `baseURL` override and no API key on this path: authentication is pure
 * AWS SigV4 from the credential chain. `ANTHROPIC_API_KEY` is never consulted.
 *
 * MODEL IDS ARE NORMALISED BY SHAPE, in lib/bedrock-model-id.ts — read that file before touching
 * anything about the `model` value. The short version: Bedrock accepts ARNs, cross-region profiles,
 * foundation ids, and bare application-inference-profile ids, and they need different handling. An
 * earlier version of this provider prefixed everything with `anthropic.`, which mangled a profile id
 * into `anthropic.3s3wyt6beb2x` and produced a 404 that reads exactly like a region problem.
 *
 * `AWS_ACCOUNT_ID` and `LLM_MODEL` are both OPTIONAL — the default model is a cross-region inference
 * profile that needs neither, and a bare profile id gets its account from STS. Requiring either of
 * them, as an earlier version did, broke a configuration that works everywhere else.
 *
 * Deliberate differences from the reference, both recorded because they are judgement calls:
 *   • When STS also cannot answer, we throw rather than sending the unexpanded id with a warning —
 *     that path produces a 404 that reads like a region problem, which is worse than a clear stop.
 *   • We ask for structured output first; the reference only ever uses tool calling (see below).
 *
 * Also needed, and NOT something code can arrange: Anthropic model access must be enabled for the
 * account in the Bedrock console, in that region — or the profile must grant it.
 */
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { REGISTRY_CONFIG } from '..';
import { bedrockModelId, needsAccountId } from '@/lib/bedrock-model-id';
import type { ExtractProvider, ExtractRequest, ExtractResult } from '../types';
import {
  buildExtractUserMessage,
  EXTRACT_SYSTEM,
  ExtractionDraftSchema,
  extractParams,
  toExtractResult,
} from './extract-shared';

/**
 * Above this cap the SDK refuses a non-streaming request — it estimates the response will exceed
 * its timeout — so the reference switches to `messages.stream` and takes the final message. Ported
 * because raising `OPENGONG_MAX_OUTPUT_TOKENS` past the default would otherwise start failing for a
 * reason with nothing to do with this app.
 */
const STREAM_ABOVE_MAX_TOKENS = 16_000;

/** The forced-tool fallback's name; only ever seen in a request, never persisted. */
const FALLBACK_TOOL = 'record_deal_notes';

/**
 * One client construction, shared by extraction and the probe, so a diagnostic can never answer for
 * a different code path than the one that failed.
 *
 * Every credential is passed as `?? null`, which is what makes the default AWS chain work: the SDK
 * falls back to an IAM role or `~/.aws` when a value is null. The reference does exactly this, and
 * it is likely how the real deployments authenticate. Note the arg names on THIS client are
 * `awsAccessKey` / `awsSecretKey` — the Mantle client uses `awsSecretAccessKey`, and mixing them up
 * silently drops the credential.
 */
export function bedrockClient(region: string): AnthropicBedrock {
  const awsAccessKey = process.env.AWS_ACCESS_KEY_ID?.trim();
  const awsSecretKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
  const awsSessionToken = process.env.AWS_SESSION_TOKEN?.trim() ?? null;

  // The options are a discriminated union — an explicit key PAIR, or neither. Passing one alone (or
  // a nullable of each) is rejected at compile time, which is a good constraint: half-supplied
  // credentials would otherwise silently fall through to the default chain and authenticate as
  // somebody else entirely.
  return awsAccessKey && awsSecretKey
    ? new AnthropicBedrock({ awsRegion: region, awsAccessKey, awsSecretKey, awsSessionToken })
    : new AnthropicBedrock({ awsRegion: region });
}

/**
 * Cached STS answer, failure included, so a broken lookup costs one call per process rather than one
 * per request. `null` = asked and could not tell; `undefined` = not asked yet.
 */
let stsAccount: string | null | undefined;

/** Test seam: lets the STS path be exercised without a network or credentials. */
let stsTransport: typeof fetch | null = null;
export function __setStsTransport(f: typeof fetch | null): void {
  stsTransport = f;
  stsAccount = undefined;
}

/**
 * Learn the AWS account id, so a bare application-inference-profile id can be expanded to an ARN.
 *
 * `AWS_ACCOUNT_ID` wins; otherwise ask `sts:GetCallerIdentity`, which needs no IAM permission of its
 * own and is what makes this safe to do automatically. That fallback is why the sibling services run
 * with the variable blank — and why requiring it here was a regression, not a safety measure.
 *
 * Lives in the provider rather than in lib/bedrock-model-id.ts on purpose: signing needs AWS
 * packages, and nothing outside `lib/registry/providers/` may import a vendor SDK. Signing is
 * delegated to `@smithy/signature-v4` rather than hand-rolled, and every package used here is
 * already installed as an `@anthropic-ai/bedrock-sdk` dependency, so none of this adds install
 * weight.
 *
 * Never throws — a failure returns null and the caller reports it with the remedy.
 */
async function resolveAccountId(region: string): Promise<string | null> {
  const fromEnv = process.env.AWS_ACCOUNT_ID?.trim();
  if (fromEnv) return fromEnv;
  if (stsAccount !== undefined) return stsAccount;

  try {
    const [{ SignatureV4 }, { fromNodeProviderChain }, { Sha256 }] = await Promise.all([
      import('@smithy/signature-v4'),
      import('@aws-sdk/credential-providers'),
      import('@aws-crypto/sha256-js'),
    ]);
    const body = 'Action=GetCallerIdentity&Version=2011-06-15';
    const hostname = `sts.${region}.amazonaws.com`;
    const signed = await new SignatureV4({
      service: 'sts',
      region,
      credentials: fromNodeProviderChain(),
      sha256: Sha256,
    }).sign({
      method: 'POST',
      protocol: 'https:',
      hostname,
      path: '/',
      headers: { host: hostname, 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body,
    });
    const send = stsTransport ?? fetch;
    const res = await send(`https://${hostname}/`, {
      method: 'POST',
      headers: signed.headers as Record<string, string>,
      body,
    });
    // The response is a handful of XML elements; a regex beats adding a parser for one field.
    stsAccount = /<Account>(\d+)<\/Account>/.exec(await res.text())?.[1] ?? null;
  } catch {
    stsAccount = null;
  }
  return stsAccount;
}

/**
 * The model id Bedrock will actually be sent. Resolves an account only when the configured value
 * needs one, so the common cases — the cross-region default, an ARN, a foundation id — never touch
 * the network.
 */
export async function resolveBedrockModelId(model: string, region: string): Promise<string> {
  const accountId = needsAccountId(model) ? await resolveAccountId(region) : null;
  return bedrockModelId(model, region, accountId);
}

export function hasAwsCredentials(): boolean {
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
  const client = bedrockClient(region);
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

/** What `toExtractResult` needs, however the object was obtained. */
type ParsedLike = {
  parsed_output?: unknown;
  stop_reason?: string | null;
  stop_details?: { category?: string | null } | null;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
};

/**
 * The preferred path: server-enforced structured output.
 *
 * Streams above `STREAM_ABOVE_MAX_TOKENS` because the SDK refuses a non-streaming request with a cap
 * that high. `messages.parse` has no streaming form, so the streaming branch collects the text and
 * validates it with the same Zod schema — which `toExtractResult` then re-validates anyway, so a
 * quirk in either path fails at the boundary rather than reaching the gate.
 */
async function structuredExtract(
  client: AnthropicBedrock,
  model: string,
  userMessage: string,
): Promise<ParsedLike> {
  const params = { model, ...extractParams(userMessage, zodOutputFormat(ExtractionDraftSchema)) };

  if (params.max_tokens > STREAM_ABOVE_MAX_TOKENS) {
    const msg = await client.messages.stream(params).finalMessage();
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return {
      ...msg,
      parsed_output: ExtractionDraftSchema.parse(JSON.parse(text)),
    };
  }
  return client.messages.parse(params);
}

/**
 * The fallback: one forced tool call whose input schema IS the extraction schema.
 *
 * This is the shape the reference implementation uses in production, so it is the safe harbour when
 * structured outputs are refused. Note what it drops — `output_config` (effort and format) and
 * adaptive `thinking` — because those are exactly the parameters a rejection would be complaining
 * about. `tool_choice` forces the call, so there is no free-text branch to parse and no repair loop;
 * the tool input is validated by the same schema.
 */
async function toolExtract(
  client: AnthropicBedrock,
  model: string,
  userMessage: string,
): Promise<ParsedLike> {
  const format = zodOutputFormat(ExtractionDraftSchema) as unknown as { schema: Record<string, unknown> };
  const params = {
    model,
    max_tokens: REGISTRY_CONFIG.budget.maxOutputTokens,
    system: EXTRACT_SYSTEM,
    messages: [{ role: 'user' as const, content: userMessage }],
    tools: [
      {
        name: FALLBACK_TOOL,
        description: 'Record the deal notes for this call. Every claim must cite its segment ids.',
        input_schema: format.schema as never,
      },
    ],
    tool_choice: { type: 'tool' as const, name: FALLBACK_TOOL },
  };

  const msg =
    params.max_tokens > STREAM_ABOVE_MAX_TOKENS
      ? await client.messages.stream(params).finalMessage()
      : await client.messages.create(params);

  const call = msg.content.find((b) => b.type === 'tool_use');
  if (!call || call.type !== 'tool_use') {
    throw new Error(
      `bedrock tool-call fallback: the model returned no ${FALLBACK_TOOL} call ` +
        `(stop_reason=${msg.stop_reason}). Nothing to gate.`,
    );
  }
  return {
    ...msg,
    // A forced tool call still arrives as untrusted input, so validate before it goes anywhere.
    parsed_output: ExtractionDraftSchema.parse(call.input),
  };
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

      const client = bedrockClient(region);

      // Resolved by shape — a bare application-inference-profile id becomes a full ARN here, which
      // may require one cached STS call to learn the account. `LLM_MODEL` is optional: the registry
      // default is already a cross-region inference profile and needs none of that.
      const model = await resolveBedrockModelId(REGISTRY_CONFIG.extractModel, region);
      const userMessage = buildExtractUserMessage(req);

      try {
        try {
          return toExtractResult(
            await structuredExtract(client, model, userMessage),
            'bedrock',
          );
        } catch (err) {
          /**
           * Structured outputs are the better path — the schema is enforced server-side and there is
           * no JSON to repair — but they are also the one part of this request the reference does NOT
           * exercise: it drives Bedrock purely with tool calling and never sends `output_config` or
           * `thinking`. So if this endpoint rejects those parameters, fall back to the shape that is
           * known to work rather than failing the run.
           *
           * Only parameter rejections are caught. A 404, an auth failure or a refusal must keep
           * propagating, or the fallback would mask the real problem and double the cost doing it.
           */
          const m = err instanceof Error ? err.message : String(err);
          if (!/ValidationException|output_config|structured|thinking|unsupported|invalid.*param/i.test(m)) {
            throw err;
          }
          return toExtractResult(await toolExtract(client, model, userMessage), 'bedrock (tool-call fallback)');
        }
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
        /**
         * The account cannot invoke this model on-demand and needs an inference profile. Distinct
         * from a 404 and from an auth failure: the id is real and the credentials are fine, but this
         * *kind* of id is not invocable here. The API's own wording is the fix, so it is passed on
         * with the concrete value to set rather than paraphrased.
         */
        if (/on-demand throughput isn.?t supported|inference profile that contains this model/i.test(msg)) {
          throw new Error(
            `Bedrock will not invoke "${model}" on-demand: this account has no provisioned ` +
              `throughput for it, so a foundation id cannot be used directly.\n` +
              `Set LLM_MODEL to an inference profile instead:\n` +
              `  • your application-inference-profile id (plus AWS_ACCOUNT_ID), or its full ARN;\n` +
              `  • or a cross-region profile — global.anthropic.claude-sonnet-4-6.\n` +
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
