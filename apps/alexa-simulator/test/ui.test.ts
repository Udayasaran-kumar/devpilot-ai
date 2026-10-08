import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { INITIAL_DIALOG_STATE, SPEECH, VoiceDialog, type DialogCard, type DialogClient, type DialogResponse, type DialogState } from '../../voice-demo/src/dialog.js';
import { classifyIntent } from '../../voice-demo/src/intents.js';
import type { JobView } from '../../voice-demo/src/mcp-client.js';
import { startSimulatorServer, type SimulatorServer } from '../src/server/http.js';
import {
  CHECK_RESULT_UTTERANCE,
  Conversation,
  ERROR_TEXT,
  httpTransport,
  INITIAL_SNAPSHOT,
  type ConnectionStatus,
  type DialogReply,
  type DialogTransport,
} from '../src/web/conversation.js';
import { ConversationView, EMPTY_STATE_TEXT, INVESTIGATION_LABEL, type ConversationActions } from '../src/web/view.js';

const JOB_ID = 'job-00000000-0000-4000-8000-000000000002';
const ACTIVE: DialogState = { repositoryId: 'shop', jobId: JOB_ID, investigationStarted: true };

/** A transport whose replies the test releases one at a time. */
class FakeTransport implements DialogTransport {
  readonly sent: Array<{ utterance: string; state: DialogState }> = [];
  statusCalls = 0;
  connection: ConnectionStatus = 'connected';
  readonly #waiting: Array<(reply: DialogReply) => void> = [];

  send(utterance: string, state: DialogState): Promise<DialogReply> {
    this.sent.push({ utterance, state });
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  async status(): Promise<ConnectionStatus> {
    this.statusCalls += 1;
    return this.connection;
  }

  reply(response: DialogResponse, state: DialogState = INITIAL_DIALOG_STATE): void {
    this.#release({ ok: true, response, state });
  }

  fail(error: 'failed' | 'unavailable'): void {
    this.#release({ ok: false, error });
  }

  #release(reply: DialogReply): void {
    const next = this.#waiting.shift();
    assert.ok(next, 'no request is waiting');
    next(reply);
  }
}

/** Sends and settles one exchange. */
async function exchange(conversation: Conversation, transport: FakeTransport, utterance: string, response: DialogResponse, state?: DialogState): Promise<void> {
  const sending = conversation.send(utterance);
  transport.reply(response, state);
  await sending;
}

/** The view's actions bound to a conversation; `settled` waits for every request they started. */
function bind(conversation: Conversation): { actions: ConversationActions; settled: () => Promise<unknown> } {
  const inFlight: Promise<void>[] = [];
  const track = (promise: Promise<void>) => void inFlight.push(promise);
  return {
    actions: {
      setDraft: (draft) => conversation.setDraft(draft),
      submit: () => track(conversation.submit()),
      checkResult: () => track(conversation.checkResult()),
      chooseRepository: (choice) => track(conversation.chooseRepository(choice)),
      clear: () => conversation.clear(),
    },
    settled: () => Promise.all(inFlight),
  };
}

function view(conversation: Conversation, actions: ConversationActions = bind(conversation).actions): React.ReactElement {
  return React.createElement(ConversationView, { snapshot: conversation.getSnapshot(), actions });
}

function markup(conversation: Conversation): string {
  return renderToStaticMarkup(view(conversation));
}

interface HostElement {
  readonly type: string;
  readonly props: Record<string, unknown>;
}

/** Every DOM element the view produces; its components use no hooks, so they can be called directly. */
function hostElements(node: unknown, found: HostElement[] = []): HostElement[] {
  if (Array.isArray(node)) {
    for (const child of node) hostElements(child, found);
    return found;
  }
  if (!React.isValidElement(node)) return found;
  const { type, props } = node as React.ReactElement<Record<string, unknown>>;
  if (typeof type === 'function') return hostElements((type as (props: unknown) => unknown)(props), found);
  if (typeof type === 'string') found.push({ type, props });
  return hostElements(props.children, found);
}

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (!React.isValidElement(node)) return '';
  const { type, props } = node as React.ReactElement<Record<string, unknown>>;
  return typeof type === 'function' ? textOf((type as (props: unknown) => unknown)(props)) : textOf(props.children);
}

