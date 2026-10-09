import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { RepositoryRegistry } from '@devpilot/service';
import { DevPilotMcpClient, McpClientError, type InvestigationResult } from '@devpilot/voice-demo';
import { resolveGitExecutable, type GitExecutable } from '../../../packages/tools/src/index.js';
import { createGitRepositoryFixture, git, type GitRepositoryFixture } from '../../../packages/tools/test/support/git-repository.js';
import {
  SHIPPING_BUGGY_LINE,
  SHIPPING_ROOT,
  SHIPPING_SIGNAL,
  SHIPPING_STATEMENT,
  shippingModel,
} from '../../../packages/planner-bedrock/test/support/fake-models.js';
import { startDevPilotHost, type DevPilotHost } from '../src/index.js';
import type { EscalationEvent } from '@devpilot/planner-bedrock';

const HOST_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const TOKEN = 'host-test-token-0123456789abcdef';
const NPM_TEST = { command: 'npm', args: ['test'] };
const CHECKOUT_SIGNAL = {
  kind: 'failing_test',
  title: 'Checkout total is too high when a discount code is used',
  content: 'not ok 2 - applies tax to the discounted amount\n    200 !== 180',
} as const;

async function completed(client: DevPilotMcpClient, jobId: string): Promise<InvestigationResult> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const result = await client.getInvestigationResult(jobId);
    if (result.job.status === 'completed' || result.job.status === 'failed') return result;
    if (Date.now() > deadline) throw new Error('The investigation did not finish in time');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function rawStatus(url: URL, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: url.hostname, port: url.port, method: 'POST', path: url.pathname, headers }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('error', reject);
    request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
  });
}

