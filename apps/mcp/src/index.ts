import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { InvestigationService, RepositoryRegistry, ServiceError, type RepositoryRegistration } from '@devpilot/service';
import { McpConfigurationError, startMcpHttpServer, type McpHttpServer } from './http.js';

export * from './server.js';
export * from './http.js';

export const DEFAULT_PORT = 8788;

/** The environment variables the server reads; nothing else configures it. */
export interface McpEnvironment {
  readonly DEVPILOT_MCP_TOKEN?: string | undefined;
  readonly DEVPILOT_MCP_CONFIG?: string | undefined;
  readonly DEVPILOT_MCP_PORT?: string | undefined;
  /** Comma-separated exact origins allowed for browser-based clients. */
  readonly DEVPILOT_MCP_ALLOWED_ORIGINS?: string | undefined;
}

/**
 * Reads the server-side repository configuration:
 * `{ "repositories": [{ repositoryId, displayName, repositoryRoot, allowedRoot?, verification, defaultSignal? }] }`.
 * Relative roots are resolved against the configuration file's directory.
 */
export async function loadRegistry(configPath: string): Promise<RepositoryRegistry> {
  const file = path.resolve(configPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw new McpConfigurationError(`Cannot read the repository configuration at ${file}`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.repositories) || Object.keys(parsed).some((key) => key !== 'repositories')) {
    throw new McpConfigurationError('The repository configuration must be { "repositories": [...] }');
  }
  const registry = new RepositoryRegistry();
  const base = path.dirname(file);
  for (const entry of parsed.repositories) {
    if (!isRecord(entry)) throw new McpConfigurationError('Each repository entry must be an object');
    const registration = { ...entry };
    for (const key of ['repositoryRoot', 'allowedRoot'] as const) {
      const value = registration[key];
      if (typeof value === 'string') registration[key] = path.resolve(base, value);
    }
    try {
      registry.register(registration as unknown as RepositoryRegistration);
    } catch (error) {
      if (error instanceof ServiceError) throw new McpConfigurationError(`Invalid repository configuration: ${error.message}`);
      throw error;
    }
  }
  return registry;
}

/** Builds the one `InvestigationService` this process serves and starts the HTTP server around it. */
export async function startFromEnvironment(env: McpEnvironment, onError?: (error: unknown) => void): Promise<McpHttpServer> {
  const token = env.DEVPILOT_MCP_TOKEN;
  if (!token) throw new McpConfigurationError('DEVPILOT_MCP_TOKEN is required');
  if (!env.DEVPILOT_MCP_CONFIG) throw new McpConfigurationError('DEVPILOT_MCP_CONFIG must name the repository configuration file');
  const port = env.DEVPILOT_MCP_PORT === undefined || env.DEVPILOT_MCP_PORT === '' ? DEFAULT_PORT : Number(env.DEVPILOT_MCP_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new McpConfigurationError('DEVPILOT_MCP_PORT must be a port number');
  const allowedOrigins = (env.DEVPILOT_MCP_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  const registry = await loadRegistry(env.DEVPILOT_MCP_CONFIG);
  const service = new InvestigationService({ registry });
  return startMcpHttpServer({ service, port, token, allowedOrigins, ...(onError ? { onError } : {}) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
}

async function main(): Promise<void> {
  try {
    const server = await startFromEnvironment(process.env, (error) => console.error(`[devpilot-mcp] ${describeError(error)}`));
    console.log(`DevPilot MCP server listening on ${server.url.href}`);
    const shutdown = () => {
      server.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    console.error(`[devpilot-mcp] ${error instanceof McpConfigurationError ? error.message : describeError(error)}`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href) await main();
