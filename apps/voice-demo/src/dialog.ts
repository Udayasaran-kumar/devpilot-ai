import { classifyIntent, normalizeUtterance, type Intent } from './intents.js';
import {
  McpClientError,
  type DevPilotMcpClient,
  type GroundedClaimKind,
  type InvestigationOutcome,
  type InvestigationResult,
  type JobStatus,
  type ProjectedFailure,
  type ReportRepairStatus,
  type RepositoryView,
} from './mcp-client.js';

/** The client calls the dialog makes. */
export type DialogClient = Pick<DevPilotMcpClient, 'listRepositories' | 'startInvestigation' | 'getInvestigationResult'>;

export interface DialogConfig {
  /** Repository to investigate when the user does not name one (`DEVPILOT_DEMO_REPOSITORY_ID`). */
  readonly repositoryId?: string;
}

export function dialogConfigFromEnvironment(env: Readonly<Record<string, string | undefined>>): DialogConfig {
  const repositoryId = env.DEVPILOT_DEMO_REPOSITORY_ID?.trim();
  return repositoryId ? { repositoryId } : {};
}

/** What a conversation remembers between turns. It holds no credentials. */
export interface DialogState {
  /** Repository of the investigation started in this conversation. */
  readonly repositoryId: string | undefined;
  /** Opaque job ID returned by the server. */
  readonly jobId: string | undefined;
  readonly investigationStarted: boolean;
}

export const INITIAL_DIALOG_STATE: DialogState = { repositoryId: undefined, jobId: undefined, investigationStarted: false };

export type DialogKind =
  | 'help'
  | 'choose_repository'
  | 'no_repositories'
  | 'repository_not_registered'
  | 'started'
  | 'busy'
  | 'signal_required'
  | 'no_investigation'
  | 'in_progress'
  | 'verified'
  | 'not_verified'
  | 'failed'
  | 'investigation_unavailable'
  | 'error';

export interface RepositoryChoice {
  readonly repositoryId: string;
  readonly displayName: string;
}

export interface DialogCard {
  readonly repository?: RepositoryChoice;
  readonly repositories?: readonly RepositoryChoice[];
  readonly jobStatus?: JobStatus;
  /** True only for a grounded report whose repair status is `repaired`. */
  readonly verified?: boolean;
  readonly repairStatus?: ReportRepairStatus | null;
  readonly claims?: readonly { readonly kind: GroundedClaimKind; readonly statement: string }[];
  readonly baselineFailures?: readonly ProjectedFailure[];
  readonly affectedFiles?: readonly string[];
  readonly limitations?: readonly string[];
}

/** Safe to render and to speak: fixed text, server-provided summaries, and grounded result fields only. */
export interface DialogResponse {
  readonly kind: DialogKind;
  readonly speech: string;
  readonly jobId?: string;
  readonly card?: DialogCard;
}

export interface DialogTurn {
  readonly intent: Intent;
  readonly response: DialogResponse;
  readonly state: DialogState;
}

export const SPEECH = {
  help: 'You can say "investigate the failing tests" to start an investigation, or "what did you find?" to hear the result.',
  chooseRepository: (names: readonly string[]) =>
    `Which repository should I investigate? Say "investigate" followed by its name: ${spokenList(names)}.`,
  noRepositories: 'No repositories are registered on the DevPilot server.',
  repositoryNotRegistered: 'The repository this demo is configured for is not registered on the DevPilot server.',
  started: (displayName: string) =>
    `Investigation started for ${displayName}. I'll check the failing tests. Ask me what I found in a little while.`,
  busyTracked: (displayName: string) => `An investigation is already running for ${displayName}. Ask me what I found in a little while.`,
  busyUntracked: (displayName: string) =>
    `An investigation is already running for ${displayName}, but it was not started in this conversation. Try again once it has finished.`,
  signalRequired: (displayName: string) =>
    `${displayName} has no default failure description on the DevPilot server, so I can't start an investigation by voice.`,
  noInvestigation: "I don't have an active investigation yet. Ask me to investigate the failing tests first.",
  inProgress: "I'm still investigating. The repair has not been verified yet.",
  notVerified: 'The investigation finished, but DevPilot did not verify a repair.',
  failed: 'The investigation could not be completed, and no repair was verified.',
  unavailable: 'That investigation is no longer available. The DevPilot server may have restarted, so please start a new investigation.',
  error: "Sorry, I couldn't complete that request.",
} as const;

/**
 * The MCP server's public refusal texts the dialog reacts to. The server
 * sends no machine-readable reason, so these must match its text exactly;
 * anything else is treated as an unexpected error.
 */