describe('DevPilot host: escalating planner behind the unchanged MCP server', () => {
  let realGit: GitExecutable;
  let shipping: GitRepositoryFixture;
  let checkout: GitRepositoryFixture;
  let host: DevPilotHost;
  let client: DevPilotMcpClient;
  let model: ReturnType<typeof shippingModel>;
  let shippingResult: InvestigationResult;
  let checkoutResult: InvestigationResult;
  const escalations: EscalationEvent[] = [];
  const serverErrors: unknown[] = [];

  before(async () => {
    realGit = await resolveGitExecutable();
    shipping = await createGitRepositoryFixture(realGit, SHIPPING_ROOT);
    checkout = await createGitRepositoryFixture(realGit);
    const registry = new RepositoryRegistry();
    registry.register({
      repositoryId: 'shipping',
      displayName: 'Shipping',
      repositoryRoot: shipping.root,
      allowedRoot: shipping.allowedRoot,
      verification: NPM_TEST,
      defaultSignal: SHIPPING_SIGNAL,
    });
    registry.register({
      repositoryId: 'checkout',
      displayName: 'Checkout',
      repositoryRoot: checkout.root,
      allowedRoot: checkout.allowedRoot,
      verification: NPM_TEST,
      defaultSignal: CHECKOUT_SIGNAL,
    });
    model = shippingModel();
    host = await startDevPilotHost({
      registry,
      model: model.client,
      token: TOKEN,
      port: 0,
      git: realGit,
      onError: (error) => serverErrors.push(error),
      onEscalation: (event) => escalations.push(event),
    });
    client = await DevPilotMcpClient.connect({ url: host.url, token: TOKEN });

    const checkoutJob = await client.startInvestigation('checkout');
    const shippingJob = await client.startInvestigation('shipping');
    checkoutResult = await completed(client, checkoutJob.jobId);
    shippingResult = await completed(client, shippingJob.jobId);
  });

  after(async () => {
    await client?.close();
    await host?.close();
    await shipping?.cleanup();
    await checkout?.cleanup();
  });

  it('serves the MCP endpoint on loopback only', () => {
    assert.equal(host.url.hostname, '127.0.0.1');
    assert.equal(host.url.pathname, '/mcp');
  });

  it('a rule-solvable incident is repaired over MCP without a model call', () => {
    assert.equal(checkoutResult.job.status, 'completed', checkoutResult.job.failureReason);
    assert.equal(checkoutResult.outcome?.repairStatus, 'repaired');
    assert.ok(!JSON.stringify(checkoutResult).includes('hyp-model-'));
  });

  it('the incident the rules cannot explain is escalated once and its repair verified, over MCP', () => {
    assert.equal(model.requests.length, 1);
    assert.equal(host.planner.modelCalls, 1);
    assert.deepEqual(
      escalations.map((event) => [event.type, event.type === 'escalated' ? event.selectedHypothesisId : event.reason]),
      [['escalated', 'hyp-model-threshold-comparison']],
    );
    assert.equal(shippingResult.job.status, 'completed', shippingResult.job.failureReason);
    const outcome = shippingResult.outcome;
    assert.ok(outcome);
    assert.equal(outcome.groundingValid, true);
    assert.equal(outcome.repairStatus, 'repaired');
    assert.deepEqual(outcome.baselineFailures.map((failure) => failure.testName), ['ships free exactly at the threshold']);
    assert.deepEqual(outcome.affectedFiles, ['src/shipping.ts']);
    assert.ok(outcome.claims.some((claim) => claim.kind === 'verification'));
    assert.ok(outcome.claims.some((claim) => claim.kind === 'proposal' && claim.statement.includes('hyp-model-threshold-comparison')));
    assert.match(outcome.spokenSummary, /verified a patch in an isolated worktree: "ships free exactly at the threshold" passed/);
  });

  it('responses carry no model text, diff, host path, or token, and the repositories are unmodified', async () => {
    for (const result of [shippingResult, checkoutResult, await client.listRepositories()]) {
      const text = JSON.stringify(result);
      assert.ok(!text.includes(SHIPPING_STATEMENT) && !text.includes('at or above'), 'model-written hypothesis text is not projected');
      assert.ok(!text.includes('@@ '), 'no diff hunks');
      assert.ok(!text.includes(TOKEN));
      for (const hostPath of [shipping.base, checkout.base, shipping.canonicalRoot, homedir(), tmpdir()]) assert.ok(!text.includes(hostPath), hostPath);
    }
    assert.equal(git(realGit, shipping.root, 'status', '--porcelain'), '');
    assert.ok((await readFile(path.join(shipping.root, 'src/shipping.ts'), 'utf8')).includes(SHIPPING_BUGGY_LINE));
    assert.deepEqual(serverErrors, []);
  });

  it('keeps bearer authentication and the origin allowlist', async () => {
    await assert.rejects(
      DevPilotMcpClient.connect({ url: host.url, token: 'not-the-host-token-000000' }),
      (error: unknown) => error instanceof McpClientError && error.code === 'unauthorized',
    );
    const headers = { host: host.url.host, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    assert.equal(await rawStatus(host.url, headers), 401);
    assert.equal(await rawStatus(host.url, { ...headers, authorization: 'Bearer wrong-token-0123456789' }), 401);
    assert.equal(await rawStatus(host.url, { ...headers, authorization: `Bearer ${TOKEN}`, origin: 'http://evil.example' }), 403);
    assert.equal(await rawStatus(host.url, { ...headers, authorization: `Bearer ${TOKEN}`, host: 'evil.example' }), 403);
  });

  it('refuses a short token like the MCP server does', async () => {
    await assert.rejects(startDevPilotHost({ registry: new RepositoryRegistry(), model: model.client, token: 'short', port: 0 }), /bearer token/);
  });
});

describe('host source boundaries', () => {
  it('composes only the MCP server, the service, and the planner, with no SDK, cloud, engine, or tool imports', async () => {
    const files = (await readdir(HOST_SRC, { recursive: true })).filter((file) => file.endsWith('.ts'));
    assert.deepEqual(files, ['index.ts']);
    for (const file of files) {
      const source = await readFile(path.join(HOST_SRC, file), 'utf8');
      for (const [, specifier] of source.matchAll(/from '([^']+)'/g)) {
        assert.match(specifier ?? '', /^@devpilot\/(mcp|service|planner-bedrock)$/, `${file} imports ${specifier}`);
      }
      assert.ok(!/@aws-sdk|@modelcontextprotocol|child_process|node:http|node:net|process\.env/.test(source), file);
    }
  });
});
