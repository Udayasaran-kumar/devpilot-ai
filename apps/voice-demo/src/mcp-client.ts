import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type CallToolResult,
  type ProtocolEra,
} from '@modelcontextprotocol/client';

export const CLIENT_NAME = 'devpilot-voice-demo';
export const CLIENT_VERSION = '0.1.0';
export const MIN_TOKEN_LENGTH = 16;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_DETAIL_LENGTH = 500;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const REQUIRED_TOOLS = ['list_repositories', 'start_investigation', 'get_investigation_result'] as const;
type ToolName = (typeof REQUIRED_TOOLS)[number];

/*
 * The server's output contract. This package may only depend on the MCP
 * client, so the shapes are restated here and checked at runtime.
 */
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';
export type ReportRepairStatus =
  | 'repaired'
  | 'baseline_not_red'
  | 'baseline_inconclusive'
  | 'worktree_failed'
  | 'patch_failed'
  | 'verification_failed'
  | 'verification_inconclusive'
  | 'safety_check_failed'
  | 'error'
  | 'not_attempted';
export type GroundedClaimKind = 'observation' | 'finding' | 'proposal' | 'verification';

export interface RepositoryView {
  readonly repositoryId: string;
  readonly displayName: string;
  readonly command: string;
}

export interface JobView {
  /** Opaque, server-assigned. */
  readonly jobId: string;
  readonly repositoryId: string;
  readonly status: JobStatus;
  readonly createdAt: string;
  readonly finishedAt?: string;
  readonly failureReason?: string;
}

export interface ProjectedFailure {
  readonly testFile: string;
  readonly suite: readonly string[];
  readonly testName: string;
}

export interface GroundedClaim {
  readonly id: string;
  readonly kind: GroundedClaimKind;
  readonly statement: string;
  readonly evidenceIds: readonly string[];
  readonly actionIds: readonly string[];
  readonly quote?: string;
}

export interface InvestigationOutcome {
  readonly investigationId: string;
  readonly groundingValid: boolean;
  /** Null when the report is not grounded. */
  readonly repairStatus: ReportRepairStatus | null;
  readonly claims: readonly GroundedClaim[];
  readonly baselineFailures: readonly ProjectedFailure[];
  readonly affectedFiles: readonly string[];
  readonly limitations: readonly string[];
  readonly spokenSummary: string;
}

export interface InvestigationResult {
  readonly job: JobView;
  /** Null until the job has completed. */
  readonly outcome: InvestigationOutcome | null;
}

export type McpClientErrorCode =
  | 'invalid_configuration'
  | 'unavailable'
  | 'unauthorized'
  | 'incompatible_server'
  | 'tool_error'
  | 'invalid_response'
  | 'request_failed'
  | 'closed';

/** The message of every `McpClientError`, except configuration errors, which name the offending setting. */
export const CLIENT_ERROR_TEXT: Readonly<Record<McpClientErrorCode, string>> = {
  invalid_configuration: 'The DevPilot MCP client configuration is not valid.',
  unavailable: 'The DevPilot MCP server is unavailable.',
  unauthorized: 'The DevPilot MCP server rejected the client credentials.',
  incompatible_server: 'The MCP server does not provide the DevPilot investigation tools.',
  tool_error: 'DevPilot refused the request.',
  invalid_response: 'The DevPilot MCP server returned an unexpected response.',
  request_failed: 'The request to the DevPilot MCP server failed.',
  closed: 'The DevPilot MCP client is closed.',
};

/**
 * The only error this module throws. Messages are fixed text; underlying
 * errors are not attached and go to `onError` instead.
 */
export class McpClientError extends Error {
  override readonly name = 'McpClientError';
  readonly code: McpClientErrorCode;
  /** For `tool_error`: the server's public error text, bounded, with the token removed. */
  readonly detail: string | undefined;

  constructor(code: McpClientErrorCode, options: { message?: string; detail?: string } = {}) {
    super(options.message ?? CLIENT_ERROR_TEXT[code]);
    this.code = code;
    this.detail = options.detail;
  }
}

