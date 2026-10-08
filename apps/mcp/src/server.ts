import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import {
  InvestigationResultSchema,
  JobLookupInputSchema,
  JobViewSchema,
  ListRepositoriesInputSchema,
  RepositoryListSchema,
  ServiceError,
  StartInvestigationInputSchema,
  type InvestigationResult,
  type InvestigationService,
  type JobView,
  type RepositoryList,
  type ServiceErrorCode,
} from '@devpilot/service';

export const SERVER_NAME = 'devpilot';
export const SERVER_VERSION = '0.1.0';

export const UNEXPECTED_ERROR_TEXT = 'DevPilot could not complete the request.';

/** The only error text a client sees. Service messages and exception messages never reach the response. */
export const PUBLIC_ERROR_TEXT: Readonly<Record<ServiceErrorCode, string>> = {
  invalid_input: 'The arguments are not valid for this tool.',
  unknown_repository: 'No repository is registered under that ID. Call list_repositories for the available IDs.',
  repository_busy: 'That repository already has an investigation in progress. Poll get_investigation_result for its job.',
  signal_required: 'This repository has no default signal. Describe the failure in the signal argument.',
  unknown_job: 'No investigation job has that ID.',
  invalid_registration: UNEXPECTED_ERROR_TEXT,
};

export interface DevPilotMcpServerOptions {
  /** Server-side reporting of exceptions that are not `ServiceError`s; never part of a response. */
  readonly onUnexpectedError?: (error: unknown) => void;
}

/**
 * A protocol adapter over `InvestigationService`: three tools, each one
 * service call. Tool input is validated twice, by the SDK against the same
 * service schema and again by the service.
 */
export function createDevPilotMcpServer(service: InvestigationService, options: DevPilotMcpServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { maxToolInputElements: 64 });
  const respond = <T extends Record<string, unknown>>(call: () => T, describe: (value: T) => string): CallToolResult => {
    try {
      const value = call();
      return { content: [{ type: 'text', text: describe(value) }], structuredContent: value };
    } catch (error) {
      if (error instanceof ServiceError) return toolError(PUBLIC_ERROR_TEXT[error.code] ?? UNEXPECTED_ERROR_TEXT);
      try {
        options.onUnexpectedError?.(error);
      } catch {
        // Reporting must not change the response.
      }
      return toolError(UNEXPECTED_ERROR_TEXT);
    }
  };

  server.registerTool(
    'list_repositories',
    {
      title: 'List repositories',
      description: 'Repositories registered on this DevPilot server, by opaque repository ID, with their verification command.',
      inputSchema: ListRepositoriesInputSchema,
      outputSchema: RepositoryListSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => respond((): RepositoryList => ({ repositories: service.listRepositories() }), describeRepositories),
  );

  server.registerTool(
    'start_investigation',
    {
      title: 'Start investigation',
      description:
        'Start investigating a failure in a registered repository. Returns a job immediately; poll get_investigation_result until it is completed or failed.',
      inputSchema: StartInvestigationInputSchema,
      outputSchema: JobViewSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => respond((): JobView => service.startInvestigation(input), describeJob),
  );

  server.registerTool(
    'get_investigation_result',
    {
      title: 'Get investigation result',
      description: 'The status of an investigation job and, once it has completed, its grounded result.',
      inputSchema: JobLookupInputSchema,
      outputSchema: InvestigationResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => respond((): InvestigationResult => service.getResult(input), describeResult),
  );

  return server;
}

function toolError(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function describeRepositories({ repositories }: RepositoryList): string {
  if (repositories.length === 0) return 'No repositories are registered.';
  return `${repositories.length} registered: ${repositories.map((repository) => `${repository.repositoryId} (${repository.displayName})`).join(', ')}.`;
}

function describeJob(job: JobView): string {
  switch (job.status) {
    case 'queued':
    case 'running':
      return `Investigation ${job.jobId} for ${job.repositoryId} is ${job.status}. Poll get_investigation_result.`;
    case 'completed':
      return `Investigation ${job.jobId} for ${job.repositoryId} has completed.`;
    case 'failed':
      return `Investigation ${job.jobId} for ${job.repositoryId} failed: ${job.failureReason ?? 'no reason given'}`;
  }
}

function describeResult(result: InvestigationResult): string {
  return result.outcome ? result.outcome.spokenSummary : describeJob(result.job);
}
