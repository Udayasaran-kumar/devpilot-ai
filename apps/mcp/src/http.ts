import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { localhostHostValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { InvestigationService } from '@devpilot/service';
import { createDevPilotMcpServer } from './server.js';

export const MCP_PATH = '/mcp';
export const LOOPBACK_HOST = '127.0.0.1';
export const DEFAULT_MAX_BODY_BYTES = 128 * 1024;
export const MIN_TOKEN_LENGTH = 16;
const MAX_SUBSCRIPTIONS = 4;
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CONNECTIONS = 32;

export interface McpHttpServerOptions {
  /** The one service instance every request is served from. */
  readonly service: InvestigationService;
  /** 0 picks a free port. */
  readonly port: number;
  /** Bearer token clients must present. */
  readonly token: string;
  readonly maxBodyBytes?: number;
  /** Exact origins (`scheme://host[:port]`) a browser-based client may send. Requests without `Origin` are allowed. */
  readonly allowedOrigins?: readonly string[];
  /** Server-side reporting only; nothing passed here reaches a response. */
  readonly onError?: (error: unknown) => void;
}

export interface McpHttpServer {
  /** The MCP endpoint, e.g. `http://127.0.0.1:8788/mcp`. */
  readonly url: URL;
  close(): Promise<void>;
}

export class McpConfigurationError extends Error {
  override readonly name = 'McpConfigurationError';
}

/**
 * Serves the DevPilot MCP server over Streamable HTTP on loopback only.
 * Each request passes, in order: path and method, Host (DNS rebinding),
 * Origin, bearer token, then the SDK handler, which builds a server per
 * request around the same `service`.
 */
export async function startMcpHttpServer(options: McpHttpServerOptions): Promise<McpHttpServer> {
  if (typeof options.token !== 'string' || options.token.length < MIN_TOKEN_LENGTH) {
    throw new McpConfigurationError(`A bearer token of at least ${MIN_TOKEN_LENGTH} characters is required`);
  }
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) throw new McpConfigurationError('maxBodyBytes must be a positive integer');
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map(normalizeOrigin));
  const expectedDigest = digest(options.token);
  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // Reporting must not change the response.
    }
  };

  const { service } = options;
  const handler = createMcpHandler(() => createDevPilotMcpServer(service, { onUnexpectedError: report }), {
    legacy: 'stateless',
    responseMode: 'json',
    maxRequestBodySize: maxBodyBytes,
    maxSubscriptions: MAX_SUBSCRIPTIONS,
    onerror: report,
  });
  const serveMcp = toNodeHandler(handler, { maxRequestBodySize: maxBodyBytes, onerror: report });
  const validateHost = localhostHostValidation();

  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (pathname !== MCP_PATH) return reject(res, 404, 'Not Found');
      if (req.method !== 'POST') return reject(res, 405, 'Method Not Allowed', { allow: 'POST' });
      if (!validateHost(req, res)) return;
      if (!originAllowed(req, allowedOrigins)) return reject(res, 403, 'Forbidden: origin not allowed');
      const authentication = authenticate(req, expectedDigest);
      if (authentication !== 'ok') {
        const challenge = authentication === 'missing' ? 'Bearer' : 'Bearer error="invalid_token"';
        return reject(res, 401, 'Unauthorized', { 'www-authenticate': challenge });
      }
      await serveMcp(req, res);
    } catch (error) {
      report(error);
      if (!res.headersSent) reject(res, 500, 'Internal server error');
      else res.end();
    }
  });
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.maxConnections = MAX_CONNECTIONS;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, LOOPBACK_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  let closing: Promise<void> | undefined;
  return {
    url: new URL(`http://${LOOPBACK_HOST}:${port}${MCP_PATH}`),
    close: () => {
      closing ??= (async () => {
        await handler.close();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      })();
      return closing;
    },
  };
}

function reject(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  const body = JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body);
}

/** No `Origin` (non-browser clients) passes; a present one must be on the allowlist exactly, port included. */
function originAllowed(req: IncomingMessage, allowed: ReadonlySet<string>): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return allowed.has(normalizeOrigin(origin));
  } catch {
    return false;
  }
}

function normalizeOrigin(origin: string): string {
  const parsed = new URL(origin);
  if (parsed.origin === 'null') throw new McpConfigurationError('Opaque origins cannot be allowlisted');
  return parsed.origin;
}

function authenticate(req: IncomingMessage, expected: Buffer): 'ok' | 'missing' | 'invalid' {
  const header = req.headers.authorization;
  if (header === undefined) return 'missing';
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  if (!match?.[1]) return 'invalid';
  return timingSafeEqual(digest(match[1]), expected) ? 'ok' : 'invalid';
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
