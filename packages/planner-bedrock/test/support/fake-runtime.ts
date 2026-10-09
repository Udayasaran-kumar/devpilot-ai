import type { ConverseCommand, ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { DATA_HEADER, type ConverseRuntime } from '../../src/bedrock.js';
import { SHIPPING_BUGGY_LINE, SHIPPING_FIXED_LINE, SHIPPING_STATEMENT } from './fake-models.js';

export interface PromptEvidenceData {
  readonly id: string;
  readonly kind: string;
  readonly summary: string;
  readonly location: Record<string, unknown>;
  readonly lines?: Array<[number, string]>;
  readonly content?: string;
  readonly truncated?: true;
  readonly matchedLines?: number[];
}

export interface PromptData {
  readonly signal: { title: string; content: string; command?: string };
  readonly ruleConclusion: string;
  readonly evidence: PromptEvidenceData[];
}

export function converseOutput(text: string, stopReason = 'end_turn'): ConverseCommandOutput {
  return {
    $metadata: {},
    stopReason,
    output: { message: { role: 'assistant', content: [{ text }] } },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    metrics: { latencyMs: 1 },
  } as ConverseCommandOutput;
}

/** The text of the single user message of a Converse request. */
export function userText(command: ConverseCommand): string {
  const text = command.input.messages?.[0]?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error('The request has no user text');
  return text;
}

export function promptData(command: ConverseCommand): PromptData {
  const text = userText(command);
  const newline = text.indexOf('\n');
  if (text.slice(0, newline) !== DATA_HEADER) throw new Error('The user text does not start with the data header');
  return JSON.parse(text.slice(newline + 1)) as PromptData;
}

type Answer = (command: ConverseCommand, options: { readonly abortSignal: AbortSignal }) => ConverseCommandOutput | Promise<ConverseCommandOutput>;

/** A Converse runtime that records each request and answers locally. It never reaches AWS. */
export function fakeRuntime(answer: Answer) {
  const sends: Array<{ command: ConverseCommand; signal: AbortSignal }> = [];
  const runtime: ConverseRuntime = {
    send: async (command, options) => {
      sends.push({ command, signal: options.abortSignal });
      return answer(command, options);
    },
  };
  return { runtime, sends };
}

/**
 * Answers the shipping incident from the rendered prompt alone, as a model
 * would: evidence IDs, the line number, and the original text all come from
 * what the prompt shows.
 */
export function shippingRuntime() {
  return fakeRuntime((command) => {
    const { evidence } = promptData(command);
    const find = (kind: string, file?: string) => evidence.find((item) => item.kind === kind && (file === undefined || item.location.path === file));
    const source = find('source_code', 'src/shipping.ts');
    const test = find('source_code', 'test/shipping.test.ts');
    const run = find('command_output');
    const [line, originalText] = source?.lines?.find(([, text]) => text === SHIPPING_BUGGY_LINE) ?? [0, ''];
    const reply = {
      hypotheses: [
        { key: 'threshold-comparison', statement: SHIPPING_STATEMENT, supportingEvidenceIds: [source?.id, test?.id, run?.id], contradictingEvidenceIds: [] },
        { key: 'flat-rate', statement: 'The caller passes the wrong flat rate.', supportingEvidenceIds: [], contradictingEvidenceIds: [test?.id] },
      ],
      edit: { hypothesisKey: 'threshold-comparison', path: 'src/shipping.ts', line, originalText, replacementText: SHIPPING_FIXED_LINE },
    };
    return converseOutput(JSON.stringify(reply));
  });
}
