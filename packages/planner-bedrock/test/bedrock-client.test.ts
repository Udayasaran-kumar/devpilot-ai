import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import type { ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import type { PlannerContext, PlannerDecision } from '@devpilot/planners';
import { EscalatingPlanner, ModelUnavailableError, type EscalationRequest } from '../src/index.js';
import {
  BedrockCallError,
  BedrockModelClient,
  BedrockReplyError,
  createBedrockModelClient,
  MAX_REPLY_TOKENS,
  NOVA_PRO_MODEL_ID,
  renderEscalationPrompt,
  SYSTEM_PROMPT,
  type BedrockRuntimeConfig,
} from '../src/bedrock.js';
import { converseOutput, fakeRuntime } from './support/fake-runtime.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AT = '2026-01-01T00:00:00.000Z';
const MARKER = 'MARKER-7f3a';

const REQUEST: EscalationRequest = {
  investigationId: 'inv-1',
  signal: { title: 'Boundary quote is wrong', content: 'not ok 1 - quotes zero at the boundary', command: 'npm test' },
  ruleConclusion: 'No competing hypotheses could be formed.',
  evidence: [
    { id: 'ev-src', kind: 'source_code', summary: 'src/quote.ts', location: { type: 'file', path: 'src/quote.ts' }, content: 'a\nb' },
    { id: 'ev-run', kind: 'command_output', summary: 'npm test', location: { type: 'command', command: 'npm test', exitCode: 1 }, content: 'not ok 1' },
  ],
};

const call = (client: BedrockModelClient, signal = new AbortController().signal) => client.assess(REQUEST, { signal });
const replying = (output: ConverseCommandOutput) => {
  const fake = fakeRuntime(() => output);
  return { ...fake, client: new BedrockModelClient({ runtime: fake.runtime }) };
};

describe('BedrockModelClient', () => {
  it('sends one Converse request to Nova Pro with the rendered prompt, bounded output, and the planner abort signal', async () => {
    const { client, sends } = replying(converseOutput('{"hypotheses":[]}'));
    const controller = new AbortController();
    await call(client, controller.signal);
    assert.equal(sends.length, 1);
    assert.deepEqual(sends[0]?.command.input, {
      modelId: NOVA_PRO_MODEL_ID,
      system: [{ text: SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: [{ text: renderEscalationPrompt(REQUEST).user }] }],
      inferenceConfig: { maxTokens: MAX_REPLY_TOKENS, temperature: 0 },
    });
    assert.equal(sends[0]?.signal, controller.signal);
    assert.equal(client.name, 'bedrock:amazon.nova-pro-v1:0');
  });

  it('returns the parsed reply object, also from a single fenced block', async () => {
    const reply = { hypotheses: [{ key: 'k', supportingEvidenceIds: ['ev-src', 'ev-run'], contradictingEvidenceIds: [] }], edit: null };
    assert.deepEqual(await call(replying(converseOutput(JSON.stringify(reply))).client), reply);
    assert.deepEqual(await call(replying(converseOutput(`\`\`\`json\n${JSON.stringify(reply)}\n\`\`\``)).client), reply);
  });

  const refused: Array<[string, ConverseCommandOutput]> = [
    ['prose', converseOutput(`The bug is on line 2. ${MARKER}`)],
    ['two objects', converseOutput(`{"m":"${MARKER}"}{"n":1}`)],
    ['an array', converseOutput(`[{"m":"${MARKER}"}]`)],
    ['an empty reply', converseOutput('')],
    ['a reply cut off at the token limit', converseOutput(`{"m":"${MARKER}"`, 'max_tokens')],
    ['a guardrail stop', converseOutput(`{"m":"${MARKER}"}`, 'guardrail_intervened')],
    [
      'a tool call instead of text',
      { ...converseOutput(''), output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 't', name: 'run', input: { m: MARKER } } }] } } },
    ],
    ['evidence that was not sent', converseOutput(JSON.stringify({ hypotheses: [{ supportingEvidenceIds: ['ev-src', 'ev-elsewhere'], m: MARKER }], edit: null }))],
  ];
  for (const [name, output] of refused) {
    it(`refuses ${name} without repeating it`, async () => {
      await assert.rejects(call(replying(output).client), (error: unknown) => error instanceof BedrockReplyError && !error.message.includes(MARKER));
    });
  }

  it('refuses a reply citing a search hit folded into a source item, which was never sent as an item', async () => {
    const hit = { id: 'ev-hit', kind: 'search_result', summary: 'src/quote.ts:2 contains "b"', location: { type: 'file', path: 'src/quote.ts', startLine: 2, endLine: 2 }, content: 'b' } as const;
    const request: EscalationRequest = { ...REQUEST, evidence: [...REQUEST.evidence, hit] };
    assert.deepEqual(renderEscalationPrompt(request).foldedEvidenceIds, ['ev-hit']);
    const citing = (ids: string[]) =>
      replying(converseOutput(JSON.stringify({ hypotheses: [{ key: 'k', statement: 's', supportingEvidenceIds: ids, contradictingEvidenceIds: [] }], edit: null }))).client.assess(request, {
        signal: new AbortController().signal,
      });
    await assert.rejects(citing(['ev-hit', 'ev-run']), (error: unknown) => error instanceof BedrockReplyError && /not sent/.test(error.message));
    assert.ok(await citing(['ev-src', 'ev-run']), 'the source item it was folded into can be cited');
  });

  const awsError = (name: string, status?: number) =>
    Object.assign(new Error(`User: arn:aws:sts::123456789012:assumed-role/Role/session is not authorized ${MARKER}`), {
      name,
      ...(status !== undefined ? { $metadata: { httpStatusCode: status } } : {}),
    });
  const failures: Array<[string, number | undefined, 'unavailable' | 'call']> = [
    ['AccessDeniedException', 403, 'unavailable'],
    ['UnrecognizedClientException', 403, 'unavailable'],
    ['ExpiredTokenException', 400, 'unavailable'],
    ['CredentialsProviderError', undefined, 'unavailable'],
    ['ResourceNotFoundException', 404, 'unavailable'],
    ['ThrottlingException', 429, 'call'],
    ['ServiceUnavailableException', 503, 'call'],
    ['ModelTimeoutException', 408, 'call'],
    ['InternalServerException', 500, 'call'],
    ['ValidationException', 400, 'call'],
    ['TypeError', undefined, 'call'],
  ];
  for (const [name, status, kind] of failures) {
    it(`maps ${name} to ${kind === 'unavailable' ? 'ModelUnavailableError (latches)' : 'BedrockCallError (does not latch)'}, without the AWS message`, async () => {
      const fake = fakeRuntime(() => {
        throw awsError(name, status);
      });
      await assert.rejects(call(new BedrockModelClient({ runtime: fake.runtime })), (error: unknown) => {
        assert.ok(kind === 'unavailable' ? error instanceof ModelUnavailableError : error instanceof BedrockCallError);
        const message = (error as Error).message;
        assert.equal(message, `${kind === 'unavailable' ? 'Bedrock is unavailable' : 'Bedrock call failed'} (${name}${status !== undefined ? `, HTTP ${status}` : ''})`);
        assert.ok(!/123456789012|arn:|MARKER/.test(message));
        return true;
      });
    });
  }

  it('refuses an out-of-range reply token limit', () => {
    const { runtime } = fakeRuntime(() => converseOutput('{}'));
    assert.throws(() => new BedrockModelClient({ runtime, maxTokens: 0 }), RangeError);
    assert.throws(() => new BedrockModelClient({ runtime, maxTokens: MAX_REPLY_TOKENS + 1 }), RangeError);
  });

  it('is aborted when the escalating planner times out, and the rule decision stands', async () => {
    const fake = fakeRuntime(
      (_command, { abortSignal }) =>
        new Promise<ConverseCommandOutput>((_resolve, reject) => {
          abortSignal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    );
    const finish: PlannerDecision = { type: 'finish', reason: 'No competing hypotheses could be formed.' };
    const planner = new EscalatingPlanner({ model: new BedrockModelClient({ runtime: fake.runtime }), rules: { name: 'stub', next: async () => finish }, timeoutMs: 5 });
    const context: PlannerContext = {
      investigationId: 'inv-1',
      signal: { id: 'sig-1', kind: 'failing_test', title: 'Boundary', content: 'not ok 1', command: 'npm test', receivedAt: AT },
      stepCount: 4,
      remainingSteps: 21,
      actions: [],
      evidence: REQUEST.evidence.map((item) => ({ ...item, source: { tool: 'read_file' }, collectedAt: AT })),
      hypotheses: [],
      verifications: [],
      patchProposals: [],
      tools: [],
    };
    assert.deepEqual(await planner.next(context), finish);
    assert.equal(fake.sends.length, 1);
    assert.equal(fake.sends[0]?.signal.aborted, true);
  });
});

