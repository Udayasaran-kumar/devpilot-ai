import { dialogConfigFromEnvironment, type DialogConfig } from '../../../voice-demo/src/dialog.js';

export const DEFAULT_MCP_URL = 'http://127.0.0.1:8788/mcp';
export const DEFAULT_PORT = 8790;

/** The environment variables the simulator reads. All of them stay on the server. */
export interface SimulatorEnvironment {
  readonly DEVPILOT_MCP_URL?: string | undefined;
  readonly DEVPILOT_MCP_TOKEN?: string | undefined;
  readonly DEVPILOT_SIMULATOR_PORT?: string | undefined;
  readonly DEVPILOT_DEMO_REPOSITORY_ID?: string | undefined;
}

export interface SimulatorConfig {
  readonly mcpUrl: string;
  readonly mcpToken: string;
  readonly port: number;
  readonly dialog: DialogConfig;
}

/** Messages name the setting, never its value. */
export class SimulatorConfigurationError extends Error {
  override readonly name = 'SimulatorConfigurationError';
}

export function configFromEnvironment(env: SimulatorEnvironment): SimulatorConfig {
  const mcpToken = env.DEVPILOT_MCP_TOKEN ?? '';
  if (mcpToken === '') throw new SimulatorConfigurationError('DEVPILOT_MCP_TOKEN is required');
  const rawPort = env.DEVPILOT_SIMULATOR_PORT ?? '';
  const port = rawPort === '' ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new SimulatorConfigurationError('DEVPILOT_SIMULATOR_PORT must be a port number');
  return {
    mcpUrl: env.DEVPILOT_MCP_URL || DEFAULT_MCP_URL,
    mcpToken,
    port,
    dialog: dialogConfigFromEnvironment({ DEVPILOT_DEMO_REPOSITORY_ID: env.DEVPILOT_DEMO_REPOSITORY_ID }),
  };
}