/** The header's connection indicator text. */
function connectionText(conversation: Conversation): string {
  const indicator = hostElements(view(conversation)).find((element) => String(element.props.className).startsWith('connection connection--'));
  assert.ok(indicator, 'no connection indicator');
  return textOf(indicator.props.children);
}

/** The investigation strip, one entry per part. */
function investigationText(conversation: Conversation): string[] {
  const elements = hostElements(view(conversation));
  const strip = elements.find((element) => String(element.props.className).startsWith('investigation investigation--'));
  assert.ok(strip, 'no investigation status');
  return hostElements(strip.props.children).map((part) => textOf(part.props.children));
}

function buttons(element: React.ReactElement): Array<HostElement & { text: string }> {
  return hostElements(element)
    .filter((candidate) => candidate.type === 'button')
    .map((button) => ({ ...button, text: textOf(button.props.children) }));
}

function button(element: React.ReactElement, label: string): HostElement & { text: string } {
  const found = buttons(element).find((candidate) => candidate.text.includes(label));
  assert.ok(found, `no "${label}" button`);
  return found;
}

function click(target: HostElement): void {
  assert.notEqual(target.props.disabled, true, 'the button is disabled');
  (target.props.onClick as () => void)();
}

const VERIFIED_CARD: DialogCard = {
  jobStatus: 'completed',
  verified: true,
  repairStatus: 'repaired',
  claims: [{ kind: 'verification', statement: 'Verified: the previously failing test "applies the discount once" passed after the repair.' }],
  baselineFailures: [{ testFile: 'test/cart.test.ts', suite: ['cart'], testName: 'applies the discount once' }],
  affectedFiles: ['src/cart.ts'],
  limitations: ['The patch was not applied to the repository.'],
};

