import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { renderEscalationPrompt, type PromptOptions } from './bedrock-prompt.js';
import { ModelUnavailableError, type EscalationRequest, type ModelCallOptions, type ModelClient } from './model-client.js';

export const NOVA_PRO_MODEL_ID = 'amazon.nova-pro-v1:0';
/** The project's only Region; the client refuses any other. */
export const BEDROCK_REGION = 'ap-southeast-2';
export const MAX_REPLY_TOKENS = 1024;
/** Live Bedrock calls happen only when this environment variable is exactly `1`. */
export const LIVE_BEDROCK_FLAG = 'DEVPILOT_LIVE_BEDROCK';

/** The one Bedrock Runtime operation this client uses. Tests inject a fake; nothing else calls AWS. */
export interface ConverseRuntime {
  send(command: ConverseCommand, options: { readonly abortSignal: AbortSignal }): Promise<ConverseCommandOutput>;
}

export interface BedrockModelClientOptions {
  readonly runtime: ConverseRuntime;
  readonly modelId?: string;
  readonly maxTokens?: number;
  readonly prompt?: PromptOptions;
}

/** A failed call that may succeed later (throttling, timeouts, service errors). Carries no AWS message text. */
export class BedrockCallError extends Error {
  override readonly name = 'BedrockCallError';
}

/** A reply that is not one complete JSON object citing only evidence that was sent. Carries no reply text. */
export class BedrockReplyError extends Error {
  override readonly name = 'BedrockReplyError';
}

/** Errors meaning the model cannot be used at all from this process: no access, no credentials, no model. */
const UNAVAILABLE_ERRORS = new Set([
  'AccessDeniedException',
  'UnrecognizedClientException',
  'ExpiredTokenException',
  'InvalidSignatureException',
  'IncompleteSignature',
  'MissingAuthenticationToken',
  'CredentialsProviderError',
  'ResourceNotFoundException',
]);

/**
 * A `ModelClient` over Amazon Bedrock `Converse`: one request per
 * escalation, bounded and redacted by `renderEscalationPrompt`, cancelled
 * when the planner stops waiting. It returns the parsed JSON reply for the
 * planner to validate and never retries.
 */
export class BedrockModelClient implements ModelClient {
  readonly name: string;
  readonly #runtime: ConverseRuntime;
  readonly #modelId: string;
  readonly #maxTokens: number;
  readonly #prompt: PromptOptions;