export const SERVER_REFUSAL_TEXT = {
  repositoryBusy: 'That repository already has an investigation in progress. Poll get_investigation_result for its job.',
  signalRequired: 'This repository has no default signal. Describe the failure in the signal argument.',
  unknownJob: 'No investigation job has that ID.',
} as const;
type Refusal = keyof typeof SERVER_REFUSAL_TEXT;

/**
 * Deterministic turn handling over the DevPilot MCP client. Every technical
 * statement it makes comes from the server: the dialog speaks fixed text or
 * the server's spoken summary and never describes a result itself.
 */
export class VoiceDialog {
  readonly #client: DialogClient;
  readonly #configuredRepositoryId: string | undefined;

  constructor(client: DialogClient, config: DialogConfig = {}) {
    this.#client = client;
    this.#configuredRepositoryId = config.repositoryId;
  }

  async respond(utterance: string, state: DialogState = INITIAL_DIALOG_STATE): Promise<DialogTurn> {
    const { intent, normalized } = classifyIntent(utterance);
    switch (intent) {
      case 'START_INVESTIGATION':
        return { intent, ...(await this.#start(normalized, state)) };
      case 'GET_RESULT':
        return { intent, ...(await this.#result(state)) };
      case 'HELP':
        return { intent, ...reply(state, 'help', SPEECH.help) };
    }
  }

  async #start(normalized: string, state: DialogState): Promise<Reply> {
    let repositories: readonly RepositoryView[];
    try {
      repositories = await this.#client.listRepositories();
    } catch {
      return reply(state, 'error', SPEECH.error);
    }
    const selection = this.#select(normalized, state, repositories);
    if (selection.kind === 'none') return reply(state, 'no_repositories', SPEECH.noRepositories);
    if (selection.kind === 'unregistered') return reply(state, 'repository_not_registered', SPEECH.repositoryNotRegistered);
    if (selection.kind === 'ambiguous') {
      const choices = repositories.map(choiceOf);
      return reply(state, 'choose_repository', SPEECH.chooseRepository(choices.map((choice) => choice.displayName)), { repositories: choices });
    }

    const repository = choiceOf(selection.repository);
    try {
      const job = await this.#client.startInvestigation(repository.repositoryId);
      const next: DialogState = { repositoryId: job.repositoryId, jobId: job.jobId, investigationStarted: true };
      return reply(next, 'started', SPEECH.started(repository.displayName), { repository, jobStatus: job.status });
    } catch (error) {
      switch (refusalOf(error)) {
        case 'repositoryBusy': {
          const tracked = state.jobId !== undefined && state.repositoryId === repository.repositoryId;
          const speech = tracked ? SPEECH.busyTracked(repository.displayName) : SPEECH.busyUntracked(repository.displayName);
          return reply(state, 'busy', speech, { repository });
        }
        case 'signalRequired':
          return reply(state, 'signal_required', SPEECH.signalRequired(repository.displayName), { repository });
        default:
          return reply(state, 'error', SPEECH.error);
      }
    }
  }

  /** A repository named in the utterance, then this conversation's, then the configured one, then the only one. */
  #select(normalized: string, state: DialogState, repositories: readonly RepositoryView[]): Selection {
    if (repositories.length === 0) return { kind: 'none' };
    const named = mentionedRepository(normalized, repositories);
    if (named) return { kind: 'selected', repository: named };
    const byId = (repositoryId: string | undefined) => repositories.find((repository) => repository.repositoryId === repositoryId);
    const current = byId(state.repositoryId);
    if (current) return { kind: 'selected', repository: current };
    if (this.#configuredRepositoryId !== undefined) {
      const configured = byId(this.#configuredRepositoryId);
      return configured ? { kind: 'selected', repository: configured } : { kind: 'unregistered' };
    }
    const [only] = repositories;
    return repositories.length === 1 && only ? { kind: 'selected', repository: only } : { kind: 'ambiguous' };
  }

  async #result(state: DialogState): Promise<Reply> {
    if (state.jobId === undefined) return reply(state, 'no_investigation', SPEECH.noInvestigation);
    let result: InvestigationResult;
    try {
      result = await this.#client.getInvestigationResult(state.jobId);
    } catch (error) {
      if (refusalOf(error) === 'unknownJob') {
        return reply({ ...state, jobId: undefined, investigationStarted: false }, 'investigation_unavailable', SPEECH.unavailable);
      }
      return reply(state, 'error', SPEECH.error);
    }
    if (result.job.jobId !== state.jobId) return reply(state, 'error', SPEECH.error);

    const { job, outcome } = result;
    switch (job.status) {
      case 'queued':
      case 'running':
        return reply(state, 'in_progress', SPEECH.inProgress, { jobStatus: job.status });
      case 'failed':
        return reply(state, 'failed', SPEECH.failed, { jobStatus: job.status, verified: false });
      case 'completed':
        if (!outcome) return reply(state, 'not_verified', SPEECH.notVerified, { jobStatus: job.status, verified: false });
        if (isVerifiedRepair(outcome)) return reply(state, 'verified', outcome.spokenSummary, outcomeCard(outcome, true));
        return reply(state, 'not_verified', `${SPEECH.notVerified} ${outcome.spokenSummary}`, outcomeCard(outcome, false));
    }
  }
}

type Reply = Omit<DialogTurn, 'intent'>;
type Selection = { kind: 'selected'; repository: RepositoryView } | { kind: 'none' } | { kind: 'unregistered' } | { kind: 'ambiguous' };

function reply(state: DialogState, kind: DialogKind, speech: string, card?: DialogCard): Reply {
  return {
    response: { kind, speech, ...(state.jobId !== undefined ? { jobId: state.jobId } : {}), ...(card ? { card } : {}) },
    state,
  };
}

/** Only a grounded report with the repair workflow's `repaired` status counts as a verified repair. */
function isVerifiedRepair(outcome: InvestigationOutcome): boolean {
  return outcome.groundingValid && outcome.repairStatus === 'repaired';
}

/**
 * Report text that describes how DevPilot verified a result rather than the
 * result itself: the verification command and its exit codes, hypothesis and
 * evidence IDs, review and workflow states, paths outside the repository,
 * URLs, and credential-like values.
 */
const INTERNAL_DETAIL: readonly RegExp[] = [
  /\b(npm|npx|pnpm|yarn|node|bun|deno|tsx|pytest|cargo|mvn|gradle|jest|vitest|mocha|go test)\b/i,
  /\bverification command\b|\bexited (with code|0)\b/i,
  /^(Supports|Contradicts) [^:]+: /,
  /\b(hyp|ev|claim|action)-[a-z0-9]/i,
  /\breview status\b/i,
  /\b[a-z][a-z0-9]*(_[a-z0-9]+)+\b/,
  /(^|[\s(`'"=:,])(\/|~\/|\.\.\/)\S/,
  /\b[a-z]:\\|\\\\/i,
  /\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\blocalhost\b|\b\d{1,3}(\.\d{1,3}){3}\b/i,
  /\b(bearer|tokens?|secrets?|password|passwd|api[ _-]?key|authorization|credentials?)\b/i,
  /(?=[A-Za-z0-9+=_-]*\d)[A-Za-z0-9+=_-]{24,}/,
];

/**
 * The card is a presentation of the server's result, not a restatement: a
 * claim or limitation that contains internal detail is left off, and every
 * other one is shown exactly as the server wrote it.
 */
function presentable(text: string): boolean {
  return !INTERNAL_DETAIL.some((pattern) => pattern.test(text));
}

function outcomeCard(outcome: InvestigationOutcome, verified: boolean): DialogCard {
  return {
    jobStatus: 'completed',
    verified,
    repairStatus: outcome.repairStatus,
    claims: outcome.claims.filter((claim) => presentable(claim.statement)).map((claim) => ({ kind: claim.kind, statement: claim.statement })),
    baselineFailures: outcome.baselineFailures.map((failure) => ({ testFile: failure.testFile, suite: [...failure.suite], testName: failure.testName })),
    affectedFiles: [...outcome.affectedFiles],
    limitations: outcome.limitations.filter(presentable),
  };
}

function choiceOf(repository: RepositoryView): RepositoryChoice {
  return { repositoryId: repository.repositoryId, displayName: repository.displayName };
}

/** The repository whose ID or display name appears in the utterance as whole words; the longest match wins, and a tie is no match. */
function mentionedRepository(normalized: string, repositories: readonly RepositoryView[]): RepositoryView | undefined {
  const padded = ` ${normalized} `;
  let best: RepositoryView | undefined;
  let bestLength = 0;
  let tied = false;
  for (const repository of repositories) {
    const length = Math.max(
      ...[repository.repositoryId, repository.displayName]
        .map(normalizeUtterance)
        .map((name) => (name.length > 0 && padded.includes(` ${name} `) ? name.length : 0)),
    );
    if (length === 0 || length < bestLength) continue;
    tied = length === bestLength;
    best = repository;
    bestLength = length;
  }
  return tied ? undefined : best;
}

function refusalOf(error: unknown): Refusal | undefined {
  if (!(error instanceof McpClientError) || error.code !== 'tool_error') return undefined;
  return (Object.keys(SERVER_REFUSAL_TEXT) as Refusal[]).find((refusal) => SERVER_REFUSAL_TEXT[refusal] === error.detail);
}

function spokenList(names: readonly string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
}