describe('createBedrockModelClient', () => {
  const factory = (env: Record<string, string | undefined>) => {
    const configs: BedrockRuntimeConfig[] = [];
    const client = createBedrockModelClient(env, {
      createRuntime: (config) => {
        configs.push(config);
        return fakeRuntime(() => converseOutput('{}')).runtime;
      },
    });
    return { client, configs };
  };

  it('creates nothing unless DEVPILOT_LIVE_BEDROCK is exactly 1', () => {
    for (const value of [undefined, '', '0', 'true', 'yes', 'on', '1 ', ' 1', '01']) {
      const { client, configs } = factory({ DEVPILOT_LIVE_BEDROCK: value, AWS_REGION: 'ap-southeast-2' });
      assert.equal(client, undefined, JSON.stringify(value));
      assert.deepEqual(configs, []);
    }
  });

  it('calls only ap-southeast-2, without SDK retries, and refuses any other AWS_REGION', () => {
    const sydney = factory({ DEVPILOT_LIVE_BEDROCK: '1' });
    assert.ok(sydney.client instanceof BedrockModelClient);
    for (const AWS_REGION of [undefined, '', 'ap-southeast-2']) {
      assert.deepEqual(factory({ DEVPILOT_LIVE_BEDROCK: '1', AWS_REGION }).configs, [{ region: 'ap-southeast-2', maxAttempts: 1 }]);
    }
    for (const AWS_REGION of ['us-east-1', 'eu-north-1', 'ap-southeast-4', 'AP-SOUTHEAST-2', ' ap-southeast-2', 'Sydney']) {
      assert.throws(() => factory({ DEVPILOT_LIVE_BEDROCK: '1', AWS_REGION }), {
        name: 'RangeError',
        message: 'Bedrock calls are limited to ap-southeast-2; AWS_REGION names another Region',
      });
    }
  });
});

