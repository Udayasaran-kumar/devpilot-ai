import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect, isDeepStrictEqual } from 'node:util';
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
import { createGitRepositoryFixture, git, type GitRepositoryFixture } from '../../../packages/tools/test/support/git-repository.js';
import {
  dialogConfigFromEnvironment,
  INITIAL_DIALOG_STATE,
  SERVER_REFUSAL_TEXT,
  SPEECH,
  VoiceDialog,
  type DialogKind,
  type DialogState,
  type DialogTurn,
} from '../src/dialog.js';
import { classifyIntent, MAX_UTTERANCE_LENGTH, normalizeUtterance, type Intent } from '../src/intents.js';
import {
  CLIENT_ERROR_TEXT,
  DevPilotMcpClient,
  McpClientError,
  type DevPilotMcpClientOptions,
  type GroundedClaim,
  type GroundedClaimKind,
  type InvestigationOutcome,
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

describe('intent classification', () => {
  const EXAMPLES: Record<Intent, readonly string[]> = {
    START_INVESTIGATION: [
      'investigate the failing tests',
      'investigate my repository',
      'check the failing tests',
      "find out what's wrong",
      'start an investigation',
      'Investigate the failing tests in my repository.',
      'please investigate shop',
      'check my broken test',
    ],
    GET_RESULT: [
      'what did you find',
      'what did you find?',
      'what is the result',
      "what's the status",
      'give me the result',
      'is it fixed',
      'What did you find in the investigation?',
      'what is the result of the investigation',
      'tell me the outcome',
    ],
    HELP: ['', '   ', 'hello', 'help', 'what can you do', 'fix it', 'apply the patch', 'deploy to production', 'investigating', 'delete the repository', 'whats wrong'],
  };

  for (const [intent, utterances] of Object.entries(EXAMPLES) as Array<[Intent, readonly string[]]>) {
    it(`recognises ${intent}`, () => {
      for (const utterance of utterances) assert.equal(classifyIntent(utterance).intent, intent, JSON.stringify(utterance));
    });
  }

  it('normalizes case, whitespace, punctuation, and apostrophes, and keeps the original utterance', () => {
    const classified = classifyIntent('  WHAT   Did\tYOU\nfind ?? ');
    assert.deepEqual(classified, { intent: 'GET_RESULT', utterance: '  WHAT   Did\tYOU\nfind ?? ', normalized: 'what did you find' });
    assert.equal(classifyIntent('What\u2019s the status').intent, 'GET_RESULT');
    assert.equal(classifyIntent('\uFF29\uFF2E\uFF36\uFF25\uFF33\uFF34\uFF29\uFF27\uFF21\uFF34\uFF25').intent, 'START_INVESTIGATION');
    assert.equal(normalizeUtterance('Shop-Two!'), 'shop two');
  });

  it('prefers reading a result when an utterance also asks to investigate', () => {
    assert.equal(classifyIntent('investigate and tell me the result').intent, 'GET_RESULT');
  });

  it('does not start an investigation for a negated request or a question about whether to start one', () => {
    const utterances = [
      "don't investigate",
      'do not investigate anything',
      'please do not start an investigation',
      "don't check the failing tests",
      'never investigate my repo',
      'should I investigate?',
      'stop investigating',
      'cancel the investigation',
      'Don\u2019t investigate',
      'DO NOT INVESTIGATE THE FAILING TESTS',
      "I don't want you to investigate",
      'no need to check the failing tests',
      'should we start an investigation?',
      'do I need to investigate?',
      'stop and start an investigation',
      'investigate? no, do not investigate',
    ];
    for (const utterance of utterances) assert.equal(classifyIntent(utterance).intent, 'HELP', JSON.stringify(utterance));
  });

  it('a negation or question changes only the utterance it precedes the request in', () => {
    const pairs: ReadonlyArray<readonly [start: string, help: string]> = [
      ['investigate the failing tests', "don't investigate the failing tests"],
      ['investigate my repository', 'never investigate my repository'],
      ['check the failing tests', 'do not check the failing tests'],
      ["find out what's wrong", "no need to find out what's wrong"],
      ['start an investigation', 'please do not start an investigation'],
      ['can you investigate?', 'should I investigate?'],
      ['investigate why the tests do not pass', 'do not investigate why the tests fail'],
      ['investigate, and never mind the warnings', 'never mind, do not investigate'],
    ];
    for (const [start, help] of pairs) {
      assert.equal(classifyIntent(start).intent, 'START_INVESTIGATION', JSON.stringify(start));
      assert.equal(classifyIntent(help).intent, 'HELP', JSON.stringify(help));
    }
  });

  it('a negation directly before or after the request, or a leading refusal, does not start an investigation', () => {
    const utterances = [
      'you should not investigate',
      "you shouldn't investigate",
      'you must not investigate',
      "you mustn't investigate",
      "let's not investigate",
      'I would rather you not investigate',
      "I'd prefer you didn't investigate",
      'investigate nothing',
      'no, investigate',
      'not now, investigate later',
      'YOU SHOULD NOT INVESTIGATE.',
      'You shouldn\u2019t investigate!',
      'You mustn\u2019t investigate the failing tests.',
      'Let\u2019s not investigate.',
      'I\u2019d prefer you didn\u2019t investigate',
      'Investigate nothing.',
      'No \u2014 investigate.',
      'NO, INVESTIGATE',
      'Not now; investigate later.',
      'please try not to investigate',
      'you should not investigate, check the failing tests',
    ];
    for (const utterance of utterances) assert.equal(classifyIntent(utterance).intent, 'HELP', JSON.stringify(utterance));
  });

  it('a negation inside the reason or object of the request does not block it', () => {
    const utterances = [
      'investigate why the tests do not pass',
      'investigate the tests that never pass',
      'investigate the stop button bug',
      'investigate why the API does not return 200',
      "investigate tests that aren't passing",
      'investigate tests that aren\u2019t passing',
      'investigate why nothing passes',
      'investigate why we cannot log in',
      'investigate the not-found page',
      'nothing passes, investigate',
      'urgent: investigate the failing tests',
    ];
    for (const utterance of utterances) assert.equal(classifyIntent(utterance).intent, 'START_INVESTIGATION', JSON.stringify(utterance));
  });

  it('negating the request, not its reason, is what turns a start into help', () => {
    const pairs: ReadonlyArray<readonly [start: string, help: string]> = [
      ['investigate the failing tests', "let's not investigate the failing tests"],
      ['investigate why the tests do not pass', 'you should not investigate why the tests do not pass'],
      ['investigate the stop button bug', 'you must not investigate the stop button bug'],
      ["investigate tests that aren't passing", "don't investigate tests that aren't passing"],
      ['investigate', 'no, investigate'],
      ['investigate later', 'not now, investigate later'],
      ['investigate why nothing passes', 'investigate nothing'],
    ];
    for (const [start, help] of pairs) {
      assert.equal(classifyIntent(start).intent, 'START_INVESTIGATION', JSON.stringify(start));
      assert.equal(classifyIntent(help).intent, 'HELP', JSON.stringify(help));
    }
    assert.equal(classifyIntent('no, tell me the result').intent, 'GET_RESULT');
  });

  it('returns only the intent: nothing in the utterance is taken as a fact', () => {
    const classified = classifyIntent('investigate: the total test fails because of rounding in src/money.ts');
    assert.deepEqual(Object.keys(classified).sort(), ['intent', 'normalized', 'utterance']);
    assert.equal(classified.intent, 'START_INVESTIGATION');
  });

  it('does not interpret oversized or non-string input', () => {
    assert.equal(classifyIntent(`investigate ${'x'.repeat(MAX_UTTERANCE_LENGTH)}`).intent, 'HELP');
    assert.deepEqual(classifyIntent(undefined as unknown as string), { intent: 'HELP', utterance: '', normalized: '' });
  });

  it('reads the configured repository from DEVPILOT_DEMO_REPOSITORY_ID', () => {
    assert.deepEqual(dialogConfigFromEnvironment({ DEVPILOT_DEMO_REPOSITORY_ID: ' shop ' }), { repositoryId: 'shop' });
    assert.deepEqual(dialogConfigFromEnvironment({ DEVPILOT_DEMO_REPOSITORY_ID: '' }), {});
    assert.deepEqual(dialogConfigFromEnvironment({}), {});
  });
});

/** Every dialog turn, checked for leaks at the end. */
const dialogTurns: DialogTurn[] = [];
const dialogHostPaths = new Set<string>([homedir(), tmpdir()]);

async function say(dialog: VoiceDialog, utterance: string, state: DialogState = INITIAL_DIALOG_STATE): Promise<DialogTurn> {
  const turn = await dialog.respond(utterance, state);
  dialogTurns.push(turn);
  return turn;
}

/** Asks for the result until the job is no longer in progress. */
async function untilSettled(dialog: VoiceDialog, state: DialogState): Promise<DialogTurn> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const turn = await say(dialog, 'what did you find?', state);
    if (turn.response.kind !== 'in_progress') return turn;
    if (Date.now() > deadline) throw new Error('The investigation did not finish in time');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The sample repository with its tests passing, so the real pipeline completes without a verified repair. */
async function createPassingRepositoryFixture(executable: GitExecutable): Promise<GitRepositoryFixture> {
  const fixture = await createGitRepositoryFixture(executable);
  await writeFile(path.join(fixture.root, 'test/checkout.test.ts'), "import { test } from 'node:test';\n\ntest('passes', () => {});\n");
  git(executable, fixture.root, 'commit', '-q', '-am', 'Make the tests pass');
  return fixture;
}

function rememberHostPaths(fixture: GitRepositoryFixture): void {
  for (const hostPath of [fixture.base, fixture.root, fixture.canonicalRoot, fixture.allowedRoot]) dialogHostPaths.add(hostPath);
}

const NO_VERIFIED_SUCCESS = /verified a patch|passed after the change|\bwas fixed\b|\bis fixed\b|\bsucceeded\b|\bsuccessful(ly)?\b|\brepaired\b/i;

/** Internal detail that real reports contain and cards must not show. */
const INTERNAL_CLAIM_DETAIL = ['npm test', 'hyp-', 'awaiting_verification', 'review status', 'verification command'];

/** Every shown item is one of the server's, unchanged, and in the server's order: nothing is reworded or added. */
function assertShownInOrder<T>(shown: readonly T[], source: readonly T[], label: string): void {
  let next = 0;
  for (const item of shown) {
    const index = source.findIndex((candidate, position) => position >= next && isDeepStrictEqual(candidate, item));
    assert.ok(index >= 0, `${label}: ${inspect(item)} is not in the server's result, in order`);
    next = index + 1;
  }
}

describe('dialog against the real DevPilot MCP server', () => {
  let executable: GitExecutable;
  let shop: GitRepositoryFixture;
  let green: GitRepositoryFixture;
  let server: McpHttpServer;
  let client: DevPilotMcpClient;
  let dialog: VoiceDialog;
  let shopState: DialogState;
  let greenState: DialogState;

  before(async () => {
    executable = await resolveGitExecutable();
    shop = await createGitRepositoryFixture(executable);
    green = await createPassingRepositoryFixture(executable);
    rememberHostPaths(shop);
    rememberHostPaths(green);
    const registry = new RepositoryRegistry();
    registry.register({ repositoryId: 'shop', displayName: 'Shop', repositoryRoot: shop.root, allowedRoot: shop.allowedRoot, verification: NPM_TEST, defaultSignal: FAILURE });
    registry.register({ repositoryId: 'green', displayName: 'Green', repositoryRoot: green.root, allowedRoot: green.allowedRoot, verification: NPM_TEST, defaultSignal: FAILURE });
    const quietRoot = path.join(tmpdir(), 'devpilot-voice-demo-unused', 'quiet');
    dialogHostPaths.add(quietRoot);
    registry.register({ repositoryId: 'quiet', displayName: 'Quiet', repositoryRoot: quietRoot, verification: NPM_TEST });
    server = await startMcpHttpServer({ service: new InvestigationService({ registry, git: executable }), port: 0, token: TOKEN });
    client = await DevPilotMcpClient.connect(options(server.url));
    dialog = new VoiceDialog(client);
  });

  after(async () => {
    await client?.close();
    await server?.close();
    await shop?.cleanup();
    await green?.cleanup();
  });

  it('answers unknown requests with help and leaves the state alone', async () => {
    const turn = await say(dialog, 'deploy to production');
    assert.equal(turn.intent, 'HELP');
    assert.deepEqual(turn.response, { kind: 'help', speech: SPEECH.help });
    assert.equal(turn.state, INITIAL_DIALOG_STATE);
  });

  it('has nothing to report before an investigation is started', async () => {
    const turn = await say(dialog, 'what did you find?');
    assert.deepEqual(turn.response, { kind: 'no_investigation', speech: SPEECH.noInvestigation });
    assert.equal(turn.state, INITIAL_DIALOG_STATE);
  });

  it('asks which repository when several are registered and none is selected, by display name only', async () => {
    const turn = await say(dialog, 'investigate the failing tests');
    assert.equal(turn.response.kind, 'choose_repository');
    assert.equal(turn.response.speech, SPEECH.chooseRepository(['Shop', 'Green', 'Quiet']));
    assert.equal(turn.response.speech, 'Which repository should I investigate? Say "investigate" followed by its name: Shop, Green or Quiet.');
    assert.deepEqual(turn.response.card, {
      repositories: [
        { repositoryId: 'shop', displayName: 'Shop' },
        { repositoryId: 'green', displayName: 'Green' },
        { repositoryId: 'quiet', displayName: 'Quiet' },
      ],
    });
    assert.ok(!JSON.stringify(turn.response).includes('npm'), 'the verification command is not exposed');
    assert.equal(turn.state, INITIAL_DIALOG_STATE);
  });

  it('starts an investigation of the named repository and stores the opaque job ID', async () => {
    const turn = await say(dialog, 'Investigate Shop, please');
    assert.equal(turn.intent, 'START_INVESTIGATION');
    assert.equal(turn.response.kind, 'started');
    assert.equal(turn.response.speech, SPEECH.started('Shop'));
    assert.doesNotMatch(turn.response.speech, NO_VERIFIED_SUCCESS);
    assert.match(turn.state.jobId ?? '', /^job-[0-9a-f-]{36}$/);
    assert.deepEqual(turn.state, { repositoryId: 'shop', jobId: turn.state.jobId, investigationStarted: true });
    assert.equal(turn.response.jobId, turn.state.jobId);
    assert.deepEqual(turn.response.card, { repository: { repositoryId: 'shop', displayName: 'Shop' }, jobStatus: 'queued' });
    shopState = turn.state;
  });

  it('a second start while it runs reports the running investigation and keeps the job ID', async () => {
    const turn = await say(dialog, 'investigate the failing tests', shopState);
    assert.equal(turn.response.kind, 'busy');
    assert.equal(turn.response.speech, SPEECH.busyTracked('Shop'));
    assert.equal(turn.state, shopState);
    assert.equal(turn.response.jobId, shopState.jobId);
  });

  it('a start from another conversation does not claim it started anything', async () => {
    const turn = await say(dialog, 'investigate shop');
    assert.equal(turn.response.kind, 'busy');
    assert.equal(turn.response.speech, SPEECH.busyUntracked('Shop'));
    assert.equal(turn.state, INITIAL_DIALOG_STATE);
    assert.equal(turn.response.jobId, undefined);
  });

  it('while the job runs, says it is still investigating and claims nothing', async () => {
    const turn = await say(dialog, 'what did you find?', shopState);
    assert.ok(['in_progress', 'verified'].includes(turn.response.kind), turn.response.kind);
    if (turn.response.kind === 'in_progress') {
      assert.equal(turn.response.speech, SPEECH.inProgress);
      assert.ok(['queued', 'running'].includes(turn.response.card?.jobStatus ?? ''));
      assert.equal(turn.response.card?.verified, undefined);
    }
    assert.equal(turn.state, shopState);
  });

  it('speaks the server\'s spoken summary for the verified repair, unchanged, and shows only its presentable claims on the card', async () => {
    const turn = await untilSettled(dialog, shopState);
    const { outcome } = await client.getInvestigationResult(shopState.jobId ?? '');
    assert.ok(outcome);
    assert.equal(turn.response.kind, 'verified');
    assert.equal(turn.response.speech, outcome.spokenSummary);
    const card = turn.response.card;
    assert.ok(card?.claims && card.limitations);
    assert.deepEqual(Object.keys(card).sort(), ['affectedFiles', 'baselineFailures', 'claims', 'jobStatus', 'limitations', 'repairStatus', 'verified']);
    assert.equal(card.jobStatus, 'completed');
    assert.equal(card.verified, true);
    assert.equal(card.repairStatus, 'repaired');
    assert.deepEqual(card.baselineFailures, outcome.baselineFailures);
    assert.deepEqual(card.affectedFiles, outcome.affectedFiles);

    // The real report carries internal detail; the card shows the rest of it word for word, in order.
    const raw = JSON.stringify(outcome);
    for (const detail of INTERNAL_CLAIM_DETAIL) assert.ok(raw.includes(detail), `the real report no longer mentions ${detail}`);
    assertShownInOrder(card.claims, outcome.claims.map((claim) => ({ kind: claim.kind, statement: claim.statement })), 'claims');
    assertShownInOrder(card.limitations, outcome.limitations, 'limitations');
    assert.deepEqual(
      card.claims.map((claim) => claim.kind),
      ['observation', 'observation', 'verification'],
    );
    assert.ok(card.claims[0]?.statement.startsWith('Baseline failure: test "applies tax to the discounted amount"'));
    assert.equal(card.claims[1]?.statement, 'The proposed patch was applied, unmodified, in an isolated worktree.');
    assert.ok(card.claims[2]?.statement.startsWith('Verified: the previously failing test "applies tax to the discounted amount"'));
    assert.ok(card.limitations.length > 0 && card.limitations.length < outcome.limitations.length);
    const shown = JSON.stringify(turn.response);
    for (const detail of INTERNAL_CLAIM_DETAIL) assert.ok(!shown.includes(detail), `the card shows ${detail}`);
    assert.deepEqual(card.baselineFailures?.map((failure) => failure.testName), ['applies tax to the discounted amount']);
    assert.equal(turn.state, shopState, 'reading the result keeps the job');
    assert.equal(turn.response.jobId, shopState.jobId);
  });

  it('a completed investigation without a verified repair says so and adds only the server\'s summary', async () => {
    const started = await say(dialog, 'investigate green', shopState);
    assert.equal(started.response.kind, 'started');
    assert.notEqual(started.state.jobId, shopState.jobId);
    greenState = started.state;
    const turn = await untilSettled(dialog, greenState);
    const { outcome } = await client.getInvestigationResult(greenState.jobId ?? '');
    assert.ok(outcome);
    assert.equal(outcome.repairStatus, 'not_attempted');
    assert.equal(turn.response.kind, 'not_verified');
    assert.equal(turn.response.speech, `${SPEECH.notVerified} ${outcome.spokenSummary}`);
    assert.doesNotMatch(turn.response.speech, NO_VERIFIED_SUCCESS);
    assert.equal(turn.response.card?.verified, false);
    assert.equal(turn.response.card?.repairStatus, 'not_attempted');
    assertShownInOrder(turn.response.card?.claims ?? [], outcome.claims.map((claim) => ({ kind: claim.kind, statement: claim.statement })), 'claims');
    assertShownInOrder(turn.response.card?.limitations ?? [], outcome.limitations, 'limitations');
    assert.equal(turn.state, greenState);
  });

  it('a refused start does not overwrite the current job', async () => {
    const turn = await say(dialog, 'investigate quiet', greenState);
    assert.equal(turn.response.kind, 'signal_required');
    assert.equal(turn.response.speech, SPEECH.signalRequired('Quiet'));
    assert.equal(turn.state, greenState);
    assert.equal(turn.response.jobId, greenState.jobId);
  });

  it('uses the configured repository when none is named, and a named one over it', async () => {
    const configured = new VoiceDialog(client, dialogConfigFromEnvironment({ DEVPILOT_DEMO_REPOSITORY_ID: 'green' }));
    const named = await say(configured, 'investigate quiet');
    assert.equal(named.response.kind, 'signal_required');

    const turn = await say(configured, 'investigate the failing tests');
    assert.equal(turn.response.kind, 'started');
    assert.equal(turn.response.speech, SPEECH.started('Green'));
    assert.equal(turn.state.repositoryId, 'green');
    assert.equal((await untilSettled(configured, turn.state)).response.kind, 'not_verified');
  });

  it('a configured repository that is not registered starts nothing', async () => {
    const turn = await say(new VoiceDialog(client, { repositoryId: 'ghost' }), 'investigate the failing tests');
    assert.deepEqual(turn.response, { kind: 'repository_not_registered', speech: SPEECH.repositoryNotRegistered });
    assert.equal(turn.state, INITIAL_DIALOG_STATE);
  });

  it('an unknown job is reported as no longer available, and forgotten', async () => {
    const state: DialogState = { repositoryId: 'shop', jobId: UNKNOWN_JOB, investigationStarted: true };
    const turn = await say(dialog, 'what did you find', state);
    assert.deepEqual(turn.response, { kind: 'investigation_unavailable', speech: SPEECH.unavailable });
    assert.deepEqual(turn.state, { repositoryId: 'shop', jobId: undefined, investigationStarted: false });
  });
});

describe('dialog with one repository, across a restart and an outage', () => {
  let executable: GitExecutable;
  let solo: GitRepositoryFixture;
  let server: McpHttpServer;
  let client: DevPilotMcpClient;
  let dialog: VoiceDialog;
  let state: DialogState;
  let port: number;

  const service = () => {
    const registry = new RepositoryRegistry();
    registry.register({ repositoryId: 'solo', displayName: 'Solo', repositoryRoot: solo.root, allowedRoot: solo.allowedRoot, verification: NPM_TEST, defaultSignal: FAILURE });
    return new InvestigationService({ registry, git: executable });
  };

  before(async () => {
    executable = await resolveGitExecutable();
    solo = await createPassingRepositoryFixture(executable);
    rememberHostPaths(solo);
    server = await startMcpHttpServer({ service: service(), port: 0, token: TOKEN });
    port = Number(server.url.port);
    client = await DevPilotMcpClient.connect(options(server.url));
    dialog = new VoiceDialog(client);
  });

  after(async () => {
    await client?.close();
    await server?.close();
    await solo?.cleanup();
  });

  it('selects the only repository automatically', async () => {
    const turn = await say(dialog, 'Investigate the failing tests in my repository.');
    assert.equal(turn.response.kind, 'started');
    assert.equal(turn.response.speech, SPEECH.started('Solo'));
    state = turn.state;
    assert.equal((await untilSettled(dialog, state)).response.kind, 'not_verified');
  });

  it('after the server restarts, the job is no longer available', async () => {
    await server.close();
    server = await startMcpHttpServer({ service: service(), port, token: TOKEN });
    const turn = await say(dialog, 'what did you find?', state);
    assert.deepEqual(turn.response, { kind: 'investigation_unavailable', speech: SPEECH.unavailable });
    assert.equal(turn.state.jobId, undefined);
  });

  it('when the server is unreachable, both requests fail generically and the job is kept', async () => {
    await server.close();
    const result = await say(dialog, 'what did you find?', state);
    assert.deepEqual(result.response, { kind: 'error', speech: SPEECH.error, jobId: state.jobId });
    assert.equal(result.state, state);
    const start = await say(dialog, 'investigate the failing tests', state);
    assert.deepEqual(start.response, { kind: 'error', speech: SPEECH.error, jobId: state.jobId });
    assert.equal(start.state, state);
  });
});

describe('dialog over rewritten server responses', () => {
  let server: McpHttpServer;
  let relay: Relay;
  let client: DevPilotMcpClient;
  let dialog: VoiceDialog;
  const state: DialogState = { repositoryId: 'shop', jobId: UNKNOWN_JOB, investigationStarted: true };
  const JOB = { jobId: UNKNOWN_JOB, repositoryId: 'shop', status: 'completed', createdAt: '2026-10-08T00:00:00.000Z', finishedAt: '2026-10-08T00:01:00.000Z' };
  const UNGROUNDED = {
    investigationId: 'investigation-1',
    groundingValid: false,
    repairStatus: null,
    claims: [],
    baselineFailures: [],
    affectedFiles: [],
    limitations: ['The report did not pass grounding validation, so no findings are reported.'],
    spokenSummary: 'DevPilot has no verified result for Shop.',
  };
  const REPAIRED = {
    ...UNGROUNDED,
    groundingValid: true,
    repairStatus: 'repaired',
    claims: [{ id: 'claim-1', kind: 'verification', statement: 'The previously failing test passed.', evidenceIds: ['ev-final'], actionIds: [] }],
    baselineFailures: [{ testFile: 'test/example.test.ts', suite: [], testName: 'example' }],
    affectedFiles: ['src/example.ts'],
    limitations: [],
    spokenSummary: "DevPilot investigated Shop; the report's claims describe the result.",
  };

  before(async () => {
    server = await startMcpHttpServer({ service: unusedRepositoryService(), port: 0, token: TOKEN });
    relay = await startRelay(server.url);
    client = await DevPilotMcpClient.connect(options(relay.url));
    dialog = new VoiceDialog(client);
  });

  after(async () => {
    await client?.close();
    await relay?.close();
    await server?.close();
  });

  async function resultFor(structuredContent: unknown): Promise<DialogTurn> {
    relay.tamper = replaceResult('get_investigation_result', structuredContent);
    try {
      return await say(dialog, 'what did you find?', state);
    } finally {
      relay.tamper = undefined;
    }
  }

  it('queued and running jobs are in progress, with no verdict', async () => {
    for (const status of ['queued', 'running'] as const) {
      const { finishedAt: _finishedAt, ...job } = JOB;
      const turn = await resultFor({ job: { ...job, status }, outcome: null });
      assert.deepEqual(turn.response, { kind: 'in_progress', speech: SPEECH.inProgress, jobId: UNKNOWN_JOB, card: { jobStatus: status } });
      assert.equal(turn.state, state);
    }
  });

  it('a failed job says no repair was verified and does not repeat the server\'s reason', async () => {
    const turn = await resultFor({ job: { ...JOB, status: 'failed', failureReason: 'ENOENT /srv/devpilot/secret-repo' }, outcome: null });
    assert.deepEqual(turn.response, { kind: 'failed', speech: SPEECH.failed, jobId: UNKNOWN_JOB, card: { jobStatus: 'failed', verified: false } });
  });

  it('a completed job without an outcome, or with an ungrounded or unrepaired one, is not verified', async () => {
    const noOutcome = await resultFor({ job: JOB, outcome: null });
    assert.deepEqual(noOutcome.response, { kind: 'not_verified', speech: SPEECH.notVerified, jobId: UNKNOWN_JOB, card: { jobStatus: 'completed', verified: false } });

    const ungrounded = await resultFor({ job: JOB, outcome: UNGROUNDED });
    assert.equal(ungrounded.response.kind, 'not_verified');
    assert.equal(ungrounded.response.speech, `${SPEECH.notVerified} DevPilot has no verified result for Shop.`);
    assert.deepEqual(ungrounded.response.card, {
      jobStatus: 'completed',
      verified: false,
      repairStatus: null,
      claims: [],
      baselineFailures: [],
      affectedFiles: [],
      limitations: UNGROUNDED.limitations,
    });

    for (const repairStatus of ['verification_failed', 'not_attempted', 'baseline_not_red', 'error']) {
      const turn = await resultFor({ job: JOB, outcome: { ...REPAIRED, repairStatus } });
      assert.equal(turn.response.kind, 'not_verified', repairStatus);
      assert.ok(turn.response.speech.startsWith(SPEECH.notVerified), repairStatus);
      assert.equal(turn.response.card?.verified, false);
    }
  });

  it('a grounded repair is spoken exactly as the server summarised it', async () => {
    const turn = await resultFor({ job: JOB, outcome: REPAIRED });
    assert.equal(turn.response.kind, 'verified');
    assert.equal(turn.response.speech, REPAIRED.spokenSummary);
    assert.deepEqual(turn.response.card?.claims, [{ kind: 'verification', statement: 'The previously failing test passed.' }]);
  });

  it('a repaired status without grounding is never presented as a success', async () => {
    const turn = await resultFor({ job: JOB, outcome: { ...REPAIRED, groundingValid: false } });
    assert.deepEqual(turn.response, { kind: 'error', speech: SPEECH.error, jobId: UNKNOWN_JOB });
  });

  it('a result for a different job is not reported', async () => {
    const turn = await resultFor({ job: { ...JOB, jobId: 'job-11111111-1111-4111-8111-111111111111' }, outcome: REPAIRED });
    assert.deepEqual(turn.response, { kind: 'error', speech: SPEECH.error, jobId: UNKNOWN_JOB });
  });

  it('unrecognised refusal text and raw errors become the generic reply', async () => {
    for (const text of ['Error: ENOENT: /Users/alice/repo at run (/srv/app.js:1:2)', 'repository busy', `${SERVER_REFUSAL_TEXT.unknownJob} Details: /Users/alice/repo`]) {
      relay.tamper = (method, tool, response) => {
        if (method === 'tools/call' && tool !== 'list_repositories') rewriteResult(response, { content: [{ type: 'text', text }], isError: true });
      };
      try {
        const result = await say(dialog, 'what did you find?', state);
        assert.deepEqual(result.response, { kind: 'error', speech: SPEECH.error, jobId: UNKNOWN_JOB }, text);
        const start = await say(dialog, 'investigate shop', state);
        assert.deepEqual(start.response, { kind: 'error', speech: SPEECH.error, jobId: UNKNOWN_JOB }, text);
        assert.equal(start.state, state);
      } finally {
        relay.tamper = undefined;
      }
    }
  });

  it('a repository listing that carries a path is refused, and nothing is started', async () => {
    relay.methods.length = 0;
    relay.tamper = replaceResult('list_repositories', {
      repositories: [{ repositoryId: 'shop', displayName: 'Shop', command: 'npm test', repositoryRoot: '/srv/devpilot/secret-repo' }],
    });
    try {
      const turn = await say(dialog, 'investigate shop');
      assert.deepEqual(turn.response, { kind: 'error', speech: SPEECH.error });
      assert.deepEqual(relay.methods, ['tools/call'], 'no start was attempted');
    } finally {
      relay.tamper = undefined;
    }
  });

  it('the longest repository name in the utterance wins, and a tie asks the user to choose', async () => {
    const listing = (repositories: Array<{ repositoryId: string; displayName: string }>) =>
      replaceResult('list_repositories', { repositories: repositories.map((repository) => ({ ...repository, command: 'npm test' })) });
    const started = replaceResult('start_investigation', { ...JOB, status: 'queued', finishedAt: undefined });

    relay.tamper = both(listing([{ repositoryId: 'shop', displayName: 'Shop' }, { repositoryId: 'shop-two', displayName: 'Shop Two' }]), started);
    try {
      const turn = await say(dialog, 'investigate shop two');
      assert.equal(turn.response.kind, 'started');
      assert.deepEqual(turn.response.card?.repository, { repositoryId: 'shop-two', displayName: 'Shop Two' });

      relay.tamper = both(listing([{ repositoryId: 'alpha', displayName: 'Shop' }, { repositoryId: 'beta', displayName: 'Shop' }]), started);
      const tie = await say(dialog, 'investigate shop');
      assert.equal(tie.response.kind, 'choose_repository');
      assert.equal(tie.state, INITIAL_DIALOG_STATE);

      relay.tamper = listing([]);
      const none = await say(dialog, 'investigate the failing tests', state);
      assert.deepEqual(none.response, { kind: 'no_repositories', speech: SPEECH.noRepositories, jobId: UNKNOWN_JOB });
      assert.equal(none.state, state);
    } finally {
      relay.tamper = undefined;
    }
  });
});

describe('dialog safety', () => {
  it('does not treat a repaired status without grounding as verified, even if handed one directly', async () => {
    // The MCP client wrapper already refuses this outcome; this checks the dialog's own rule without it.
    const outcome = {
      investigationId: 'investigation-1',
      groundingValid: false,
      repairStatus: 'repaired',
      claims: [],
      baselineFailures: [],
      affectedFiles: [],
      limitations: [],
      spokenSummary: 'DevPilot verified a patch.',
    } as const;
    const job = { jobId: UNKNOWN_JOB, repositoryId: 'shop', status: 'completed', createdAt: '2026-10-08T00:00:00.000Z' } as const;
    const stub = {
      listRepositories: async () => [],
      startInvestigation: async () => job,
      getInvestigationResult: async () => ({ job, outcome }),
    };
    const turn = await new VoiceDialog(stub).respond('what did you find?', { repositoryId: 'shop', jobId: UNKNOWN_JOB, investigationStarted: true });
    assert.equal(turn.response.kind, 'not_verified');
    assert.equal(turn.response.card?.verified, false);
    assert.ok(turn.response.speech.startsWith(SPEECH.notVerified));
  });

  it('a negated or questioning start never reaches the client', async () => {
    const calls: string[] = [];
    const job = { jobId: UNKNOWN_JOB, repositoryId: 'shop', status: 'queued', createdAt: '2026-10-08T00:00:00.000Z' } as const;
    const dialog = new VoiceDialog({
      listRepositories: async () => (calls.push('listRepositories'), [{ repositoryId: 'shop', displayName: 'Shop', command: 'npm test' }]),
      startInvestigation: async () => (calls.push('startInvestigation'), job),
      getInvestigationResult: async () => {
        throw new Error('not expected');
      },
    });
    const refusals = [
      "don't investigate",
      'please do not start an investigation',
      'should I investigate?',
      'you should not investigate',
      "you mustn't investigate",
      "let's not investigate",
      "I'd prefer you didn't investigate",
      'investigate nothing',
      'no, investigate',
      'not now, investigate later',
    ];
    for (const utterance of refusals) {
      const turn = await dialog.respond(utterance);
      assert.deepEqual(turn.response, { kind: 'help', speech: SPEECH.help }, utterance);
      assert.equal(turn.state, INITIAL_DIALOG_STATE);
    }
    assert.deepEqual(calls, []);
    assert.equal((await dialog.respond('investigate the failing tests')).response.kind, 'started');
    assert.deepEqual(calls, ['listRepositories', 'startInvestigation']);
  });

  describe('card presentation', () => {
    // A stub client hands the dialog report text that the wrapper and the server would pass through unchanged.
    const job = { jobId: UNKNOWN_JOB, repositoryId: 'shop', status: 'completed', createdAt: '2026-10-08T00:00:00.000Z' } as const;
    const state: DialogState = { repositoryId: 'shop', jobId: UNKNOWN_JOB, investigationStarted: true };
    const claim = (kind: GroundedClaimKind, statement: string): GroundedClaim => ({ id: 'claim-1', kind, statement, evidenceIds: ['ev-1'], actionIds: [] });
    const SAFE_CLAIMS = [
      claim('observation', 'Baseline failure: test "applies tax" (test/checkout.test.ts), declared at line 20, failed on the original repository with `200 !== 180`.'),
      claim('observation', 'The proposed patch was applied, unmodified, in an isolated worktree.'),
      claim('verification', 'Verified: the previously failing test "applies tax" (test/checkout.test.ts) passed after the repair.'),
    ];
    const UNSAFE_CLAIMS: ReadonlyArray<readonly [detail: string, claim: GroundedClaim]> = [
      ['npm test', claim('observation', '`npm test` exited with code 1 and reported the failing test "applies tax".')],
      ['verification command', claim('verification', 'Repair verified against the configured verification command: it passed in the patched worktree.')],
      ['hyp-input-tax-subtotal-discounted', claim('finding', 'The evidence points at hyp-input-tax-subtotal-discounted.')],
      ['Supports H1', claim('finding', 'Supports H1: `tax` is computed from `subtotal`.')],
      ['awaiting_verification', claim('proposal', 'The proposed change is awaiting_verification.')],
      ['review status', claim('proposal', 'The planner proposed changing src/checkout.ts; review status: approved.')],
      ['/srv/devpilot/secret-repo', claim('observation', 'The repository at /srv/devpilot/secret-repo was checked.')],
      ['C:\\repos\\shop', claim('observation', 'The repository at C:\\repos\\shop was checked.')],
      ['~/repos/shop', claim('observation', 'The repository at ~/repos/shop was checked.')],
      ['http://127.0.0.1:8788/mcp', claim('observation', 'The result is at http://127.0.0.1:8788/mcp.')],
      ['https://example.com', claim('observation', 'See https://example.com for the logs.')],
      ['Bearer', claim('observation', `The request carried Bearer ${TOKEN}.`)],
      ['9f8e7d6c5b4a39281706f5e4d3c2b1a0', claim('observation', 'The run used key 9f8e7d6c5b4a39281706f5e4d3c2b1a0.')],
    ];
    const SAFE_LIMITATION = 'Verification shows that the tests which failed in the baseline run were reported passing after the patch.';
    const UNSAFE_LIMITATIONS = [
      'Verification covers only `npm test`; behaviour that command does not exercise is unverified.',
      'node --test does not report where a passing test is declared.',
      'The repair was not verified (verification_failed).',
    ];
    const SUMMARY = 'DevPilot reproduced "applies tax" in Shop and verified a patch in an isolated worktree. The patch was not applied to the repository.';
    const outcomeWith = (claims: readonly GroundedClaim[], overrides: Partial<InvestigationOutcome> = {}): InvestigationOutcome => ({
      investigationId: 'investigation-1',
      groundingValid: true,
      repairStatus: 'repaired',
      claims,
      baselineFailures: [{ testFile: 'test/checkout.test.ts', suite: [], testName: 'applies tax' }],
      affectedFiles: ['src/checkout.ts'],
      limitations: [...UNSAFE_LIMITATIONS.slice(0, 1), SAFE_LIMITATION, ...UNSAFE_LIMITATIONS.slice(1)],
      spokenSummary: SUMMARY,
      ...overrides,
    });
    const presented = (outcome: InvestigationOutcome) =>
      new VoiceDialog({
        listRepositories: async () => [],
        startInvestigation: async () => job,
        getInvestigationResult: async () => ({ job, outcome }),
      }).respond('what did you find?', state);
    const visible = (claims: readonly GroundedClaim[]) => claims.map((item) => ({ kind: item.kind, statement: item.statement }));

    for (const [detail, unsafe] of UNSAFE_CLAIMS) {
      it(`leaves a claim exposing ${detail} off the card`, async () => {
        const turn = await presented(outcomeWith([...SAFE_CLAIMS.slice(0, 1), unsafe, ...SAFE_CLAIMS.slice(1)]));
        assert.deepEqual(turn.response.card?.claims, visible(SAFE_CLAIMS));
        assert.ok(!JSON.stringify(turn.response).includes(JSON.stringify(detail).slice(1, -1)), `the response contains ${detail}`);
      });
    }

    it('shows safe claims and limitations exactly as the server wrote them, and adds nothing in place of the rest', async () => {
      const claims = [...UNSAFE_CLAIMS.map(([, unsafe]) => unsafe), ...SAFE_CLAIMS];
      const turn = await presented(outcomeWith(claims));
      assert.equal(turn.response.kind, 'verified');
      assert.deepEqual(turn.response.card, {
        jobStatus: 'completed',
        verified: true,
        repairStatus: 'repaired',
        claims: visible(SAFE_CLAIMS),
        baselineFailures: [{ testFile: 'test/checkout.test.ts', suite: [], testName: 'applies tax' }],
        affectedFiles: ['src/checkout.ts'],
        limitations: [SAFE_LIMITATION],
      });
      assertShownInOrder(turn.response.card?.claims ?? [], visible(claims), 'claims');
    });

    it('speaks a grounded repair\'s summary exactly, and an unverified one after the fixed sentence, whatever the card shows', async () => {
      const verified = await presented(outcomeWith([...UNSAFE_CLAIMS.map(([, unsafe]) => unsafe), ...SAFE_CLAIMS]));
      assert.equal(verified.response.speech, SUMMARY);
      const unverified = await presented(outcomeWith(SAFE_CLAIMS, { repairStatus: 'not_attempted', spokenSummary: 'DevPilot investigated Shop but did not verify a repair: no repair was attempted.' }));
      assert.equal(unverified.response.kind, 'not_verified');
      assert.equal(unverified.response.speech, `${SPEECH.notVerified} DevPilot investigated Shop but did not verify a repair: no repair was attempted.`);
      assert.deepEqual(unverified.response.card?.claims, visible(SAFE_CLAIMS));
    });

    it('an outcome whose claims are all internal is shown with an empty claim list', async () => {
      const turn = await presented(outcomeWith(UNSAFE_CLAIMS.map(([, unsafe]) => unsafe), { limitations: UNSAFE_LIMITATIONS }));
      assert.equal(turn.response.kind, 'verified');
      assert.deepEqual(turn.response.card?.claims, []);
      assert.deepEqual(turn.response.card?.limitations, []);
    });

    it('the complete response holds no root, URL, token, command, hypothesis ID, or review status', async () => {
      const turn = await presented(outcomeWith([...UNSAFE_CLAIMS.map(([, unsafe]) => unsafe), ...SAFE_CLAIMS]));
      const text = JSON.stringify(turn);
      for (const value of ['repositoryRoot', 'allowedRoot', '/srv/', 'http://', 'https://', '127.0.0.1', 'Bearer', TOKEN, 'npm', 'hyp-', 'awaiting_verification', 'review status']) {
        assert.ok(!text.includes(value), `the response contains ${value}`);
      }
    });
  });

  it('the server refusal texts the dialog recognises match the MCP server exactly', () => {
    assert.equal(SERVER_REFUSAL_TEXT.repositoryBusy, PUBLIC_ERROR_TEXT.repository_busy);
    assert.equal(SERVER_REFUSAL_TEXT.signalRequired, PUBLIC_ERROR_TEXT.signal_required);
    assert.equal(SERVER_REFUSAL_TEXT.unknownJob, PUBLIC_ERROR_TEXT.unknown_job);
  });

  it('no turn exposes the token, a path, a URL, the command, or raw error text', () => {
    const kinds = new Set<DialogKind>(dialogTurns.map((turn) => turn.response.kind));
    const everyKind: readonly DialogKind[] = [
      'help',
      'choose_repository',
      'no_repositories',
      'repository_not_registered',
      'started',
      'busy',
      'signal_required',
      'no_investigation',
      'in_progress',
      'verified',
      'not_verified',
      'failed',
      'investigation_unavailable',
      'error',
    ];
    for (const kind of everyKind) {
      assert.ok(kinds.has(kind), `no turn produced ${kind}`);
    }
    const forbidden = [
      TOKEN,
      'Bearer',
      'http://',
      '127.0.0.1',
      'McpClientError',
      'fetch failed',
      'ENOENT',
      'secret-repo',
      'repositoryRoot',
      'allowedRoot',
      ...INTERNAL_CLAIM_DETAIL,
      'patch_proposed',
      'patch_rejected',
      ...dialogHostPaths,
      ...Object.values(CLIENT_ERROR_TEXT),
      ...Object.values(PUBLIC_ERROR_TEXT),
    ];
    for (const turn of dialogTurns) {
      const text = JSON.stringify(turn);
      for (const value of forbidden) assert.ok(!text.includes(value), `a ${turn.response.kind} turn contains ${value}`);
      assert.doesNotMatch(text, /\/(Users|home|private|var|tmp|srv)\//, `a ${turn.response.kind} turn contains a host path`);
      assert.ok(!/\bnpm\b/.test(turn.response.speech), `a ${turn.response.kind} turn speaks the command`);
      assert.ok(!/\bnpm\b/.test(text), `a ${turn.response.kind} turn shows the command`);
      assert.ok(!('command' in (turn.response.card ?? {})) && !(turn.response.card?.repositories ?? []).some((choice) => 'command' in choice));
      assert.deepEqual(Object.keys(turn.state).sort(), ['investigationStarted', 'jobId', 'repositoryId']);
    }
  });
});

describe('source boundaries', () => {
  const ALLOWED = /^(node:[a-z/_]+|@modelcontextprotocol\/client|\.\/[a-z-]+\.js)$/;
  const FORBIDDEN =
    /@devpilot\/|packages\/|RepairWorkflow|InvestigationService|GroundedRepairPipeline|child_process|require\(|@modelcontextprotocol\/(server|node|sdk|core)|express|hono|aws-sdk|@aws|bedrock|alexa|console\./i;

  it('voice-demo source imports only @modelcontextprotocol/client and node built-ins', async () => {
    const files = (await readdir(path.join(DEMO_ROOT, 'src'), { recursive: true })).filter((file) => /\.[cm]?[jt]sx?$/.test(file));
    assert.deepEqual(files.sort(), ['dialog.ts', 'intents.ts', 'mcp-client.ts']);
    for (const file of files) {
      const source = await readFile(path.join(DEMO_ROOT, 'src', file), 'utf8');
      for (const specifier of importsOf(source)) assert.match(specifier, ALLOWED, `${file} imports ${specifier}`);
      assert.ok(!FORBIDDEN.test(source), `${file} references ${source.match(FORBIDDEN)?.[0]}`);
    }
    assert.deepEqual(importsOf(await readFile(path.join(DEMO_ROOT, 'src', 'mcp-client.ts'), 'utf8')), ['@modelcontextprotocol/client']);
  });

  it('the dialog reaches DevPilot only through the MCP client wrapper; the classifier imports nothing', async () => {
    assert.deepEqual(importsOf(await readFile(path.join(DEMO_ROOT, 'src', 'dialog.ts'), 'utf8')), ['./intents.js', './mcp-client.js']);
    assert.deepEqual(importsOf(await readFile(path.join(DEMO_ROOT, 'src', 'intents.ts'), 'utf8')), []);
  });

  function importsOf(source: string): string[] {
    return [...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');
  }

  it('the package depends on exactly @modelcontextprotocol/client 2.3.1', async () => {
    const manifest = JSON.parse(await readFile(path.join(DEMO_ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(manifest.name, '@devpilot/voice-demo');
    assert.deepEqual(manifest.dependencies, { '@modelcontextprotocol/client': '2.3.1' });
    for (const field of ['devDependencies', 'peerDependencies', 'optionalDependencies']) assert.equal(manifest[field], undefined, field);
  });
});
