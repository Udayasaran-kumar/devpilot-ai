import { VoiceDialog } from '../../../voice-demo/src/dialog.js';
import { McpClientError } from '../../../voice-demo/src/mcp-client.js';
import { buildAssets, type StaticAssets } from './assets.js';
import { SimulatorConfigurationError, type SimulatorConfig } from './config.js';
import { startSimulatorServer, type SimulatorServer } from './http.js';
import { McpConnection } from './mcp-connection.js';

export interface Simulator extends SimulatorServer {
  /** Whether the DevPilot MCP server is reachable. */
  available(): Promise<boolean>;
}

export interface StartSimulatorOptions {
  /** Built once at startup when omitted. */
  readonly assets?: StaticAssets;
  /** Server-side reporting only; see `describeError` for what is safe to print. */
  readonly onError?: (error: unknown) => void;
}

/**
 * The production path: `VoiceDialog` over the existing `DevPilotMcpClient`,
 * served to the browser by `startSimulatorServer`. The browser receives only
 * what `VoiceDialog` returns.
 */
export async function startSimulator(config: SimulatorConfig, options: StartSimulatorOptions = {}): Promise<Simulator> {
  const { onError } = options;
  const connection = new McpConnection({ url: config.mcpUrl, token: config.mcpToken, ...(onError ? { onError } : {}) });
  const dialog = new VoiceDialog(connection, config.dialog);
  const assets = options.assets ?? (await buildAssets());
  const server = await startSimulatorServer({ dialog, available: () => connection.available(), assets, port: config.port, ...(onError ? { onError } : {}) });
  return {
    url: server.url,
    available: () => connection.available(),
    close: async () => {
      await server.close();
      await connection.close();
    },
  };
}

/**
 * A log line for an error. Only the simulator's and the MCP client's own
 * fixed messages are printed; anything else is named by its type, because
 * an underlying message may contain a URL or a server response.
 */
export function describeError(error: unknown): string {
  if (error instanceof SimulatorConfigurationError || error instanceof McpClientError) return `${error.name}: ${error.message}`;
  return error instanceof Error ? error.name : 'unknown error';
}