export interface DevPilotMcpClientOptions {
  /** The MCP endpoint, e.g. `http://127.0.0.1:8788/mcp`. Plain http is accepted for loopback hosts only. */
  readonly url: string | URL;
  /** Bearer token for the MCP server. Sent only in the Authorization header. */
  readonly token: string;
  readonly requestTimeoutMs?: number;
  /** Server-side reporting of underlying failures; nothing passed here reaches an `McpClientError`. */
  readonly onError?: (error: unknown) => void;
}

/**
 * A reusable connection to the DevPilot MCP server with one typed method per
 * tool. A call that fails because the connection broke (for example, the
 * server restarted) reconnects and is retried once; every other failure is
 * returned to the caller.
 */
export class DevPilotMcpClient {
  readonly #url: URL;
  readonly #token: string;
  readonly #timeout: number;
  readonly #onError: ((error: unknown) => void) | undefined;
  #client: Client | undefined;
  #connecting: Promise<Client> | undefined;
  #connections = 0;
  #closed = false;

  private constructor(options: DevPilotMcpClientOptions) {
    this.#url = parseEndpoint(options.url);
    if (typeof options.token !== 'string' || options.token.length < MIN_TOKEN_LENGTH || !/^[\x21-\x7e]+$/.test(options.token)) {
      throw new McpClientError('invalid_configuration', {
        message: `A bearer token of at least ${MIN_TOKEN_LENGTH} printable, non-space ASCII characters is required.`,
      });
    }
    this.#token = options.token;
    const timeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout < 1) {
      throw new McpClientError('invalid_configuration', { message: 'requestTimeoutMs must be a positive integer.' });
    }
    this.#timeout = timeout;
    this.#onError = options.onError;
  }

  /** Connects, negotiates the protocol era, and checks that the server lists the DevPilot tools. */
  static async connect(options: DevPilotMcpClientOptions): Promise<DevPilotMcpClient> {
    const client = new DevPilotMcpClient(options);
    await client.#session();
    return client;
  }

  /** Successful connections so far: 1 after `connect`, plus one per reconnect. */
  get connections(): number {
    return this.#connections;
  }

  get protocolEra(): ProtocolEra | undefined {
    return this.#client?.getProtocolEra();
  }

  async listRepositories(): Promise<readonly RepositoryView[]> {
    const list = await this.#call('list_repositories', {}, (value) => (isRepositoryList(value) ? value : undefined));
    return list.repositories;
  }

  /** Starts an investigation using the repository's server-side default signal. */
  startInvestigation(repositoryId: string): Promise<JobView> {
    return this.#call('start_investigation', { repositoryId }, (value) => (isJobView(value) ? value : undefined));
  }

  getInvestigationResult(jobId: string): Promise<InvestigationResult> {
    return this.#call('get_investigation_result', { jobId }, (value) => (isInvestigationResult(value) ? value : undefined));
  }

  async close(): Promise<void> {
    this.#closed = true;
    const client = this.#client;
    this.#client = undefined;
    if (client) await closeQuietly(client);
  }

  async #call<T>(name: ToolName, args: Record<string, unknown>, parse: (value: unknown) => T | undefined): Promise<T> {
    const client = await this.#session();
    let result: CallToolResult;
    try {
      result = await this.#invoke(client, name, args);
    } catch (error) {
      if (!isConnectionFailure(error)) throw this.#fail(error);
      this.#report(error);
      this.#discard(client);
      result = await this.#retry(name, args);
    }
    return this.#read(result, parse);
  }

  /** The single retry: a fresh connection, one more attempt, and no further retries. */
  async #retry(name: ToolName, args: Record<string, unknown>): Promise<CallToolResult> {
    const client = await this.#session();
    try {
      return await this.#invoke(client, name, args);
    } catch (error) {
      if (isConnectionFailure(error)) this.#discard(client);
      throw this.#fail(error);
    }
  }

  #invoke(client: Client, name: ToolName, args: Record<string, unknown>): Promise<CallToolResult> {
    return client.callTool({ name, arguments: args }, { timeout: this.#timeout });
  }

  #read<T>(result: CallToolResult, parse: (value: unknown) => T | undefined): T {
    if (result.isError === true) throw new McpClientError('tool_error', { detail: this.#publicText(result) });
    const value = result.structuredContent === undefined ? undefined : parse(result.structuredContent);
    if (value === undefined) throw new McpClientError('invalid_response');
    return value;
  }

  /** The current connection, or a new one; concurrent callers share a single connection attempt. */
  async #session(): Promise<Client> {
    if (this.#closed) throw new McpClientError('closed');
    if (this.#client) return this.#client;
    this.#connecting ??= this.#open().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async #open(): Promise<Client> {
    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { versionNegotiation: { mode: 'auto' } });
    const transport = new StreamableHTTPClientTransport(this.#url, { requestInit: { headers: { authorization: `Bearer ${this.#token}` } } });
    try {
      await client.connect(transport, { timeout: this.#timeout });
      const { tools } = await client.listTools(undefined, { timeout: this.#timeout });
      const listed = new Set(tools.map((tool) => tool.name));
      if (!REQUIRED_TOOLS.every((tool) => listed.has(tool))) throw new McpClientError('incompatible_server');
    } catch (error) {
      await closeQuietly(client);
      throw this.#fail(error, 'unavailable');
    }
    if (this.#closed) {
      await closeQuietly(client);
      throw new McpClientError('closed');
    }
    this.#client = client;
    this.#connections += 1;
    return client;
  }

  #discard(client: Client): void {
    if (this.#client === client) this.#client = undefined;
    void closeQuietly(client);
  }

  #fail(error: unknown, fallback: McpClientErrorCode = 'request_failed'): McpClientError {
    if (error instanceof McpClientError) return error;
    this.#report(error);
    if (isAuthenticationFailure(error)) return new McpClientError('unauthorized');
    if (isConnectionFailure(error)) return new McpClientError('unavailable');
    // Raised for JSON-RPC errors and, locally, for structured content that does not match the tool's output schema.
    if (error instanceof ProtocolError) return new McpClientError('invalid_response');
    return new McpClientError(fallback);
  }

  #publicText(result: CallToolResult): string | undefined {
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n')
      .split(this.#token)
      .join('[redacted]')
      .trim();
    return text.length === 0 ? undefined : text.slice(0, MAX_DETAIL_LENGTH);
  }

  #report(error: unknown): void {
    try {
      this.#onError?.(error);
    } catch {
      // Reporting must not change the outcome of a call.
    }
  }
}

function parseEndpoint(value: string | URL): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpClientError('invalid_configuration', { message: 'The MCP URL is not a valid URL.' });
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname));
  if (!secure || url.username !== '' || url.password !== '') {
    throw new McpClientError('invalid_configuration', {
      message: 'The MCP URL must use https, or http on a loopback host, and must not contain credentials.',
    });
  }
  return url;
}

/** The request never got an HTTP response: refused, reset, or the transport was closed. */
function isConnectionFailure(error: unknown): boolean {
  if (error instanceof SdkHttpError) return false;
  if (error instanceof SdkError) {
    return error.code === SdkErrorCode.ConnectionClosed || error.code === SdkErrorCode.NotConnected || error.code === SdkErrorCode.EraNegotiationFailed;
  }
  return error instanceof TypeError && error.message === 'fetch failed';
}

function isAuthenticationFailure(error: unknown): boolean {
  return error instanceof UnauthorizedError || (error instanceof SdkHttpError && (error.status === 401 || error.status === 403));
}

async function closeQuietly(client: Client): Promise<void> {
  try {
    await client.close();
  } catch {
    // The connection is being abandoned either way.
  }
}

const REPOSITORY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const JOB_ID = /^job-[0-9a-f-]{36}$/;
const EVIDENCE_ID = /^ev-[a-z0-9][a-z0-9-]*$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;
const JOB_STATUSES: readonly unknown[] = ['queued', 'running', 'completed', 'failed'] satisfies JobStatus[];
const CLAIM_KINDS: readonly unknown[] = ['observation', 'finding', 'proposal', 'verification'] satisfies GroundedClaimKind[];
const REPAIR_STATUSES: readonly unknown[] = [
  'repaired',
  'baseline_not_red',
  'baseline_inconclusive',
  'worktree_failed',
  'patch_failed',
  'verification_failed',
  'verification_inconclusive',
  'safety_check_failed',
  'error',
  'not_attempted',
] satisfies ReportRepairStatus[];

/** A plain object with exactly the required keys and no keys outside `optional`. */
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (!required.every((key) => keys.includes(key))) return undefined;
  if (!keys.every((key) => required.includes(key) || optional.includes(key))) return undefined;
  return value as Record<string, unknown>;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isMatch(pattern: RegExp): (value: unknown) => value is string {
  return (value: unknown): value is string => typeof value === 'string' && pattern.test(value);
}

function isListOf<T>(value: unknown, check: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every((item) => check(item));
}

function isTimestamp(value: unknown): value is string {
  return isMatch(TIMESTAMP)(value) && !Number.isNaN(Date.parse(value));
}

function isRepositoryView(value: unknown): value is RepositoryView {
  const view = fields(value, ['repositoryId', 'displayName', 'command']);
  return view !== undefined && isMatch(REPOSITORY_ID)(view.repositoryId) && isText(view.displayName) && isText(view.command);
}

function isRepositoryList(value: unknown): value is { repositories: RepositoryView[] } {
  const list = fields(value, ['repositories']);
  return list !== undefined && isListOf(list.repositories, isRepositoryView);
}

function isJobView(value: unknown): value is JobView {
  const job = fields(value, ['jobId', 'repositoryId', 'status', 'createdAt'], ['finishedAt', 'failureReason']);
  return (
    job !== undefined &&
    isMatch(JOB_ID)(job.jobId) &&
    isMatch(REPOSITORY_ID)(job.repositoryId) &&
    JOB_STATUSES.includes(job.status) &&
    isTimestamp(job.createdAt) &&
    (job.finishedAt === undefined || isTimestamp(job.finishedAt)) &&
    (job.failureReason === undefined || isText(job.failureReason))
  );
}

function isProjectedFailure(value: unknown): value is ProjectedFailure {
  const failure = fields(value, ['testFile', 'suite', 'testName']);
  return failure !== undefined && isText(failure.testFile) && isListOf(failure.suite, (item) => typeof item === 'string') && isText(failure.testName);
}

function isGroundedClaim(value: unknown): value is GroundedClaim {
  const claim = fields(value, ['id', 'kind', 'statement', 'evidenceIds', 'actionIds'], ['quote']);
  return (
    claim !== undefined &&
    isText(claim.id) &&
    CLAIM_KINDS.includes(claim.kind) &&
    isText(claim.statement) &&
    isListOf(claim.evidenceIds, isMatch(EVIDENCE_ID)) &&
    claim.evidenceIds.length > 0 &&
    isListOf(claim.actionIds, isText) &&
    (claim.quote === undefined || isText(claim.quote))
  );
}

function isInvestigationOutcome(value: unknown): value is InvestigationOutcome {
  const outcome = fields(value, [
    'investigationId',
    'groundingValid',
    'repairStatus',
    'claims',
    'baselineFailures',
    'affectedFiles',
    'limitations',
    'spokenSummary',
  ]);
  if (
    outcome === undefined ||
    !isText(outcome.investigationId) ||
    typeof outcome.groundingValid !== 'boolean' ||
    !(outcome.repairStatus === null || REPAIR_STATUSES.includes(outcome.repairStatus)) ||
    !isListOf(outcome.claims, isGroundedClaim) ||
    !isListOf(outcome.baselineFailures, isProjectedFailure) ||
    !isListOf(outcome.affectedFiles, isText) ||
    !isListOf(outcome.limitations, isText) ||
    !isText(outcome.spokenSummary)
  ) {
    return false;
  }
  // An ungrounded outcome carries no status, claims, failures, or files.
  return (
    outcome.groundingValid ||
    (outcome.repairStatus === null && outcome.claims.length === 0 && outcome.baselineFailures.length === 0 && outcome.affectedFiles.length === 0)
  );
}

function isInvestigationResult(value: unknown): value is InvestigationResult {
  const result = fields(value, ['job', 'outcome']);
  return result !== undefined && isJobView(result.job) && (result.outcome === null || isInvestigationOutcome(result.outcome));
}