  constructor(options: BedrockModelClientOptions) {
    this.#runtime = options.runtime;
    this.#modelId = options.modelId ?? NOVA_PRO_MODEL_ID;
    this.#maxTokens = options.maxTokens ?? MAX_REPLY_TOKENS;
    if (!Number.isInteger(this.#maxTokens) || this.#maxTokens < 1 || this.#maxTokens > MAX_REPLY_TOKENS) {
      throw new RangeError(`maxTokens must be an integer from 1 to ${MAX_REPLY_TOKENS}`);
    }
    this.#prompt = options.prompt ?? {};
    this.name = `bedrock:${this.#modelId}`;
  }

  async assess(request: EscalationRequest, options: ModelCallOptions): Promise<unknown> {
    const prompt = renderEscalationPrompt(request, this.#prompt);
    const command = new ConverseCommand({
      modelId: this.#modelId,
      system: [{ text: prompt.system }],
      messages: [{ role: 'user', content: [{ text: prompt.user }] }],
      inferenceConfig: { maxTokens: this.#maxTokens, temperature: 0 },
    });
    let output: ConverseCommandOutput;
    try {
      output = await this.#runtime.send(command, { abortSignal: options.signal });
    } catch (error) {
      throw classify(error);
    }
    return parseReply(output, new Set(prompt.sentEvidenceIds));
  }
}

export interface BedrockEnvironment {
  readonly DEVPILOT_LIVE_BEDROCK?: string | undefined;
  readonly AWS_REGION?: string | undefined;
}

export interface BedrockRuntimeConfig {
  readonly region: string;
  readonly maxAttempts: number;
}

/**
 * The live client, or `undefined` unless `DEVPILOT_LIVE_BEDROCK` is exactly
 * `1`. The Region is `ap-southeast-2`; an `AWS_REGION` naming any other
 * Region is refused. Credentials come from the standard SDK provider chain
 * (for example `AWS_PROFILE`). The SDK does not retry, so each escalation is
 * at most one billed request.
 */
export function createBedrockModelClient(
  env: BedrockEnvironment,
  options: { readonly createRuntime?: (config: BedrockRuntimeConfig) => ConverseRuntime; readonly prompt?: PromptOptions } = {},
): BedrockModelClient | undefined {
  if (env[LIVE_BEDROCK_FLAG] !== '1') return undefined;
  if (env.AWS_REGION && env.AWS_REGION !== BEDROCK_REGION) throw new RangeError(`Bedrock calls are limited to ${BEDROCK_REGION}; AWS_REGION names another Region`);
  const config: BedrockRuntimeConfig = { region: BEDROCK_REGION, maxAttempts: 1 };
  const runtime = options.createRuntime ? options.createRuntime(config) : liveRuntime(config);
  return new BedrockModelClient({ runtime, ...(options.prompt ? { prompt: options.prompt } : {}) });
}

function liveRuntime(config: BedrockRuntimeConfig): ConverseRuntime {
  const client = new BedrockRuntimeClient({ region: config.region, maxAttempts: config.maxAttempts });
  return { send: (command, options) => client.send(command, options) };
}

function classify(error: unknown): Error {
  const name = error instanceof Error && /^[A-Za-z]{1,64}$/.test(error.name) ? error.name : 'Error';
  const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata?.httpStatusCode;
  const detail = `${name}${typeof status === 'number' ? `, HTTP ${status}` : ''}`;
  return UNAVAILABLE_ERRORS.has(name) ? new ModelUnavailableError(`Bedrock is unavailable (${detail})`) : new BedrockCallError(`Bedrock call failed (${detail})`);
}

const FENCED = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/;

function parseReply(output: ConverseCommandOutput, sent: ReadonlySet<string>): unknown {
  if (output.stopReason !== 'end_turn') throw new BedrockReplyError(`The model did not finish its reply (stop reason: ${safeToken(output.stopReason)}).`);
  const blocks = output.output?.message?.content ?? [];
  if (blocks.length === 0 || blocks.some((block) => typeof block.text !== 'string')) throw new BedrockReplyError('The model reply is not text.');
  const text = blocks.map((block) => block.text).join('').trim();
  let reply: unknown;
  try {
    reply = JSON.parse(FENCED.exec(text)?.[1] ?? text);
  } catch {
    throw new BedrockReplyError('The model reply is not JSON.');
  }
  if (typeof reply !== 'object' || reply === null || Array.isArray(reply)) throw new BedrockReplyError('The model reply is not a JSON object.');
  if (citedIds(reply).some((id) => typeof id === 'string' && !sent.has(id))) throw new BedrockReplyError('The model reply cites evidence that was not sent to it.');
  return reply;
}

/** Evidence IDs wherever the reply puts them in the expected shape; any other shape is left to the planner's schema. */
function citedIds(reply: object): unknown[] {
  const hypotheses = (reply as { hypotheses?: unknown }).hypotheses;
  if (!Array.isArray(hypotheses)) return [];
  return hypotheses.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const { supportingEvidenceIds: support, contradictingEvidenceIds: contradict } = item as Record<string, unknown>;
    return [...(Array.isArray(support) ? support : []), ...(Array.isArray(contradict) ? contradict : [])];
  });
}

function safeToken(value: unknown): string {
  return typeof value === 'string' && /^[a-z_]{1,40}$/.test(value) ? value : 'unknown';
}
