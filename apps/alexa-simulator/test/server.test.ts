import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { startMcpHttpServer, type McpHttpServer } from '../../mcp/src/index.js';
import { InvestigationService, RepositoryRegistry, type SignalInput } from '../../../packages/service/src/index.js';
import { resolveGitExecutable, type GitExecutable } from '../../../packages/tools/src/index.js';
import { createGitRepositoryFixture, type GitRepositoryFixture } from '../../../packages/tools/test/support/git-repository.js';
import { INITIAL_DIALOG_STATE, SPEECH, VoiceDialog, type DialogClient, type DialogState } from '../../voice-demo/src/dialog.js';
import { MAX_UTTERANCE_LENGTH } from '../../voice-demo/src/intents.js';
import { DevPilotMcpClient, McpClientError, type InvestigationOutcome, type InvestigationResult, type JobView } from '../../voice-demo/src/mcp-client.js';
import { buildAssets, type StaticAssets } from '../src/server/assets.js';
import { configFromEnvironment, DEFAULT_MCP_URL, DEFAULT_PORT, SimulatorConfigurationError } from '../src/server/config.js';
import { PUBLIC_ERROR_TEXT, startSimulatorServer, type SimulatorServer, type SimulatorServerOptions } from '../src/server/http.js';
import { MAX_BODY_BYTES } from '../src/server/request.js';
import { describeError, startSimulator, type Simulator } from '../src/server/simulator.js';
import { Conversation, httpTransport, type Message } from '../src/web/conversation.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_SOURCE = path.resolve(HERE, '../src/web');

const TOKEN = 'simulator-test-token-0123456789abcdef';
const FAKE_ASSETS: StaticAssets = { html: '<!doctype html><title>DevPilot</title>', script: 'export {};', styles: 'body{}' };
const JOB_ID = 'job-00000000-0000-4000-8000-000000000001';

/** What a malicious or careless MCP result may carry; none of it may reach the browser. */
const FORBIDDEN = ['npm test', 'hyp-001', 'ev-001', 'action-001', '/Users/example/project', 'verification command', 'awaiting_verification', 'Bearer secret-token'];

interface HttpReply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly text: string;
}

/** A raw HTTP request, so Host, Origin, and the body can be anything. */
function send(url: URL, init: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: url.hostname, port: url.port, method: init.method ?? 'GET', path: init.path ?? '/', headers: init.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(init.body);
  });
}

