import type { DialogCard, DialogKind, DialogResponse, DialogState, RepositoryChoice } from '../../../voice-demo/src/dialog.js';

/** A result question the dialog already understands. */
export const CHECK_RESULT_UTTERANCE = 'What did you find?';

export const ERROR_TEXT = {
  failed: "Sorry, I couldn't complete that request.",
  unavailable: 'DevPilot is currently unavailable.',
} as const;

export const INITIAL_STATE: DialogState = { repositoryId: undefined, jobId: undefined, investigationStarted: false };

export type ConnectionStatus = 'checking' | 'connected' | 'unavailable';

export type Message =
  | { readonly id: number; readonly role: 'user'; readonly text: string }
  | { readonly id: number; readonly role: 'assistant'; readonly text: string; readonly kind?: DialogKind; readonly card?: DialogCard };

export interface ConversationSnapshot {
  readonly messages: readonly Message[];
  /** Sent back with every request; the server validates it. */
  readonly state: DialogState;
  readonly draft: string;
  /** A request is in flight; nothing else can be sent until it settles. */
  readonly pending: boolean;
  /** Whether the simulator backend can reach the DevPilot MCP server; independent of any investigation. */
  readonly connection: ConnectionStatus;
  /** The conversation's investigation was started and has not reached a final result. */
  readonly jobActive: boolean;
  /** The repository of the active investigation, as the dialog named it when it started. */
  readonly activeRepository: RepositoryChoice | undefined;
}

export type DialogReply = { readonly ok: true; readonly response: DialogResponse; readonly state: DialogState } | { readonly ok: false; readonly error: keyof typeof ERROR_TEXT };

/** The browser's only channel to DevPilot: the simulator's own endpoints. */
export interface DialogTransport {
  send(utterance: string, state: DialogState): Promise<DialogReply>;
  status(): Promise<ConnectionStatus>;
}

export const INITIAL_SNAPSHOT: ConversationSnapshot = {
  messages: [],
  state: INITIAL_STATE,
  draft: '',
  pending: false,
  connection: 'checking',
  jobActive: false,
  activeRepository: undefined,
};

/** Kinds that mean DevPilot answered, so the connection is up. */
const REACHED_DEVPILOT: ReadonlySet<DialogKind> = new Set([
  'choose_repository',
  'no_repositories',
  'repository_not_registered',
  'started',
  'busy',
  'signal_required',
  'in_progress',
  'verified',
  'not_verified',
  'failed',
  'investigation_unavailable',
]);

/** Selecting a repository says its ID, which the dialog matches as a named repository. */
export function choiceUtterance(choice: RepositoryChoice): string {
  return `Investigate repository ${choice.repositoryId}`;
}

/**
 * Conversation state for the UI. Every reply comes from `POST /api/dialog`;
 * this class only records the exchange and decides what the UI may offer next.
 */
export class Conversation {
  readonly #transport: DialogTransport;
  readonly #listeners = new Set<() => void>();
  #snapshot: ConversationSnapshot = INITIAL_SNAPSHOT;
  #nextId = 1;
  /** Incremented by `clear`, so a reply to a cleared conversation is dropped. */
  #generation = 0;
  #statusCheck: Promise<void> | undefined;

  constructor(transport: DialogTransport) {
    this.#transport = transport;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): ConversationSnapshot => this.#snapshot;

  setDraft(draft: string): void {
    this.#update({ draft });
  }

  submit(): Promise<void> {
    return this.send(this.#snapshot.draft);
  }

  checkResult(): Promise<void> {
    return this.send(CHECK_RESULT_UTTERANCE);
  }

  chooseRepository(choice: RepositoryChoice): Promise<void> {
    return this.send(choiceUtterance(choice));
  }

  async send(utterance: string): Promise<void> {
    const text = utterance.trim();
    if (this.#snapshot.pending || text === '') return;
    const generation = this.#generation;
    this.#update({
      messages: [...this.#snapshot.messages, { id: this.#nextId++, role: 'user', text }],
      draft: '',
      pending: true,
    });
    const reply = await this.#transport.send(text, this.#snapshot.state).catch((): DialogReply => ({ ok: false, error: 'unavailable' }));
    if (generation !== this.#generation) return;

    if (!reply.ok) {
      this.#update({ messages: [...this.#snapshot.messages, { id: this.#nextId++, role: 'assistant', text: ERROR_TEXT[reply.error] }], pending: false });
      void this.refreshConnection();
      return;
    }
    const { response, state } = reply;
    const jobActive = jobActiveAfter(this.#snapshot.jobActive, response, state);
    const activeRepository = !jobActive ? undefined : response.kind === 'started' ? response.card?.repository : this.#snapshot.activeRepository;
    this.#update({
      messages: [
        ...this.#snapshot.messages,
        { id: this.#nextId++, role: 'assistant', text: response.speech, kind: response.kind, ...(response.card ? { card: response.card } : {}) },
      ],
      state,
      pending: false,
      jobActive,
      activeRepository,
      ...(REACHED_DEVPILOT.has(response.kind) ? { connection: 'connected' as const } : {}),
    });
    if (response.kind === 'error') void this.refreshConnection();
  }

  /** Starts over: no messages, no job, nothing pending. A reply still in flight is ignored. */
  clear(): void {
    this.#generation += 1;
    this.#update({ ...INITIAL_SNAPSHOT, connection: this.#snapshot.connection });
  }

  /** Asks the simulator whether DevPilot is reachable; concurrent calls share one request. */
  refreshConnection(): Promise<void> {
    this.#statusCheck ??= this.#transport
      .status()
      .catch((): ConnectionStatus => 'unavailable')
      .then((connection) => this.#update({ connection }))
      .finally(() => {
        this.#statusCheck = undefined;
      });
    return this.#statusCheck;
  }

  #update(change: Partial<ConversationSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...change };
    for (const listener of this.#listeners) listener();
  }
}

function jobActiveAfter(previous: boolean, response: DialogResponse, state: DialogState): boolean {
  if (state.jobId === undefined) return false;
  switch (response.kind) {
    case 'started':
    case 'in_progress':
    case 'busy':
      return true;
    case 'verified':
    case 'not_verified':
    case 'failed':
    case 'investigation_unavailable':
      return false;
    default:
      return previous;
  }
}

/** The transport the page uses: same-origin `fetch` to the simulator. */
export function httpTransport(fetchImpl: typeof fetch = (input, init) => fetch(input, init)): DialogTransport {
  return {
    async send(utterance, state) {
      let res: Response;
      try {
        res = await fetchImpl('/api/dialog', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ utterance, state }),
        });
      } catch {
        return { ok: false, error: 'unavailable' };
      }
      if (!res.ok) return { ok: false, error: 'failed' };
      const body: unknown = await res.json().catch(() => undefined);
      return isExchange(body) ? { ok: true, response: body.response, state: body.state } : { ok: false, error: 'failed' };
    },
    async status() {
      try {
        const res = await fetchImpl('/api/status', { method: 'GET' });
        const body: unknown = res.ok ? await res.json() : undefined;
        return isRecord(body) && body.status === 'connected' ? 'connected' : 'unavailable';
      } catch {
        return 'unavailable';
      }
    },
  };
}

function isExchange(value: unknown): value is { response: DialogResponse; state: DialogState } {
  if (!isRecord(value) || !isRecord(value.response) || !isRecord(value.state)) return false;
  return typeof value.response.kind === 'string' && typeof value.response.speech === 'string' && typeof value.state.investigationStarted === 'boolean';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
