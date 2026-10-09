import { startMcpHttpServer } from '@devpilot/mcp';
import { EscalatingPlanner, type EscalationEvent, type ModelClient } from '@devpilot/planner-bedrock';
import { InvestigationService, type InvestigationServiceOptions, type RepositoryRegistry } from '@devpilot/service';

/** Trusted configuration from whoever runs the host; MCP callers cannot set any of it. */
export interface DevPilotHostOptions {
  readonly registry: RepositoryRegistry;
  /** Asked only when the rule planner gives up without a hypothesis. */
  readonly model: ModelClient;
  /** Bearer token MCP clients must present. */
  readonly token: string;
  /** 0 picks a free port. */
  readonly port: number;
  /** Exact origins a browser-based client may send. */
  readonly allowedOrigins?: readonly string[];
  readonly git?: InvestigationServiceOptions['git'];
  readonly modelTimeoutMs?: number;
  readonly maxModelCalls?: number;
  /** Server-side reporting only; nothing passed here reaches a response. */
  readonly onError?: (error: unknown) => void;
  /** Server-side escalation diagnostics only; nothing passed here reaches a response. */
  readonly onEscalation?: (event: EscalationEvent) => void;
}

export interface DevPilotHost {
  /** The MCP endpoint on loopback, e.g. `http://127.0.0.1:8788/mcp`. */
  readonly url: URL;
  /** Shared by every job, for model call counts and the fallback latch. */
  readonly planner: EscalatingPlanner;
  close(): Promise<void>;
}

/**
 * Builds one escalating planner and one `InvestigationService` around it, and
 * serves that service with the unchanged MCP server: same loopback binding,
 * Host, Origin, and bearer checks, same tools and result projection.
 */
export async function startDevPilotHost(options: DevPilotHostOptions): Promise<DevPilotHost> {
  const planner = new EscalatingPlanner({
    model: options.model,
    ...(options.modelTimeoutMs !== undefined ? { timeoutMs: options.modelTimeoutMs } : {}),
    ...(options.maxModelCalls !== undefined ? { maxModelCalls: options.maxModelCalls } : {}),
    ...(options.onEscalation ? { onEvent: options.onEscalation } : {}),
  });
  const service = new InvestigationService({ registry: options.registry, planner, ...(options.git ? { git: options.git } : {}) });
  const server = await startMcpHttpServer({
    service,
    port: options.port,
    token: options.token,
    ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });
  return { url: server.url, planner, close: () => server.close() };
}