describe('planner-bedrock source boundaries', () => {
  const sources = async (directory: string, pattern: RegExp) =>
    Promise.all(
      (await readdir(path.join(PACKAGE_ROOT, directory), { recursive: true }))
        .filter((file) => pattern.test(file))
        .map(async (file) => [file, await readFile(path.join(PACKAGE_ROOT, directory, file), 'utf8')] as const),
    );

  it('only bedrock-client.ts imports the AWS SDK, and the main entry point never loads it', async () => {
    const files = await sources('src', /\.ts$/);
    const importing = files.filter(([, source]) => /from '@aws-sdk\//.test(source)).map(([file]) => file);
    assert.deepEqual(importing, ['bedrock-client.ts']);
    const index = files.find(([file]) => file === 'index.ts')?.[1] ?? '';
    assert.ok(!/bedrock-client|bedrock-prompt|'\.\/bedrock\.js'/.test(index));
    const manifest = JSON.parse(await readFile(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { exports: object; dependencies: Record<string, string> };
    assert.deepEqual(manifest.exports, { '.': './src/index.ts', './bedrock': './src/bedrock.ts' });
    assert.equal(manifest.dependencies['@aws-sdk/client-bedrock-runtime'], '3.1148.0', 'pinned to the verified version');
  });

  it('no automated test constructs a real Bedrock client; the live check is outside the test glob and opt-in', async () => {
    for (const [file, source] of await sources('test', /\.ts$/)) {
      if (file.startsWith(`live${path.sep}`)) continue;
      assert.ok(!/\bnew BedrockRuntimeClient\b|import \{[^}]*\bBedrockRuntimeClient\b/.test(source), file);
      assert.ok(!/createBedrockModelClient\(process\.env/.test(source), file);
    }
    const live = await sources('test/live', /\.ts$/);
    assert.deepEqual(live.map(([file]) => file), ['bedrock.live.ts']);
    assert.ok(!live[0]?.[0].endsWith('.test.ts'));
    assert.match(live[0]?.[1] ?? '', /createBedrockModelClient\(process\.env/);
  });
});
