import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdir, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { PUBLIC_ERROR_TEXT, startMcpHttpServer, type McpHttpServer } from '../../mcp/src/index.js';
import {
  InvestigationService,
  RepositoryRegistry,
  type InvestigationResult as ServiceInvestigationResult,
  type JobView as ServiceJobView,
  type RepositoryView as ServiceRepositoryView,
  type SignalInput,
} from '../../../packages/service/src/index.js';
import { resolveGitExecutable, type GitExecutable } from '../../../packages/tools/src/index.js';
import { createGitRepositoryFixture, type GitRepositoryFixture } from '../../../packages/tools/test/support/git-repository.js';
import {
  CLIENT_ERROR_TEXT,
  DevPilotMcpClient,
  McpClientError,
  type DevPilotMcpClientOptions,
  type InvestigationResult,
  type JobView,
  type McpClientErrorCode,
  type RepositoryView,
} from '../src/mcp-client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO_ROOT = path.resolve(HERE, '..');

const TOKEN = 'voice-demo-token-0123456789abcdef';
const NPM_TEST = { command: 'npm', args: ['test'] };
const FAILURE: SignalInput = {
  kind: 'failing_test',
  title: 'Total is too high when a code is applied',
  content: [
    'not ok 2 - applies tax to the discounted amount',
    '  error: |-',
    '    Expected values to be strictly equal:',
    '    200 !== 180',
  ].join('\n'),
};
const UNKNOWN_JOB = 'job-00000000-0000-4000-8000-000000000000';

/** Every McpClientError and every reported underlying error, checked for the token at the end. */
const thrown: McpClientError[] = [];
const reported: unknown[] = [];

function options(url: URL, overrides: Partial<DevPilotMcpClientOptions> = {}): DevPilotMcpClientOptions {
  return { url, token: TOKEN, onError: (error) => reported.push(error), ...overrides };
}

async function rejectsWith(promise: Promise<unknown>, code: McpClientErrorCode): Promise<McpClientError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof McpClientError, `expected McpClientError, got ${inspect(error)}`);
    assert.equal(error.code, code, error.message);
    thrown.push(error);
    return error;
  }
  return assert.fail(`expected an McpClientError with code ${code}`);
}

function assertTokenFree(value: unknown, label: string): void {
  const views = [String(value), inspect(value, { depth: 8, showHidden: true })];
  if (value instanceof Error) views.push(value.message, value.stack ?? '');
  for (const view of views) assert.ok(!view.includes(TOKEN), `${label} contains the token`);
}

