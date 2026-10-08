import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DialogResponse, DialogState, VoiceDialog } from '../../../voice-demo/src/dialog.js';
import type { StaticAssets } from './assets.js';
import { MAX_BODY_BYTES, parseDialogRequest } from './request.js';

export const LOOPBACK_HOST = '127.0.0.1';
/** The body of every error response. */
export const PUBLIC_ERROR_TEXT = "Sorry, I couldn't complete that request.";
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_CONNECTIONS = 64;

export interface SimulatorServerOptions {
  /** Produces every reply; this layer only checks the request and returns `{ response, state }`. */
  readonly dialog: Pick<VoiceDialog, 'respond'>;
  /**
   * Whether this backend can reach the DevPilot MCP server right now, for the
   * browser's connection indicator. A rejection counts as unreachable.
   */
  readonly available: () => Promise<boolean>;
  readonly assets: StaticAssets;
  /** 0 picks a free port. */
  readonly port: number;
  /** Server-side reporting only; nothing passed here reaches a response. */
  readonly onError?: (error: unknown) => void;
}

export interface SimulatorServer {
  readonly url: URL;
  close(): Promise<void>;
}

/** Everything `POST /api/dialog` returns: the dialog's response and the next conversation state. */
export interface DialogExchange {
  readonly response: DialogResponse;
  readonly state: DialogState;
}

export interface ConnectionReport {
  readonly status: 'connected' | 'unavailable';
}

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

/**
 * Serves the simulator on loopback only: the page, its script and
 * stylesheet, `GET /api/status`, and `POST /api/dialog`. Every request is
 * checked in order: Host (DNS rebinding), path, and method; dialog requests
 * must also be same-origin JSON within the size limit.
 */
export async function startSimulatorServer(options: SimulatorServerOptions): Promise<SimulatorServer> {
  const { dialog, available, assets } = options;
  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // Reporting must not change the response.
    }
  };

  const routes: Readonly<Record<string, { readonly method: 'GET' | 'POST'; readonly handle: Handler }>> = {
    '/': { method: 'GET', handle: (_req, res) => send(res, 200, 'text/html; charset=utf-8', assets.html, { 'content-security-policy': CONTENT_SECURITY_POLICY }) },
    '/app.js': { method: 'GET', handle: (_req, res) => send(res, 200, 'text/javascript; charset=utf-8', assets.script) },
    '/app.css': { method: 'GET', handle: (_req, res) => send(res, 200, 'text/css; charset=utf-8', assets.styles) },
    '/api/status': {
      method: 'GET',
      handle: async (_req, res) => {
        const connected = await available().catch((error: unknown) => {
          report(error);
          return false;
        });
        sendJson(res, 200, { status: connected ? 'connected' : 'unavailable' } satisfies ConnectionReport);
      },
    },
    '/api/dialog': {
      method: 'POST',
      handle: async (req, res) => {
        if (!sameOrigin(req)) return sendError(res, 403);
        if (!isJson(req.headers['content-type'])) return sendError(res, 415);
        const body = await readBody(req);
        if (body === undefined) return sendError(res, 413);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          return sendError(res, 400);
        }
        const request = parseDialogRequest(parsed);
        if (!request) return sendError(res, 400);
        const { response, state } = await dialog.respond(request.utterance, request.state);
        sendJson(res, 200, { response, state } satisfies DialogExchange);
      },
    },
  };

  let allowedHosts: ReadonlySet<string> = new Set();
  const server = createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(req.headers.host ?? '')) return sendError(res, 403);
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      const route = Object.hasOwn(routes, pathname) ? routes[pathname] : undefined;
      if (!route) return sendError(res, 404);
      if (req.method !== route.method) return sendError(res, 405, { allow: route.method });
      await route.handle(req, res);
    } catch (error) {
      report(error);
      if (!res.headersSent) sendError(res, 500);
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
  allowedHosts = new Set([`${LOOPBACK_HOST}:${port}`, `localhost:${port}`]);

  let closing: Promise<void> | undefined;
  return {
    url: new URL(`http://${LOOPBACK_HOST}:${port}/`),
    close: () => {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

/** A browser always sends `Origin` on a POST; when present it must be this server's own origin. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return origin === undefined || origin === `http://${req.headers.host}`;
}

function isJson(contentType: string | undefined): boolean {
  return /^application\/json\s*(;|$)/i.test(contentType ?? '');
}

/** The body as text, or undefined when it is larger than `MAX_BODY_BYTES`. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
    req.resume();
    return undefined;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size <= MAX_BODY_BYTES) chunks.push(buffer);
  }
  return size > MAX_BODY_BYTES ? undefined : Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, contentType: string, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': contentType, ...headers });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value), headers);
}

function sendError(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  sendJson(res, status, { error: PUBLIC_ERROR_TEXT }, headers);
}