describe('simulator UI', () => {
  it('renders the empty state with the DevPilot header and simulation label', () => {
    const conversation = new Conversation(new FakeTransport());
    const html = markup(conversation);
    for (const text of [EMPTY_STATE_TEXT, 'DevPilot', 'Developer Incident Assistant', 'Alexa+ style simulation', 'Ask DevPilot…', 'Send', 'Clear conversation']) {
      assert.ok(html.includes(text), `missing ${text}`);
    }
    assert.ok(!html.includes('Check result'));
    assert.ok(!/alexa(?!\+ style simulation)/i.test(html.replace(/<title>[^<]*<\/title>/, '')), 'no other Alexa branding');
  });

  it('shows the connection as Available or Unavailable from the simulator\'s status', async () => {
    const transport = new FakeTransport();
    const conversation = new Conversation(transport);
    assert.equal(connectionText(conversation), 'Checking…');
    await conversation.refreshConnection();
    assert.equal(connectionText(conversation), 'Available');
    assert.ok(markup(conversation).includes('connection connection--connected'));
    assert.ok(!markup(conversation).includes('Unavailable'));
    transport.connection = 'unavailable';
    await conversation.refreshConnection();
    assert.equal(connectionText(conversation), 'Unavailable');
    assert.ok(markup(conversation).includes('connection connection--unavailable'));
    assert.ok(!markup(conversation).includes('>Available<'));
  });

  it('a status check that fails shows Unavailable, without the reason', async () => {
    for (const fetchImpl of [
      async () => Promise.reject(new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:8790')),
      async () => new Response('SdkError: Bearer secret-token at http://127.0.0.1:8788/mcp', { status: 500 }),
      async () => new Response(JSON.stringify({ status: 'connected?', error: 'SdkError' }), { status: 200 }),
    ] satisfies Array<typeof fetch>) {
      const conversation = new Conversation(httpTransport(fetchImpl));
      await conversation.refreshConnection();
      assert.equal(connectionText(conversation), 'Unavailable');
      const html = markup(conversation);
      for (const detail of ['SdkError', 'ECONNREFUSED', 'Bearer', 'secret-token', '8788', '8790', 'http://']) assert.ok(!html.includes(detail), `shows ${detail}`);
    }
  });

  it('an active investigation is shown apart from the connection, which stays Available', async () => {
    const transport = new FakeTransport();
    const conversation = new Conversation(transport);
    await conversation.refreshConnection();
    const statusChecks = transport.statusCalls;
    const orders = { repositoryId: 'orders-api', displayName: 'Orders API' };
    const state: DialogState = { repositoryId: 'orders-api', jobId: JOB_ID, investigationStarted: true };
    await exchange(conversation, transport, 'investigate orders api', { kind: 'started', speech: SPEECH.started('Orders API'), jobId: JOB_ID, card: { repository: orders, jobStatus: 'queued' } }, state);
    assert.equal(connectionText(conversation), 'Available');
    assert.deepEqual(investigationText(conversation), ['Investigation', INVESTIGATION_LABEL.active, 'Orders API']);

    await exchange(conversation, transport, 'what did you find?', { kind: 'in_progress', speech: SPEECH.inProgress, jobId: JOB_ID, card: { jobStatus: 'running' } }, state);
    assert.equal(connectionText(conversation), 'Available');
    assert.deepEqual(investigationText(conversation), ['Investigation', INVESTIGATION_LABEL.active, 'Orders API']);
    assert.equal(transport.statusCalls, statusChecks, 'the investigation does not trigger connection checks');

    await exchange(conversation, transport, 'what did you find?', { kind: 'verified', speech: 'Verified.', jobId: JOB_ID, card: VERIFIED_CARD }, state);
    assert.equal(connectionText(conversation), 'Available');
    assert.deepEqual(investigationText(conversation), ['Investigation', INVESTIGATION_LABEL.none]);
  });

  it('no active investigation never makes the connection Unavailable', async () => {
    const transport = new FakeTransport();
    const conversation = new Conversation(transport);
    await conversation.refreshConnection();
    assert.equal(connectionText(conversation), 'Available');
    assert.deepEqual(investigationText(conversation), ['Investigation', INVESTIGATION_LABEL.none]);
    const replies: ReadonlyArray<readonly [DialogResponse, DialogState]> = [
      [{ kind: 'help', speech: SPEECH.help }, INITIAL_DIALOG_STATE],
      [{ kind: 'no_investigation', speech: SPEECH.noInvestigation }, INITIAL_DIALOG_STATE],
      [{ kind: 'failed', speech: SPEECH.failed, jobId: JOB_ID, card: { jobStatus: 'failed', verified: false } }, ACTIVE],
      [{ kind: 'investigation_unavailable', speech: SPEECH.unavailable }, { repositoryId: 'shop', jobId: undefined, investigationStarted: false }],
    ];
    for (const [response, state] of replies) {
      await exchange(conversation, transport, 'what did you find?', response, state);
      assert.equal(connectionText(conversation), 'Available', response.kind);
      assert.deepEqual(investigationText(conversation), ['Investigation', INVESTIGATION_LABEL.none], response.kind);
    }
    assert.equal(transport.statusCalls, 1);
  });

  it('renders the user\'s message, then the assistant\'s speech exactly as the server sent it', async () => {
    const transport = new FakeTransport();
    const conversation = new Conversation(transport);
    conversation.setDraft('  investigate the failing tests  ');
    const sending = conversation.submit();
    const pendingHtml = markup(conversation);
    assert.match(pendingHtml, /message--user"><p class="bubble">investigate the failing tests<\/p>/);
    assert.ok(pendingHtml.includes('DevPilot is working…'));
    assert.equal(conversation.getSnapshot().draft, '');

    const speech = 'Investigation started for Shop & "Cart" <b>. I\'ll check the failing tests.';
    transport.reply({ kind: 'started', speech, jobId: JOB_ID }, ACTIVE);
    await sending;
    const last = conversation.getSnapshot().messages.at(-1);
    assert.ok(last?.role === 'assistant');
    assert.equal(last.text, speech);
    assert.ok(markup(conversation).includes('Investigation started for Shop &amp; &quot;Cart&quot; &lt;b&gt;. I&#x27;ll check the failing tests.'));
    assert.deepEqual(transport.sent, [{ utterance: 'investigate the failing tests', state: INITIAL_DIALOG_STATE }]);
  });

  it('the card shows only DialogResponse card fields', async () => {
    const transport = new FakeTransport();
    const conversation = new Conversation(transport);
    const smuggled = { ...VERIFIED_CARD, command: 'npm test', evidenceIds: ['ev-001'], hypotheses: ['hyp-001'], repositoryRoot: '/Users/example/project' } as DialogCard;
    await exchange(conversation, transport, 'what did you find?', { kind: 'verified', speech: 'DevPilot verified a patch.', jobId: JOB_ID, card: smuggled }, ACTIVE);
    const html = markup(conversation);
    for (const shown of ['applies the discount once', 'test/cart.test.ts', 'src/cart.ts', 'The patch was not applied to the repository.', 'Verified: the previously failing test', 'completed', 'repaired']) {
      assert.ok(html.includes(shown.replaceAll('"', '&quot;')), `missing ${shown}`);
    }
    for (const hidden of ['npm test', 'ev-001', 'hyp-001', '/Users/example/project', 'evidenceIds', 'command']) assert.ok(!html.includes(hidden), `shows ${hidden}`);
  });

  it('distinguishes a verified repair from an unverified, in-progress, or failed one', async () => {
    const cases: ReadonlyArray<readonly [response: DialogResponse, className: string, heading: string]> = [
      [{ kind: 'verified', speech: 'Verified.', card: VERIFIED_CARD }, 'card--verified', 'Verified repair'],
      [{ kind: 'not_verified', speech: SPEECH.notVerified, card: { ...VERIFIED_CARD, verified: false, repairStatus: 'not_attempted' } }, 'card--unverified', 'Repair not verified'],
      [{ kind: 'in_progress', speech: SPEECH.inProgress, card: { jobStatus: 'running' } }, 'card--in-progress', 'Investigation in progress'],
      [{ kind: 'started', speech: SPEECH.started('Shop'), card: { repository: { repositoryId: 'shop', displayName: 'Shop' }, jobStatus: 'queued' } }, 'card--in-progress', 'Investigation in progress'],
      [{ kind: 'failed', speech: SPEECH.failed, card: { jobStatus: 'failed', verified: false } }, 'card--failed', 'Investigation failed'],
    ];
    for (const [response, className, heading] of cases) {
      const transport = new FakeTransport();
      const conversation = new Conversation(transport);
      await exchange(conversation, transport, 'what did you find?', response, ACTIVE);
      const html = markup(conversation);
      assert.ok(html.includes(`card ${className}`), `${response.kind}: missing ${className}`);
      assert.ok(html.includes(heading), `${response.kind}: missing ${heading}`);
      if (response.kind !== 'verified') assert.ok(!html.includes('Verified repair') && !html.includes('card--verified'), `${response.kind} looks verified`);
    }
  });

  it('renders repository choices as buttons', async () => {
    const transport = new FakeTransport();
    const conversation = new Conversation(transport);
    const repositories = [
      { repositoryId: 'shop', displayName: 'Shop' },
      { repositoryId: 'cart', displayName: 'Cart' },
    ];
    await exchange(conversation, transport, 'investigate', { kind: 'choose_repository', speech: SPEECH.chooseRepository(['Shop', 'Cart']), card: { repositories } });
    const choices = buttons(view(conversation)).filter((candidate) => candidate.props.className === 'choice');
    assert.deepEqual(
      choices.map((choice) => choice.text),
      ['Shopshop', 'Cartcart'],
    );
  });

  it('choosing a repository sends a normal utterance to /api/dialog, which VoiceDialog resolves', async () => {
    await withDialogServer(async (server, requests) => {
      const conversation = new Conversation(httpTransport(serverFetch(server, requests)));
      await conversation.send('investigate the failing tests');
      assert.equal(conversation.getSnapshot().messages.at(-1)?.role === 'assistant' && conversation.getSnapshot().messages.at(-1)?.text, SPEECH.chooseRepository(['Shop', 'Cart']));

      const { actions, settled } = bind(conversation);
      click(button(view(conversation, actions), 'Cart'));
      await settled();
      assert.deepEqual(requests.at(-1), {
        method: 'POST',
        path: '/api/dialog',
        body: { utterance: 'Investigate repository cart', state: { investigationStarted: false } },
      });
      const last = conversation.getSnapshot().messages.at(-1);
      assert.ok(last?.role === 'assistant');
      assert.equal(last.kind, 'started');
      assert.equal(last.text, SPEECH.started('Cart'));
      assert.deepEqual(conversation.getSnapshot().state, { repositoryId: 'cart', jobId: JOB_ID, investigationStarted: true });
    });
  });

  it('renders only generic text for errors, whatever the server or network said', async () => {
    const outcomes: ReadonlyArray<readonly [fetchImpl: typeof fetch, text: string]> = [
      [async () => Promise.reject(new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:8788')), ERROR_TEXT.unavailable],
      [async () => new Response('Error: Bearer secret-token\n    at /Users/example/project/server.js:1:1', { status: 500 }), ERROR_TEXT.failed],
      [async () => new Response(JSON.stringify({ error: 'hyp-001 npm test' }), { status: 400 }), ERROR_TEXT.failed],
      [async () => new Response('not json', { status: 200 }), ERROR_TEXT.failed],
      [async () => new Response(JSON.stringify({ structuredContent: { command: 'npm test' } }), { status: 200 }), ERROR_TEXT.failed],
    ];
    for (const [fetchImpl, text] of outcomes) {
      const conversation = new Conversation(httpTransport(fetchImpl));
      await conversation.send('what did you find?');
      const html = markup(conversation);
      assert.equal(conversation.getSnapshot().messages.at(-1)?.text, text);
      for (const detail of ['ECONNREFUSED', '8788', 'Bearer', 'secret-token', '/Users/example', 'hyp-001', 'npm test', 'structuredContent', 'not json']) {
        assert.ok(!html.includes(detail), `shows ${detail}`);
      }
      assert.equal(conversation.getSnapshot().pending, false);
    }
    assert.equal(ERROR_TEXT.failed, "Sorry, I couldn't complete that request.");
    assert.equal(ERROR_TEXT.unavailable, 'DevPilot is currently unavailable.');
  });

  it('Clear conversation resets messages, state, and job, and ignores a reply still in flight', async () => {
    const transport = new FakeTransport();
    const conversation = new Conversation(transport);
    await conversation.refreshConnection();
    await exchange(conversation, transport, 'investigate', { kind: 'started', speech: SPEECH.started('Shop'), jobId: JOB_ID }, ACTIVE);
    assert.equal(conversation.getSnapshot().jobActive, true);

    const late = conversation.send('what did you find?');
    conversation.setDraft('half typed');
    const { actions } = bind(conversation);
    click(button(view(conversation, actions), 'Clear conversation'));
    assert.deepEqual(conversation.getSnapshot(), { ...INITIAL_SNAPSHOT, connection: 'connected' });
    transport.reply({ kind: 'verified', speech: 'Verified.', jobId: JOB_ID, card: VERIFIED_CARD }, ACTIVE);
    await late;
    assert.deepEqual(conversation.getSnapshot(), { ...INITIAL_SNAPSHOT, connection: 'connected' });
    assert.ok(markup(conversation).includes(EMPTY_STATE_TEXT));

    await exchange(conversation, transport, 'hello', { kind: 'help', speech: SPEECH.help });
    assert.deepEqual(transport.sent.at(-1), { utterance: 'hello', state: INITIAL_DIALOG_STATE });
  });

  it('Check result appears for an active job and sends the existing result question through /api/dialog', async () => {
    assert.equal(classifyIntent(CHECK_RESULT_UTTERANCE).intent, 'GET_RESULT');
    await withDialogServer(async (server, requests) => {
      const conversation = new Conversation(httpTransport(serverFetch(server, requests)));
      assert.ok(!markup(conversation).includes('Check result'));
      await conversation.send('investigate shop');
      assert.equal(conversation.getSnapshot().jobActive, true);

      const { actions, settled } = bind(conversation);
      click(button(view(conversation, actions), 'Check result'));
      await settled();
      assert.deepEqual(requests.at(-1), {
        method: 'POST',
        path: '/api/dialog',
        body: { utterance: CHECK_RESULT_UTTERANCE, state: { repositoryId: 'shop', jobId: JOB_ID, investigationStarted: true } },
      });
      assert.equal(conversation.getSnapshot().messages.at(-1)?.text, 'DevPilot verified a patch in an isolated worktree.');
      assert.equal(conversation.getSnapshot().jobActive, false);
      assert.ok(!markup(conversation).includes('Check result'));
    });
  });

  it('allows one request at a time: a second submission while one is pending is dropped and controls are disabled', async () => {
    const transport = new FakeTransport();
    const conversation = new Conversation(transport);
    await exchange(conversation, transport, 'investigate', { kind: 'started', speech: SPEECH.started('Shop'), jobId: JOB_ID }, ACTIVE);

    const first = conversation.checkResult();
    const second = conversation.checkResult();
    const third = conversation.send('investigate the failing tests');
    conversation.setDraft('what did you find?');
    const fourth = conversation.submit();
    assert.equal(transport.sent.length, 2);
    for (const control of buttons(view(conversation)).filter((candidate) => candidate.text !== 'Clear conversation')) {
      assert.equal(control.props.disabled, true, `${control.text} is enabled while a request is pending`);
    }
    transport.reply({ kind: 'in_progress', speech: SPEECH.inProgress, jobId: JOB_ID, card: { jobStatus: 'running' } }, ACTIVE);
    await Promise.all([first, second, third, fourth]);
    assert.equal(transport.sent.length, 2);
    assert.equal(conversation.getSnapshot().messages.length, 4);
  });

  it('never asks for a result on its own', async () => {
    const transport = new FakeTransport();
    const conversation = new Conversation(transport);
    await exchange(conversation, transport, 'investigate', { kind: 'started', speech: SPEECH.started('Shop'), jobId: JOB_ID }, ACTIVE);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(transport.sent.length, 1);
    assert.equal(transport.statusCalls, 0);
  });
});

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** A real simulator HTTP server over the real VoiceDialog with a stub MCP client. */
async function withDialogServer(run: (server: SimulatorServer, requests: RecordedRequest[]) => Promise<void>): Promise<void> {
  const job: JobView = { jobId: JOB_ID, repositoryId: 'shop', status: 'queued', createdAt: '2026-10-08T00:00:00.000Z' };
  const client: DialogClient = {
    listRepositories: async () => [
      { repositoryId: 'shop', displayName: 'Shop', command: 'npm test' },
      { repositoryId: 'cart', displayName: 'Cart', command: 'npm test' },
    ],
    startInvestigation: async (repositoryId) => ({ ...job, repositoryId }),
    getInvestigationResult: async (jobId) => ({
      job: { ...job, jobId, status: 'completed', finishedAt: '2026-10-08T00:01:00.000Z' },
      outcome: {
        investigationId: 'investigation-1',
        groundingValid: true,
        repairStatus: 'repaired',
        claims: [],
        baselineFailures: [],
        affectedFiles: [],
        limitations: [],
        spokenSummary: 'DevPilot verified a patch in an isolated worktree.',
      },
    }),
  };
  const server = await startSimulatorServer({
    dialog: new VoiceDialog(client),
    available: async () => true,
    assets: { html: '', script: '', styles: '' },
    port: 0,
  });
  try {
    await run(server, []);
  } finally {
    await server.close();
  }
}

/** The page's fetch, resolved against the server and recorded. */
function serverFetch(server: SimulatorServer, requests: RecordedRequest[]): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input), server.url);
    requests.push({ method: init?.method ?? 'GET', path: url.pathname, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    return fetch(url, init);
  };
}