function assertNoHostPaths(value: unknown, paths: readonly string[]): void {
  const text = JSON.stringify(value);
  for (const hostPath of paths) assert.ok(!text.includes(hostPath), `response mentions host path ${hostPath}`);
  assert.ok(!/\/(Users|home|private|var|tmp)\//.test(text), 'response mentions an absolute host path');
}

function unusedRepositoryService(): InvestigationService {
  const registry = new RepositoryRegistry();
  registry.register({
    repositoryId: 'shop',
    displayName: 'Shop',
    repositoryRoot: path.join(tmpdir(), 'devpilot-voice-demo-unused', 'repo'),
    verification: NPM_TEST,
  });
  return new InvestigationService({ registry });
}

interface JsonRpcResponse {
  result?: Record<string, unknown>;
}
type Tamper = (method: string, tool: string | undefined, response: JsonRpcResponse) => void;

/**
 * A loopback HTTP relay in front of the real MCP server. Every response comes
 * from that server; the relay records request methods and can rewrite a
 * response or cut a request's connection.
 */
interface Relay {
  readonly url: URL;
  readonly methods: string[];
  tamper: Tamper | undefined;
  /** Destroy the request's socket instead of forwarding it. */
  drop: (method: string) => boolean;
  close(): Promise<void>;
}

const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'keep-alive', 'transfer-encoding']);

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function startRelay(target: URL): Promise<Relay> {
  const relay: Relay = { url: new URL('http://127.0.0.1/'), methods: [], tamper: undefined, drop: () => false, close: async () => {} };
  const server = createServer(async (req, res) => {
    try {
      const body = await readBody(req);
      const request = JSON.parse(body) as { method?: string; params?: { name?: string } };
      relay.methods.push(request.method ?? '');
      if (relay.drop(request.method ?? '')) {
        req.socket.destroy();
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string' && !HOP_BY_HOP.has(name)) headers.set(name, value);
      }
      const upstream = await fetch(target, { method: 'POST', headers, body });
      let text = await upstream.text();
      const contentType = upstream.headers.get('content-type') ?? 'application/json';
      if (relay.tamper && upstream.ok && contentType.startsWith('application/json') && request.method) {
        const response = JSON.parse(text) as JsonRpcResponse;
        relay.tamper(request.method, request.params?.name, response);
        text = JSON.stringify(response);
      }
      res.writeHead(upstream.status, { 'content-type': contentType });
      res.end(text);
    } catch {
      req.socket.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  Object.assign(relay, {
    url: new URL(`http://127.0.0.1:${port}/mcp`),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  });
  return relay;
}

/**
 * Replaces a tool result's payload, keeping the envelope fields (`resultType`,
 * `_meta`) the modern protocol era requires. A refusal becomes a success.
 */
function rewriteResult(response: JsonRpcResponse, payload: Record<string, unknown>): void {
  const { content: _content, structuredContent: _structured, isError: _isError, ...envelope } = response.result ?? {};
  response.result = { ...envelope, ...payload };
}

/** Rewrites one tool's result into the given structured content; `undefined` drops it. */
function replaceResult(tool: string, structuredContent: unknown): Tamper {
  return (method, name, response) => {
    if (method !== 'tools/call' || name !== tool) return;
    rewriteResult(response, { content: [{ type: 'text', text: 'tampered' }], ...(structuredContent === undefined ? {} : { structuredContent }) });
  };
}

const stripOutputSchemas: Tamper = (method, _tool, response) => {
  if (method !== 'tools/list') return;
  for (const tool of (response.result?.tools ?? []) as Array<Record<string, unknown>>) delete tool.outputSchema;
};

function both(...tampers: Tamper[]): Tamper {
  return (method, tool, response) => {
    for (const tamper of tampers) tamper(method, tool, response);
  };
}

describe('the MCP client wrapper against the real DevPilot MCP server', () => {
  let git: GitExecutable;
  let shop: GitRepositoryFixture;
  let server: McpHttpServer;
  let client: DevPilotMcpClient;
  let repositories: readonly RepositoryView[];
  let started: JobView;
  let firstLookup: InvestigationResult;
  let finished: InvestigationResult;
  let busy: McpClientError;
  let hostPaths: string[];

  before(async () => {
    git = await resolveGitExecutable();
    shop = await createGitRepositoryFixture(git);
    hostPaths = [shop.base, shop.root, shop.canonicalRoot, shop.allowedRoot, homedir(), tmpdir()];
    const registry = new RepositoryRegistry();
    registry.register({
      repositoryId: 'shop',
      displayName: 'Shop',
      repositoryRoot: shop.root,
      allowedRoot: shop.allowedRoot,
      verification: NPM_TEST,
      defaultSignal: FAILURE,
    });
    server = await startMcpHttpServer({ service: new InvestigationService({ registry, git }), port: 0, token: TOKEN });

    client = await DevPilotMcpClient.connect(options(server.url));
    repositories = await client.listRepositories();
    started = await client.startInvestigation('shop');
    firstLookup = await client.getInvestigationResult(started.jobId);
    busy = await rejectsWith(client.startInvestigation('shop'), 'tool_error');

    const deadline = Date.now() + 120_000;
    for (;;) {
      const result = await client.getInvestigationResult(started.jobId);
      if (result.job.status === 'completed' || result.job.status === 'failed') {
        finished = result;
        break;
      }
      if (Date.now() > deadline) throw new Error('The investigation did not finish in time');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });

  after(async () => {
    await client?.close();
    await server?.close();
    await shop?.cleanup();
  });

  it('connects once, over the modern protocol era, and reuses that connection for every call', () => {
    assert.equal(client.protocolEra, 'modern');
    assert.equal(client.connections, 1);
  });

  it('listRepositories returns the registered repository', () => {
    assert.deepEqual(repositories, [{ repositoryId: 'shop', displayName: 'Shop', command: 'npm test' }]);
  });

  it('startInvestigation returns a queued job with an opaque job ID', () => {
    assert.equal(started.status, 'queued');
    assert.equal(started.repositoryId, 'shop');
    assert.match(started.jobId, /^job-[0-9a-f-]{36}$/);
    assertNoHostPaths(started, hostPaths);
  });

  it('getInvestigationResult retrieves the job it started', () => {
    assert.equal(firstLookup.job.jobId, started.jobId);
    assert.ok(['queued', 'running', 'completed'].includes(firstLookup.job.status), firstLookup.job.status);
  });

  it('a completed investigation yields the grounded, verified result', () => {
    assert.equal(finished.job.status, 'completed', finished.job.failureReason);
    const outcome = finished.outcome;
    assert.ok(outcome);
    assert.equal(outcome.groundingValid, true);
    assert.equal(outcome.repairStatus, 'repaired');
    assert.deepEqual(outcome.baselineFailures.map((failure) => failure.testName), ['applies tax to the discounted amount']);
    assert.ok(outcome.claims.some((claim) => claim.kind === 'verification'));
    assert.ok(outcome.spokenSummary.length > 0);
    assertNoHostPaths(finished, hostPaths);
  });

  it('tool errors become McpClientError("tool_error") carrying only the server\'s public text, without reconnecting', async () => {
    assert.equal(busy.detail, PUBLIC_ERROR_TEXT.repository_busy);
    const unknownRepository = await rejectsWith(client.startInvestigation('missing'), 'tool_error');
    assert.equal(unknownRepository.detail, PUBLIC_ERROR_TEXT.unknown_repository);
    assert.equal(unknownRepository.message, 'DevPilot refused the request.');
    const unknownJob = await rejectsWith(client.getInvestigationResult(UNKNOWN_JOB), 'tool_error');
    assert.equal(unknownJob.detail, PUBLIC_ERROR_TEXT.unknown_job);
    // Schema-invalid arguments are refused by the SDK's input validation, whose text names the rule, not the value.
    for (const injected of ['../../etc', '/etc/passwd']) {
      const invalid = await rejectsWith(client.startInvestigation(injected), 'tool_error');
      assert.ok(invalid.detail, 'the refusal carries the server text');
      assert.ok(!invalid.detail.includes(injected) && !invalid.message.includes(injected));
    }
    const invalidJob = await rejectsWith(client.getInvestigationResult('/tmp/job'), 'tool_error');
    assert.ok(!invalidJob.detail?.includes('/tmp/job'));
    assert.equal(client.connections, 1);
  });

  it('the wrapper types accept every value the service contract allows', () => {
    const accepts = (result: ServiceInvestigationResult, job: ServiceJobView, repository: ServiceRepositoryView): [InvestigationResult, JobView, RepositoryView] => [
      result,
      job,
      repository,
    ];
    assert.equal(typeof accepts, 'function');
  });
});

describe('connection setup', () => {
  let server: McpHttpServer;
  let relay: Relay;

  before(async () => {
    server = await startMcpHttpServer({ service: unusedRepositoryService(), port: 0, token: TOKEN });
    relay = await startRelay(server.url);
  });

  after(async () => {
    await relay?.close();
    await server?.close();
  });

  it('calls listTools immediately after connecting', async () => {
    relay.methods.length = 0;
    const client = await DevPilotMcpClient.connect(options(relay.url));
    try {
      assert.deepEqual(relay.methods, ['server/discover', 'tools/list']);
      await client.listRepositories();
      assert.deepEqual(relay.methods, ['server/discover', 'tools/list', 'tools/call']);
    } finally {
      await client.close();
    }
  });

  it('refuses a server that does not list the DevPilot tools', async () => {
    relay.tamper = (method, _tool, response) => {
      if (method !== 'tools/list') return;
      response.result = { ...response.result, tools: ((response.result?.tools ?? []) as Array<{ name: string }>).filter((tool) => tool.name !== 'start_investigation') };
    };
    try {
      await rejectsWith(DevPilotMcpClient.connect(options(relay.url)), 'incompatible_server');
    } finally {
      relay.tamper = undefined;
    }
  });

  it('a wrong token is refused as unauthorized, and neither token appears in the error', async () => {
    const wrong = 'wrong-token-0123456789abcdefghij';
    const error = await rejectsWith(DevPilotMcpClient.connect(options(server.url, { token: wrong })), 'unauthorized');
    assert.ok(!inspect(error, { showHidden: true }).includes(wrong));
  });

  it('an unreachable server is reported as unavailable', async () => {
    const down = await startMcpHttpServer({ service: unusedRepositoryService(), port: 0, token: TOKEN });
    await down.close();
    await rejectsWith(DevPilotMcpClient.connect(options(down.url)), 'unavailable');
  });

  it('refuses invalid configuration without echoing the token', async () => {
    for (const token of ['', 'short', `${TOKEN} extra`, `${TOKEN}\r\nx-injected: 1`, 'ü'.repeat(20)]) {
      const error = await rejectsWith(DevPilotMcpClient.connect(options(server.url, { token })), 'invalid_configuration');
      if (token.length > 0) assert.ok(!error.message.includes(token));
    }
    for (const url of ['not a url', 'ftp://127.0.0.1/mcp', 'http://example.com/mcp', `http://user:${TOKEN}@127.0.0.1:${server.url.port}/mcp`]) {
      await rejectsWith(DevPilotMcpClient.connect(options(server.url, { url })), 'invalid_configuration');
    }
    await rejectsWith(DevPilotMcpClient.connect(options(server.url, { requestTimeoutMs: 0 })), 'invalid_configuration');
  });

  it('a closed client refuses further calls', async () => {
    const client = await DevPilotMcpClient.connect(options(server.url));
    await client.close();
    await rejectsWith(client.listRepositories(), 'closed');
  });
});

describe('malformed structured content', () => {
  let server: McpHttpServer;
  let relay: Relay;

  const VALID_JOB = { jobId: UNKNOWN_JOB, repositoryId: 'shop', status: 'queued', createdAt: '2026-10-08T00:00:00.000Z' };
  const VALID_OUTCOME = {
    investigationId: 'investigation-1',
    groundingValid: true,
    repairStatus: 'repaired',
    claims: [{ id: 'claim-1', kind: 'verification', statement: 'The test passes.', evidenceIds: ['ev-final'], actionIds: [] }],
    baselineFailures: [{ testFile: 'test/example.test.js', suite: [], testName: 'example' }],
    affectedFiles: ['src/example.js'],
    limitations: [],
    spokenSummary: 'Verified.',
  };
  const VALID_RESULT = { job: { ...VALID_JOB, status: 'completed', finishedAt: '2026-10-08T00:01:00.000Z' }, outcome: VALID_OUTCOME };

  before(async () => {
    server = await startMcpHttpServer({ service: unusedRepositoryService(), port: 0, token: TOKEN });
    relay = await startRelay(server.url);
  });

  after(async () => {
    await relay?.close();
    await server?.close();
  });

  async function withTamper<T>(tamper: Tamper, run: (client: DevPilotMcpClient) => Promise<T>): Promise<T> {
    relay.tamper = tamper;
    const client = await DevPilotMcpClient.connect(options(relay.url));
    try {
      return await run(client);
    } finally {
      await client.close();
      relay.tamper = undefined;
    }
  }

  it('content that breaks the advertised output schema is rejected by the SDK, without a retry', async () => {
    for (const content of [{ repositories: [{ repositoryId: 'shop' }] }, { repositories: 'shop' }, undefined]) {
      await withTamper(replaceResult('list_repositories', content), async (client) => {
        relay.methods.length = 0;
        await rejectsWith(client.listRepositories(), 'invalid_response');
        assert.deepEqual(relay.methods, ['tools/call']);
        assert.equal(client.connections, 1);
      });
    }
  });

  it('a result without the protocol envelope fails with fixed text, without a retry', async () => {
    const dropEnvelope: Tamper = (method, _tool, response) => {
      if (method === 'tools/call') response.result = { content: [{ type: 'text', text: 'no envelope' }], structuredContent: { repositories: [] } };
    };
    await withTamper(dropEnvelope, async (client) => {
      relay.methods.length = 0;
      await rejectsWith(client.listRepositories(), 'request_failed');
      assert.deepEqual(relay.methods, ['tools/call']);
    });
  });

  it('with no output schema advertised, the wrapper itself rejects malformed repositories', async () => {
    for (const content of [
      undefined,
      { repositories: [{ repositoryId: '../../etc', displayName: 'Shop', command: 'npm test' }] },
      { repositories: [{ repositoryId: 'shop', displayName: 'Shop', command: 'npm test', repositoryRoot: '/srv/shop' }] },
      { repositories: [{ repositoryId: 'shop', displayName: '', command: 'npm test' }] },
      { repositories: [], extra: true },
      [],
    ]) {
      await withTamper(both(stripOutputSchemas, replaceResult('list_repositories', content)), async (client) => {
        await rejectsWith(client.listRepositories(), 'invalid_response');
      });
    }
  });

  it('with no output schema advertised, the wrapper itself rejects malformed jobs', async () => {
    const { createdAt: _createdAt, ...missingCreatedAt } = VALID_JOB;
    for (const content of [
      { ...VALID_JOB, jobId: '/tmp/job' },
      { ...VALID_JOB, repositoryId: '../shop' },
      { ...VALID_JOB, status: 'done' },
      { ...VALID_JOB, createdAt: 'yesterday' },
      { ...VALID_JOB, failureReason: '' },
      { ...VALID_JOB, repositoryRoot: '/srv/shop' },
      missingCreatedAt,
    ]) {
      await withTamper(both(stripOutputSchemas, replaceResult('start_investigation', content)), async (client) => {
        await rejectsWith(client.startInvestigation('missing'), 'invalid_response');
      });
    }
  });

  it('with no output schema advertised, the wrapper itself rejects malformed results, including ungrounded outcomes that carry claims', async () => {
    for (const content of [
      { ...VALID_RESULT, outcome: { ...VALID_OUTCOME, groundingValid: false, repairStatus: null } },
      { ...VALID_RESULT, outcome: { ...VALID_OUTCOME, groundingValid: false } },
      { ...VALID_RESULT, outcome: { ...VALID_OUTCOME, repairStatus: 'fixed' } },
      { ...VALID_RESULT, outcome: { ...VALID_OUTCOME, claims: [{ ...VALID_OUTCOME.claims[0], evidenceIds: [] }] } },
      { ...VALID_RESULT, outcome: { ...VALID_OUTCOME, spokenSummary: '' } },
      { ...VALID_RESULT, outcome: { ...VALID_OUTCOME, hostPath: '/srv/shop' } },
      { ...VALID_RESULT, outcome: 'Verified.' },
      { ...VALID_RESULT, job: { ...VALID_RESULT.job, jobId: 'job-1' } },
      { job: VALID_RESULT.job },
    ]) {
      await withTamper(both(stripOutputSchemas, replaceResult('get_investigation_result', content)), async (client) => {
        await rejectsWith(client.getInvestigationResult(UNKNOWN_JOB), 'invalid_response');
      });
    }
  });

  it('well-formed content passes the same checks', async () => {
    const ungrounded = { ...VALID_OUTCOME, groundingValid: false, repairStatus: null, claims: [], baselineFailures: [], affectedFiles: [] };
    for (const content of [VALID_RESULT, { ...VALID_RESULT, outcome: ungrounded }, { job: VALID_JOB, outcome: null }]) {
      await withTamper(both(stripOutputSchemas, replaceResult('get_investigation_result', content)), async (client) => {
        assert.deepEqual(await client.getInvestigationResult(UNKNOWN_JOB), content);
      });
    }
    await withTamper(both(stripOutputSchemas, replaceResult('start_investigation', VALID_JOB)), async (client) => {
      assert.deepEqual(await client.startInvestigation('missing'), VALID_JOB);
    });
  });
});

describe('reconnecting', () => {
  it('after the MCP server restarts, the same client reconnects once and carries on', async () => {
    const service = unusedRepositoryService();
    let server = await startMcpHttpServer({ service, port: 0, token: TOKEN });
    const port = Number(server.url.port);
    const client = await DevPilotMcpClient.connect(options(server.url));
    try {
      assert.equal((await client.listRepositories()).length, 1);
      await server.close();

      const startedAt = Date.now();
      await rejectsWith(client.listRepositories(), 'unavailable');
      assert.ok(Date.now() - startedAt < 10_000, 'an outage fails fast instead of retrying');

      server = await startMcpHttpServer({ service, port, token: TOKEN });
      assert.deepEqual(await client.listRepositories(), [{ repositoryId: 'shop', displayName: 'Shop', command: 'npm test' }]);
      assert.equal(client.connections, 2);
      assert.equal(client.protocolEra, 'modern');
    } finally {
      await client.close();
      await server.close();
    }
  });

  describe('through a relay that can cut connections', () => {
    let server: McpHttpServer;
    let relay: Relay;
    let client: DevPilotMcpClient;

    before(async () => {
      server = await startMcpHttpServer({ service: unusedRepositoryService(), port: 0, token: TOKEN });
      relay = await startRelay(server.url);
      client = await DevPilotMcpClient.connect(options(relay.url));
    });

    after(async () => {
      await client?.close();
      await relay?.close();
      await server?.close();
    });

    it('a call whose connection is cut is retried once, on a fresh connection', async () => {
      relay.methods.length = 0;
      let remaining = 1;
      relay.drop = () => remaining-- > 0;
      const before = client.connections;
      assert.equal((await client.listRepositories()).length, 1);
      assert.deepEqual(relay.methods, ['tools/call', 'server/discover', 'tools/list', 'tools/call']);
      assert.equal(client.connections, before + 1);
    });

    it('when the reconnect also fails, the call gives up after one attempt: no retry loop', async () => {
      relay.methods.length = 0;
      relay.drop = () => true;
      const before = client.connections;
      await rejectsWith(client.startInvestigation('shop'), 'unavailable');
      assert.deepEqual(relay.methods, ['tools/call', 'server/discover']);

      relay.methods.length = 0;
      await rejectsWith(client.getInvestigationResult(UNKNOWN_JOB), 'unavailable');
      assert.deepEqual(relay.methods, ['server/discover'], 'a broken client reconnects first, once');

      relay.drop = () => false;
      relay.methods.length = 0;
      await rejectsWith(client.getInvestigationResult(UNKNOWN_JOB), 'tool_error');
      assert.deepEqual(relay.methods, ['server/discover', 'tools/list', 'tools/call']);
      assert.equal(client.connections, before + 1);
    });

    it('concurrent calls on a broken connection share one reconnect', async () => {
      relay.methods.length = 0;
      let reconnecting = false;
      relay.drop = (method) => {
        if (method === 'server/discover') reconnecting = true;
        return method === 'tools/call' && !reconnecting;
      };
      const before = client.connections;
      const results = await Promise.all([client.listRepositories(), client.listRepositories(), client.listRepositories()]);
      assert.deepEqual(results.map((repositories) => repositories.length), [1, 1, 1]);
      assert.equal(relay.methods.filter((method) => method === 'server/discover').length, 1);
      assert.equal(client.connections, before + 1);
    });
  });
});

describe('token hygiene', () => {
  it('no McpClientError, reported error, or client object contains the token', async () => {
    assert.ok(thrown.length > 20, `only ${thrown.length} errors were collected`);
    assert.ok(reported.length > 0, 'underlying errors were reported');
    for (const error of thrown) {
      assertTokenFree(error, `${error.code} error`);
      if (error.code !== 'invalid_configuration') assert.equal(error.message, CLIENT_ERROR_TEXT[error.code], 'messages are fixed text');
      assert.equal(error.cause, undefined, 'underlying errors are not attached');
      if (error.detail !== undefined) assert.ok(error.detail.length <= 500);
    }
    for (const error of reported) assertTokenFree(error, 'reported error');

    const server = await startMcpHttpServer({ service: unusedRepositoryService(), port: 0, token: TOKEN });
    const client = await DevPilotMcpClient.connect(options(server.url));
    try {
      assertTokenFree(client, 'client');
      assert.ok(!JSON.stringify(client).includes(TOKEN));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('a tool error that echoes the token has it removed from the detail', async () => {
    const server = await startMcpHttpServer({ service: unusedRepositoryService(), port: 0, token: TOKEN });
    const relay = await startRelay(server.url);
    relay.tamper = (method, _tool, response) => {
      if (method === 'tools/call') rewriteResult(response, { content: [{ type: 'text', text: `refused for Bearer ${TOKEN}` }], isError: true });
    };
    const client = await DevPilotMcpClient.connect(options(relay.url));
    try {
      const error = await rejectsWith(client.listRepositories(), 'tool_error');
      assert.equal(error.detail, 'refused for Bearer [redacted]');
    } finally {
      await client.close();
      await relay.close();
      await server.close();
    }
  });
});

describe('source boundaries', () => {
  const ALLOWED = /^(node:[a-z/_]+|@modelcontextprotocol\/client|\.\/[a-z-]+\.js)$/;
  const FORBIDDEN =
    /@devpilot\/|packages\/|RepairWorkflow|InvestigationService|GroundedRepairPipeline|child_process|require\(|@modelcontextprotocol\/(server|node|sdk|core)|express|hono|aws-sdk|@aws|bedrock|alexa|console\./i;

  it('voice-demo source imports only @modelcontextprotocol/client and node built-ins', async () => {
    const files = (await readdir(path.join(DEMO_ROOT, 'src'), { recursive: true })).filter((file) => /\.[cm]?[jt]sx?$/.test(file));
    assert.deepEqual(files.sort(), ['mcp-client.ts']);
    for (const file of files) {
      const source = await readFile(path.join(DEMO_ROOT, 'src', file), 'utf8');
      const specifiers = [...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
      assert.ok(specifiers.length > 0);
      for (const specifier of specifiers) assert.match(specifier ?? '', ALLOWED, `${file} imports ${specifier}`);
      assert.ok(!FORBIDDEN.test(source), `${file} references ${source.match(FORBIDDEN)?.[0]}`);
    }
  });

  it('the package depends on exactly @modelcontextprotocol/client 2.3.1', async () => {
    const manifest = JSON.parse(await readFile(path.join(DEMO_ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(manifest.name, '@devpilot/voice-demo');
    assert.deepEqual(manifest.dependencies, { '@modelcontextprotocol/client': '2.3.1' });
    for (const field of ['devDependencies', 'peerDependencies', 'optionalDependencies']) assert.equal(manifest[field], undefined, field);
  });
});