function postDialog(url: URL, body: unknown, headers: Record<string, string> = {}): Promise<HttpReply> {
  return send(url, {
    method: 'POST',
    path: '/api/dialog',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function assertGenericError(reply: HttpReply, status: number): void {
  assert.equal(reply.status, status, reply.text);
  assert.deepEqual(JSON.parse(reply.text), { error: PUBLIC_ERROR_TEXT });
}

function assertExcludes(text: string, forbidden: readonly string[], label: string): void {
  for (const value of forbidden) assert.ok(!text.includes(value), `${label} contains ${JSON.stringify(value)}`);
}

/** A dialog that counts its calls, so rejected requests can be shown never to reach it. */
function countingDialog(inner: Pick<VoiceDialog, 'respond'>): Pick<VoiceDialog, 'respond'> & { calls: number } {
  const counter = {
    calls: 0,
    respond: (utterance: string, state?: DialogState) => {
      counter.calls += 1;
      return inner.respond(utterance, state);
    },
  };
  return counter;
}

async function withServer(options: Partial<SimulatorServerOptions>, run: (server: SimulatorServer) => Promise<void>): Promise<void> {
  const server = await startSimulatorServer({
    dialog: new VoiceDialog(maliciousClient()),
    available: async () => true,
    assets: FAKE_ASSETS,
    port: 0,
    ...options,
  });
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

const SAFE_CLAIM = 'The proposed patch was applied, unmodified, in an isolated worktree.';
const SAFE_LIMITATION = 'Verification shows that the tests which failed in the baseline run were reported passing after the patch.';
const SAFE_SUMMARY = 'DevPilot reproduced the failing test in Shop and verified a patch in an isolated worktree.';

function maliciousOutcome(overrides: Partial<InvestigationOutcome> = {}): InvestigationOutcome {
  return {
    investigationId: 'hyp-001',
    groundingValid: true,
    repairStatus: 'repaired',
    claims: [
      { id: 'hyp-001', kind: 'observation', statement: '`npm test` exited with code 1 at /Users/example/project.', evidenceIds: ['ev-001'], actionIds: ['action-001'] },
      { id: 'claim-1', kind: 'finding', statement: 'Supports hyp-001: the evidence ev-001 points at it.', evidenceIds: ['ev-001'], actionIds: [] },
      { id: 'claim-2', kind: 'proposal', statement: 'The proposed change is awaiting_verification.', evidenceIds: ['ev-001'], actionIds: ['action-001'] },
      { id: 'claim-3', kind: 'verification', statement: 'Repair verified against the configured verification command.', evidenceIds: ['ev-001'], actionIds: [] },
      { id: 'claim-4', kind: 'observation', statement: 'The request carried Bearer secret-token.', evidenceIds: ['ev-001'], actionIds: [] },
      { id: 'claim-5', kind: 'observation', statement: SAFE_CLAIM, evidenceIds: ['ev-001'], actionIds: ['action-001'], quote: 'npm test passed for hyp-001 at /Users/example/project' },
    ],
    baselineFailures: [{ testFile: 'test/cart.test.ts', suite: [], testName: 'applies the discount once' }],
    affectedFiles: ['src/cart.ts'],
    limitations: ['Verification covers only `npm test`.', 'Ran in /Users/example/project with Bearer secret-token.', SAFE_LIMITATION],
    spokenSummary: SAFE_SUMMARY,
    ...overrides,
  };
}

/**
 * A stand-in for the MCP client returning a hostile result: every forbidden
 * value is placed where the real server's result can carry text.
 */
function maliciousClient(overrides: { outcome?: InvestigationOutcome; job?: Partial<JobView>; repositories?: number } = {}): DialogClient {
  const repositories = [
    { repositoryId: 'shop', displayName: 'Shop', command: 'npm test' },
    { repositoryId: 'cart', displayName: 'Cart', command: 'npm test --prefix /Users/example/project' },
  ].slice(0, overrides.repositories ?? 1);
  const job: JobView = { jobId: JOB_ID, repositoryId: 'shop', status: 'queued', createdAt: '2026-10-08T00:00:00.000Z', ...overrides.job };
  return {
    listRepositories: async () => repositories,
    startInvestigation: async () => job,
    getInvestigationResult: async (): Promise<InvestigationResult> => ({
      job: { ...job, status: 'completed', finishedAt: '2026-10-08T00:01:00.000Z', failureReason: 'npm test failed at /Users/example/project (Bearer secret-token)', ...overrides.job },
      outcome: overrides.outcome ?? maliciousOutcome(),
    }),
  };
}

const ACTIVE: DialogState = { repositoryId: 'shop', jobId: JOB_ID, investigationStarted: true };

describe('POST /api/dialog', () => {
  it('answers through VoiceDialog with exactly { response, state }', async () => {
    const dialog = countingDialog(new VoiceDialog(maliciousClient()));
    await withServer({ dialog }, async (server) => {
      const reply = await postDialog(server.url, { utterance: 'investigate the failing tests', state: INITIAL_DIALOG_STATE });
      assert.equal(reply.status, 200, reply.text);
      assert.match(String(reply.headers['content-type']), /^application\/json/);
      const body = JSON.parse(reply.text) as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), ['response', 'state']);
      assert.deepEqual(body, {
        response: { kind: 'started', speech: SPEECH.started('Shop'), jobId: JOB_ID, card: { repository: { repositoryId: 'shop', displayName: 'Shop' }, jobStatus: 'queued' } },
        state: ACTIVE,
      });
      assert.equal(dialog.calls, 1);
    });
  });

  it('a hostile MCP result passed through the existing VoiceDialog leaves nothing forbidden in the HTTP body', async () => {
    await withServer({ dialog: new VoiceDialog(maliciousClient()) }, async (server) => {
      const started = await postDialog(server.url, { utterance: 'investigate the failing tests', state: INITIAL_DIALOG_STATE });
      const result = await postDialog(server.url, { utterance: 'what did you find?', state: ACTIVE });
      for (const reply of [started, result]) {
        assert.equal(reply.status, 200);
        assertExcludes(reply.text, FORBIDDEN, 'the HTTP body');
        assertExcludes(reply.text, ['structuredContent', 'evidenceIds', 'actionIds', 'investigationId', 'failureReason', 'command', 'quote'], 'the HTTP body');
      }
      const body = JSON.parse(result.text);
      assert.equal(body.response.kind, 'verified');
      assert.equal(body.response.speech, SAFE_SUMMARY);
      assert.deepEqual(body.response.card.claims, [{ kind: 'observation', statement: SAFE_CLAIM }]);
      assert.deepEqual(body.response.card.limitations, [SAFE_LIMITATION]);
    });
  });

  it('a failed job\'s hostile failure reason is not in the HTTP body', async () => {
    await withServer({ dialog: new VoiceDialog(maliciousClient({ job: { status: 'failed' } })) }, async (server) => {
      const reply = await postDialog(server.url, { utterance: 'what did you find?', state: ACTIVE });
      assertExcludes(reply.text, FORBIDDEN, 'the HTTP body');
      assert.deepEqual(JSON.parse(reply.text).response, { kind: 'failed', speech: SPEECH.failed, jobId: JOB_ID, card: { jobStatus: 'failed', verified: false } });
    });
  });

  it('passes the dialog\'s verified response, card, and next state through unchanged', async () => {
    const direct = await new VoiceDialog(maliciousClient()).respond('what did you find?', ACTIVE);
    await withServer({ dialog: new VoiceDialog(maliciousClient()) }, async (server) => {
      const reply = await postDialog(server.url, { utterance: 'what did you find?', state: ACTIVE });
      assert.deepEqual(JSON.parse(reply.text), JSON.parse(JSON.stringify({ response: direct.response, state: direct.state })));
      assert.equal(direct.response.kind, 'verified');
    });
  });

  it('passes a not-verified card through unchanged', async () => {
    const client = () => maliciousClient({ outcome: maliciousOutcome({ repairStatus: 'not_attempted' }) });
    const direct = await new VoiceDialog(client()).respond('what did you find?', ACTIVE);
    assert.equal(direct.response.kind, 'not_verified');
    await withServer({ dialog: new VoiceDialog(client()) }, async (server) => {
      const reply = await postDialog(server.url, { utterance: 'what did you find?', state: ACTIVE });
      assert.deepEqual(JSON.parse(reply.text), JSON.parse(JSON.stringify({ response: direct.response, state: direct.state })));
    });
  });

  it('passes repository choices through unchanged, without the verification command', async () => {
    await withServer({ dialog: new VoiceDialog(maliciousClient({ repositories: 2 })) }, async (server) => {
      const reply = await postDialog(server.url, { utterance: 'investigate the failing tests', state: INITIAL_DIALOG_STATE });
      assert.deepEqual(JSON.parse(reply.text), {
        response: {
          kind: 'choose_repository',
          speech: SPEECH.chooseRepository(['Shop', 'Cart']),
          card: { repositories: [{ repositoryId: 'shop', displayName: 'Shop' }, { repositoryId: 'cart', displayName: 'Cart' }] },
        },
        state: { investigationStarted: false },
      });
      assertExcludes(reply.text, FORBIDDEN, 'the HTTP body');
    });
  });

  it('an MCP client error becomes the dialog\'s generic speech, with no detail', async () => {
    const failing: DialogClient = {
      listRepositories: async () => {
        throw new McpClientError('unavailable', new Error(`connect ECONNREFUSED ${DEFAULT_MCP_URL} Bearer ${TOKEN}`));
      },
      startInvestigation: async () => assert.fail('not expected'),
      getInvestigationResult: async () => {
        throw new Error(`HTTP 500 from ${DEFAULT_MCP_URL}: ${TOKEN}\n    at Object.<anonymous> (/Users/example/project/server.js:1:1)`);
      },
    };
    await withServer({ dialog: new VoiceDialog(failing) }, async (server) => {
      for (const utterance of ['investigate the failing tests', 'what did you find?']) {
        const reply = await postDialog(server.url, { utterance, state: ACTIVE });
        assert.equal(reply.status, 200);
        assert.deepEqual(JSON.parse(reply.text), { response: { kind: 'error', speech: SPEECH.error, jobId: JOB_ID }, state: ACTIVE });
        assertExcludes(reply.text, [TOKEN, DEFAULT_MCP_URL, '127.0.0.1', 'ECONNREFUSED', 'HTTP 500', ' at ', '/Users/'], 'the HTTP body');
      }
    });
  });

  it('an exception from the dialog becomes a generic 500 with no message or stack, reported server-side only', async () => {
    const reported: unknown[] = [];
    const secret = new Error(`Bearer ${TOKEN} from ${DEFAULT_MCP_URL} DEVPILOT_MCP_TOKEN`);
    const dialog = { respond: async () => Promise.reject(secret) };
    await withServer({ dialog, onError: (error) => reported.push(error) }, async (server) => {
      const reply = await postDialog(server.url, { utterance: 'what did you find?', state: ACTIVE });
      assertGenericError(reply, 500);
      assertExcludes(reply.text, [TOKEN, DEFAULT_MCP_URL, 'DEVPILOT_MCP', 'Error', ' at ', String(secret.stack)], 'the HTTP body');
    });
    assert.deepEqual(reported, [secret]);
  });

  it('a throwing error reporter does not change the generic response', async () => {
    const dialog = { respond: async () => Promise.reject(new Error('boom')) };
    await withServer({ dialog, onError: () => assert.fail('reporter failed') }, async (server) => {
      assertGenericError(await postDialog(server.url, { utterance: 'hi', state: INITIAL_DIALOG_STATE }), 500);
    });
  });

  describe('rejects, before reaching the dialog,', () => {
    const valid = { utterance: 'what did you find?', state: ACTIVE };
    const cases: ReadonlyArray<readonly [label: string, body: unknown]> = [
      ['malformed JSON', '{"utterance": '],
      ['a JSON array', '[]'],
      ['null', 'null'],
      ['a missing utterance', { state: ACTIVE }],
      ['a missing state', { utterance: 'hi' }],
      ['an extra top-level field', { ...valid, token: TOKEN }],
      ['MCP configuration alongside the request', { ...valid, mcpUrl: DEFAULT_MCP_URL }],
      ['a non-string utterance', { ...valid, utterance: 42 }],
      ['a blank utterance', { ...valid, utterance: '   ' }],
      ['an oversized utterance', { ...valid, utterance: 'a'.repeat(MAX_UTTERANCE_LENGTH + 1) }],
      ['a null state', { ...valid, state: null }],
      ['an array state', { ...valid, state: [] }],
      ['a string state', { ...valid, state: 'shop' }],
      ['a state without investigationStarted', { ...valid, state: { repositoryId: 'shop', jobId: JOB_ID } }],
      ['a non-boolean investigationStarted', { ...valid, state: { ...ACTIVE, investigationStarted: 'true' } }],
      ['an unknown state field', { ...valid, state: { ...ACTIVE, extra: 1 } }],
      ['a token in the state', { ...valid, state: { ...ACTIVE, token: TOKEN } }],
      ['a command in the state', { ...valid, state: { ...ACTIVE, command: 'npm test' } }],
      ['a path in the state', { ...valid, state: { ...ACTIVE, repositoryRoot: '/Users/example/project' } }],
      ['MCP config in the state', { ...valid, state: { ...ACTIVE, mcpConfig: { url: DEFAULT_MCP_URL } } }],
      ['planner config in the state', { ...valid, state: { ...ACTIVE, planner: { kind: 'bedrock' } } }],
      ['evidence in the state', { ...valid, state: { ...ACTIVE, evidence: [{ id: 'ev-001' }] } }],
      ['hypotheses in the state', { ...valid, state: { ...ACTIVE, hypotheses: ['hyp-001'] } }],
      ['a __proto__ key in the state', `{"utterance":"hi","state":{"investigationStarted":false,"__proto__":{"jobId":"x"}}}`],
      ['an object repository ID', { ...valid, state: { ...ACTIVE, repositoryId: { id: 'shop' } } }],
      ['a path as the repository ID', { ...valid, state: { ...ACTIVE, repositoryId: '../etc' } }],
      ['an oversized repository ID', { ...valid, state: { ...ACTIVE, repositoryId: 'a'.repeat(65) } }],
      ['an object job ID', { ...valid, state: { ...ACTIVE, jobId: { id: JOB_ID } } }],
      ['a job ID with a path', { ...valid, state: { ...ACTIVE, jobId: '../job' } }],
      ['an oversized job ID', { ...valid, state: { ...ACTIVE, jobId: `job-${'a'.repeat(200)}` } }],
      ['a null job ID', { ...valid, state: { ...ACTIVE, jobId: null } }],
    ];
    for (const [label, body] of cases) {
      it(label, async () => {
        const dialog = countingDialog(new VoiceDialog(maliciousClient()));
        await withServer({ dialog }, async (server) => {
          assertGenericError(await postDialog(server.url, body), 400);
          assert.equal(dialog.calls, 0);
        });
      });
    }

    it('a body over the size limit, by Content-Length or by streaming', async () => {
      const dialog = countingDialog(new VoiceDialog(maliciousClient()));
      await withServer({ dialog }, async (server) => {
        const oversized = JSON.stringify({ utterance: 'hi', state: INITIAL_DIALOG_STATE, padding: 'x'.repeat(MAX_BODY_BYTES) });
        assertGenericError(await postDialog(server.url, oversized), 413);
        assertGenericError(await postDialog(server.url, oversized, { 'transfer-encoding': 'chunked' }), 413);
        assert.equal(dialog.calls, 0);
      });
    });

    it('a non-JSON content type', async () => {
      const dialog = countingDialog(new VoiceDialog(maliciousClient()));
      await withServer({ dialog }, async (server) => {
        for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonx']) {
          assertGenericError(await postDialog(server.url, valid, { 'content-type': contentType }), 415);
        }
        assert.equal(dialog.calls, 0);
      });
    });

    it('a cross-origin request', async () => {
      const dialog = countingDialog(new VoiceDialog(maliciousClient()));
      await withServer({ dialog }, async (server) => {
        for (const origin of ['http://evil.example', `https://${server.url.host}`, 'null', `http://${server.url.hostname}:1`]) {
          assertGenericError(await postDialog(server.url, valid, { origin }), 403);
        }
        assert.equal(dialog.calls, 0);
        assert.equal((await postDialog(server.url, valid, { origin: `http://${server.url.host}` })).status, 200);
        assert.equal(dialog.calls, 1);
      });
    });
  });
});

describe('simulator HTTP surface', () => {
  it('rejects unsupported paths, including anything that looks like an MCP or file route', async () => {
    await withServer({}, async (server) => {
      for (const target of ['/mcp', '/api', '/api/dialog/', '/api/mcp', '/index.html', '/app.js.map', '/src/web/main.tsx', '/../package.json', '/.env', '/constructor', '/__proto__', '/hasOwnProperty']) {
        assertGenericError(await send(server.url, { path: target }), 404);
      }
      assertGenericError(await send(server.url, { method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' }), 404);
    });
  });

  it('rejects unsupported methods', async () => {
    await withServer({}, async (server) => {
      for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
        const reply = await send(server.url, { method, path: '/api/dialog' });
        assertGenericError(reply, 405);
        assert.equal(reply.headers.allow, 'POST');
        assert.equal(reply.headers['access-control-allow-origin'], undefined);
      }
      for (const target of ['/', '/app.js', '/app.css', '/api/status']) {
        const reply = await send(server.url, { method: 'POST', path: target, headers: { 'content-type': 'application/json' }, body: '{}' });
        assertGenericError(reply, 405);
        assert.equal(reply.headers.allow, 'GET');
      }
    });
  });

  it('rejects a foreign Host header (DNS rebinding)', async () => {
    await withServer({}, async (server) => {
      for (const host of ['evil.example', `evil.example:${server.url.port}`, `127.0.0.1:${Number(server.url.port) + 1}`]) {
        assertGenericError(await send(server.url, { path: '/', headers: { host } }), 403);
        assertGenericError(await postDialog(server.url, { utterance: 'hi', state: INITIAL_DIALOG_STATE }, { host }), 403);
      }
      assert.equal((await send(server.url, { path: '/', headers: { host: `localhost:${server.url.port}` } })).status, 200);
    });
  });

  it('serves the page with a strict content security policy and security headers on every response', async () => {
    await withServer({}, async (server) => {
      const page = await send(server.url, { path: '/' });
      assert.equal(page.status, 200);
      assert.equal(page.text, FAKE_ASSETS.html);
      assert.match(String(page.headers['content-security-policy']), /default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'/);
      for (const reply of [page, await send(server.url, { path: '/app.js' }), await send(server.url, { path: '/nope' })]) {
        assert.equal(reply.headers['x-content-type-options'], 'nosniff');
        assert.equal(reply.headers['x-frame-options'], 'DENY');
        assert.equal(reply.headers['cache-control'], 'no-store');
        assert.equal(reply.headers['access-control-allow-origin'], undefined);
      }
    });
  });

  it('reports DevPilot as connected or unavailable, and nothing else', async () => {
    let up = true;
    await withServer({ available: async () => up }, async (server) => {
      assert.deepEqual(JSON.parse((await send(server.url, { path: '/api/status' })).text), { status: 'connected' });
      up = false;
      assert.deepEqual(JSON.parse((await send(server.url, { path: '/api/status' })).text), { status: 'unavailable' });
    });
  });

  it('reports a failing connectivity check as unavailable, with the error kept server-side', async () => {
    const reported: unknown[] = [];
    const failure = new Error(`SdkError: connect ECONNREFUSED ${DEFAULT_MCP_URL} Bearer ${TOKEN}`);
    await withServer({ available: () => Promise.reject(failure), onError: (error) => reported.push(error) }, async (server) => {
      const reply = await send(server.url, { path: '/api/status' });
      assert.equal(reply.status, 200);
      assert.equal(reply.text, '{"status":"unavailable"}');
    });
    assert.deepEqual(reported, [failure]);
  });

  it('listens on loopback only', async () => {
    await withServer({}, async (server) => {
      assert.equal(server.url.hostname, '127.0.0.1');
    });
  });
});

describe('simulator configuration', () => {
  it('requires the token and never echoes configuration values', () => {
    assert.throws(() => configFromEnvironment({}), (error: unknown) => error instanceof SimulatorConfigurationError && error.message === 'DEVPILOT_MCP_TOKEN is required');
    assert.throws(
      () => configFromEnvironment({ DEVPILOT_MCP_TOKEN: TOKEN, DEVPILOT_SIMULATOR_PORT: 'Bearer-secret' }),
      (error: unknown) => error instanceof SimulatorConfigurationError && !error.message.includes('Bearer-secret') && !error.message.includes(TOKEN),
    );
    assert.deepEqual(configFromEnvironment({ DEVPILOT_MCP_TOKEN: TOKEN }), { mcpUrl: DEFAULT_MCP_URL, mcpToken: TOKEN, port: DEFAULT_PORT, dialog: {} });
    assert.deepEqual(configFromEnvironment({ DEVPILOT_MCP_TOKEN: TOKEN, DEVPILOT_DEMO_REPOSITORY_ID: ' shop ', DEVPILOT_SIMULATOR_PORT: '0' }).dialog, { repositoryId: 'shop' });
  });

  it('describes errors for the log without their underlying text', () => {
    assert.equal(describeError(new Error(`Bearer ${TOKEN} at ${DEFAULT_MCP_URL}`)), 'Error');
    assert.equal(describeError(new TypeError(TOKEN)), 'TypeError');
    assert.equal(describeError(TOKEN), 'unknown error');
    const clientError = new McpClientError('tool_error', { detail: `Bearer ${TOKEN}` });
    assert.equal(describeError(clientError), `McpClientError: ${clientError.message}`);
    assert.ok(!describeError(clientError).includes(TOKEN));
  });
});

describe('browser code boundary', () => {
  let assets: StaticAssets;
  let sources: Map<string, string>;

  before(async () => {
    assets = await buildAssets();
    sources = new Map();
    for (const name of await readdir(WEB_SOURCE)) sources.set(name, await readFile(path.join(WEB_SOURCE, name), 'utf8'));
  });

  it('builds a bundle that contains no MCP client, credentials, or server configuration', () => {
    assert.ok(assets.script.length > 1000, 'the bundle was built');
    assertExcludes(assets.script, ['@modelcontextprotocol', 'tools/call', 'tools/list', 'jsonrpc', 'Authorization', 'authorization', 'Bearer', 'DEVPILOT_', 'process.env', '/mcp', '8788', DEFAULT_MCP_URL, 'npm test'], 'the browser bundle');
    assert.match(assets.script, /\/api\/dialog/);
  });

  it('browser sources import only React, react-dom, local files, and voice-demo types and limits', () => {
    for (const [name, text] of sources) {
      if (!/\.(ts|tsx)$/.test(name)) continue;
      const specifiers = [...text.matchAll(/^import\s+(type\s+)?[^'"]*from\s+'([^']+)'/gm)].map((match) => ({ typeOnly: match[1] !== undefined, from: match[2] ?? '' }));
      for (const { typeOnly, from } of specifiers) {
        const allowed =
          from === 'react' ||
          from === 'react-dom/client' ||
          /^\.\/[a-zA-Z]+\.js$/.test(from) ||
          (typeOnly && from === '../../../voice-demo/src/dialog.js') ||
          from === '../../../voice-demo/src/intents.js';
        assert.ok(allowed, `${name} imports ${typeOnly ? 'type ' : ''}${from}`);
      }
      assertExcludes(text, ['@modelcontextprotocol', 'mcp-client', 'DEVPILOT_MCP', 'MCP_TOKEN', 'import.meta.env', 'VITE_', 'Authorization', 'tools/call', 'import(', 'require('], name);
    }
  });

  it('serves the built bundle as /app.js', async () => {
    await withServer({ assets }, async (server) => {
      const script = await send(server.url, { path: '/app.js' });
      assert.equal(script.status, 200);
      assert.match(String(script.headers['content-type']), /^text\/javascript/);
      assert.equal(script.text, assets.script);
      assert.match((await send(server.url, { path: '/' })).text, /<script type="module" src="\/app\.js"><\/script>/);
    });
  });
});

const FAILURE: SignalInput = {
  kind: 'failing_test',
  title: 'Total is too high when a code is applied',
  content: ['not ok 2 - applies tax to the discounted amount', '  error: |-', '    Expected values to be strictly equal:', '    200 !== 180'].join('\n'),
};

describe('simulator against the real DevPilot MCP server', () => {
  let executable: GitExecutable;
  let shop: GitRepositoryFixture;
  let mcp: McpHttpServer;
  let simulator: Simulator;
  let raw: DevPilotMcpClient;
  const reported: unknown[] = [];
  /** Every HTTP body the browser received from the simulator. */
  const bodies: string[] = [];
  /** Every URL the page's transport requested. */
  const requested: URL[] = [];

  before(async () => {
    executable = await resolveGitExecutable();
    shop = await createGitRepositoryFixture(executable);
    const registry = new RepositoryRegistry();
    registry.register({ repositoryId: 'shop', displayName: 'Shop', repositoryRoot: shop.root, allowedRoot: shop.allowedRoot, verification: { command: 'npm', args: ['test'] }, defaultSignal: FAILURE });
    registry.register({ repositoryId: 'quiet', displayName: 'Quiet', repositoryRoot: path.join(tmpdir(), 'devpilot-simulator-unused', 'quiet'), verification: { command: 'npm', args: ['test'] } });
    mcp = await startMcpHttpServer({ service: new InvestigationService({ registry, git: executable }), port: 0, token: TOKEN });
    simulator = await startSimulator({ mcpUrl: mcp.url.href, mcpToken: TOKEN, port: 0, dialog: {} }, { assets: FAKE_ASSETS, onError: (error) => reported.push(error) });
    raw = await DevPilotMcpClient.connect({ url: mcp.url, token: TOKEN });
  });

  after(async () => {
    await raw?.close();
    await simulator?.close();
    await mcp?.close();
    await shop?.cleanup();
  });

  /** The page's own transport and controller, pointed at the simulator; every body is recorded. */
  function browser(): Conversation {
    return new Conversation(
      httpTransport(async (input, init) => {
        const url = new URL(String(input), simulator.url);
        requested.push(url);
        const res = await fetch(url, init);
        bodies.push(await res.clone().text());
        return res;
      }),
    );
  }

  function lastAssistant(conversation: Conversation): Extract<Message, { role: 'assistant' }> {
    const last = conversation.getSnapshot().messages.at(-1);
    assert.ok(last && last.role === 'assistant', 'the last message is the assistant\'s');
    return last;
  }

  it('reports the MCP server as connected', async () => {
    assert.equal(await simulator.available(), true);
    const reply = await send(simulator.url, { path: '/api/status' });
    assert.equal(reply.status, 200);
    assert.equal(reply.text, '{"status":"connected"}');
    const conversation = browser();
    await conversation.refreshConnection();
    assert.equal(conversation.getSnapshot().connection, 'connected');
  });

  it('choose, start, and read a verified result entirely through /api/dialog, with no raw MCP result reaching the browser', { timeout: 180_000 }, async () => {
    const conversation = browser();
    await conversation.send('investigate the failing tests');
    const choice = lastAssistant(conversation);
    assert.equal(choice.kind, 'choose_repository');
    assert.deepEqual(choice.card?.repositories, [
      { repositoryId: 'shop', displayName: 'Shop' },
      { repositoryId: 'quiet', displayName: 'Quiet' },
    ]);

    await conversation.chooseRepository({ repositoryId: 'shop', displayName: 'Shop' });
    assert.equal(lastAssistant(conversation).kind, 'started');
    const { state } = conversation.getSnapshot();
    assert.equal(state.repositoryId, 'shop');
    assert.match(state.jobId ?? '', /^job-/);
    assert.equal(conversation.getSnapshot().jobActive, true);

    const deadline = Date.now() + 150_000;
    while (lastAssistant(conversation).kind !== 'verified') {
      assert.ok(['started', 'in_progress'].includes(lastAssistant(conversation).kind ?? ''), lastAssistant(conversation).kind);
      assert.ok(Date.now() < deadline, 'the investigation did not finish in time');
      await new Promise((resolve) => setTimeout(resolve, 200));
      await conversation.checkResult();
    }
    const verified = lastAssistant(conversation);
    assert.equal(conversation.getSnapshot().jobActive, false);

    // The raw MCP result, fetched separately, carries internal detail the browser must not see.
    const rawResult = await raw.getInvestigationResult(state.jobId ?? '');
    const rawRepositories = await raw.listRepositories();
    assert.ok(rawResult.outcome);
    const rawText = JSON.stringify([rawResult, rawRepositories]);
    for (const detail of ['npm test', 'hyp-', 'awaiting_verification']) assert.ok(rawText.includes(detail), `the raw result no longer mentions ${detail}`);
    assert.equal(verified.text, rawResult.outcome.spokenSummary);
    assert.equal(verified.card?.verified, true);

    const internalIds = rawResult.outcome.claims.flatMap((claim) => [claim.id, ...claim.evidenceIds, ...claim.actionIds]);
    const hostPaths = [shop.base, shop.root, shop.canonicalRoot, shop.allowedRoot];
    assert.ok(bodies.length >= 3);
    for (const body of bodies) {
      assertExcludes(body, [TOKEN, mcp.url.href, `:${mcp.url.port}`, 'npm test', 'hyp-', 'awaiting_verification', 'structuredContent', 'jsonrpc', 'evidenceIds', 'actionIds', ...internalIds, ...hostPaths], 'an HTTP body');
      assert.doesNotMatch(body, /\/(Users|home|private|var|tmp)\//);
    }
    assert.deepEqual(reported, []);
    assert.equal((await send(simulator.url, { path: '/api/status' })).text, '{"status":"connected"}', 'still available after the investigation');
  });

  it('the page requested only the simulator\'s own /api/dialog and /api/status', () => {
    assert.ok(requested.length > 0);
    for (const url of requested) {
      assert.equal(url.origin, simulator.url.origin, `${url.href} is not the simulator`);
      assert.ok(['/api/dialog', '/api/status'].includes(url.pathname), `the page requested ${url.pathname}`);
    }
    assert.deepEqual([...new Set(requested.map((url) => url.pathname))].sort(), ['/api/dialog', '/api/status']);
  });

  it('when the MCP server is down, the browser hears the generic error and sees Unavailable, with no detail', async () => {
    const closedMcp = await startMcpHttpServer({ service: new InvestigationService({ registry: new RepositoryRegistry(), git: executable }), port: 0, token: TOKEN });
    await closedMcp.close();
    const down = await startSimulator({ mcpUrl: closedMcp.url.href, mcpToken: TOKEN, port: 0, dialog: {} }, { assets: FAKE_ASSETS });
    try {
      const seen: string[] = [];
      const conversation = new Conversation(
        httpTransport(async (input, init) => {
          const res = await fetch(new URL(String(input), down.url), init);
          seen.push(await res.clone().text());
          return res;
        }),
      );
      await conversation.send('investigate the failing tests');
      assert.equal(lastAssistant(conversation).text, SPEECH.error);
      await conversation.refreshConnection();
      assert.equal(conversation.getSnapshot().connection, 'unavailable');
      for (const body of seen) assertExcludes(body, [TOKEN, closedMcp.url.href, closedMcp.url.port, 'ECONNREFUSED', 'McpClientError'], 'an HTTP body');
    } finally {
      await down.close();
    }
  });
});

describe('GET /api/status checks the real MCP server through the simulator\'s one client', () => {
  const WRONG_TOKEN = 'wrong-simulator-token-0123456789abcdef';

  function emptyService(): InvestigationService {
    const registry = new RepositoryRegistry();
    registry.register({ repositoryId: 'shop', displayName: 'Shop', repositoryRoot: path.join(tmpdir(), 'devpilot-simulator-unused', 'shop'), verification: { command: 'npm', args: ['test'] } });
    return new InvestigationService({ registry });
  }

  /** The exact tiny body, and none of the MCP server's details or the client's underlying errors. */
  function assertStatusBody(reply: HttpReply, status: 'connected' | 'unavailable', mcpUrl: URL, reported: readonly unknown[]): void {
    assert.equal(reply.status, 200);
    assert.equal(reply.text, JSON.stringify({ status }));
    const underlying = reported.flatMap((error) => (error instanceof Error ? [error.name, error.message] : [String(error)])).filter((text) => text.length > 0);
    assertExcludes(reply.text, [mcpUrl.href, mcpUrl.host, `:${mcpUrl.port}`, '127.0.0.1', 'localhost', TOKEN, WRONG_TOKEN, 'Bearer', 'SdkError', 'Error', 'ECONNREFUSED', 'DEVPILOT_', '/Users/', ...underlying], 'the status body');
  }

  it('is connected while the MCP server answers, and unavailable once it stops, though the simulator keeps running', async () => {
    const reported: unknown[] = [];
    const mcp = await startMcpHttpServer({ service: emptyService(), port: 0, token: TOKEN });
    const simulator = await startSimulator({ mcpUrl: mcp.url.href, mcpToken: TOKEN, port: 0, dialog: {} }, { assets: FAKE_ASSETS, onError: (error) => reported.push(error) });
    try {
      assertStatusBody(await send(simulator.url, { path: '/api/status' }), 'connected', mcp.url, reported);
      await mcp.close();
      assertStatusBody(await send(simulator.url, { path: '/api/status' }), 'unavailable', mcp.url, reported);
      assert.ok(reported.length > 0, 'the underlying connection error was reported server-side');
      assert.equal((await send(simulator.url, { path: '/' })).status, 200, 'the simulator itself is still up');
    } finally {
      await simulator.close();
      await mcp.close();
    }
  });

  it('is unavailable when the MCP server refuses the simulator\'s token', async () => {
    const reported: unknown[] = [];
    const mcp = await startMcpHttpServer({ service: emptyService(), port: 0, token: TOKEN });
    const simulator = await startSimulator({ mcpUrl: mcp.url.href, mcpToken: WRONG_TOKEN, port: 0, dialog: {} }, { assets: FAKE_ASSETS, onError: (error) => reported.push(error) });
    try {
      assertStatusBody(await send(simulator.url, { path: '/api/status' }), 'unavailable', mcp.url, reported);
    } finally {
      await simulator.close();
      await mcp.close();
    }
  });

  it('is unavailable when no MCP server was ever reachable', async () => {
    const reported: unknown[] = [];
    const gone = await startMcpHttpServer({ service: emptyService(), port: 0, token: TOKEN });
    await gone.close();
    const simulator = await startSimulator({ mcpUrl: gone.url.href, mcpToken: TOKEN, port: 0, dialog: {} }, { assets: FAKE_ASSETS, onError: (error) => reported.push(error) });
    try {
      assertStatusBody(await send(simulator.url, { path: '/api/status' }), 'unavailable', gone.url, reported);
      assert.ok(reported.length > 0, 'the SDK error was reported server-side');
    } finally {
      await simulator.close();
    }
  });
});
