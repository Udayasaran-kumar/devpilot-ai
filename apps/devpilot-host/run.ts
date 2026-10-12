import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { loadRegistry } from '@devpilot/mcp';
import { createBedrockModelClient } from '@devpilot/planner-bedrock/bedrock';
import { startDevPilotHost } from '@devpilot/host';

async function main(): Promise<void> {
  const env = process.env;

  if (env.DEVPILOT_LIVE_BEDROCK !== '1') {
    throw new Error('Set DEVPILOT_LIVE_BEDROCK=1 to enable live Bedrock.');
  }
  const token = env.DEVPILOT_MCP_TOKEN;
  const configPath = env.DEVPILOT_MCP_CONFIG;
  if (!token || token.length < 16) throw new Error('DEVPILOT_MCP_TOKEN must be at least 16 characters.');
  if (!configPath) throw new Error('DEVPILOT_MCP_CONFIG is required.');

  const port = env.DEVPILOT_MCP_PORT ? Number(env.DEVPILOT_MCP_PORT) : 8788;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid DEVPILOT_MCP_PORT.');

  const model = createBedrockModelClient(env);
  if (!model) throw new Error('Bedrock client unavailable; refusing to start.');

  const registry = await loadRegistry(configPath);
  const allowedOrigins = (env.DEVPILOT_MCP_ALLOWED_ORIGINS ?? '')
    .split(',').map((origin) => origin.trim()).filter(Boolean);

  const host = await startDevPilotHost({
    registry, model, token, port, maxModelCalls: 1,
    ...(allowedOrigins.length ? { allowedOrigins } : {}),
    onError: (error) => console.error(
      `[devpilot-host] Request failed (${error instanceof Error ? error.name : 'Error'}).`,
    ),
    onEscalation: (event) => console.log(`[devpilot-host] Escalation event: ${event.type}`),
  });

  console.log(`[devpilot-host] Listening at ${host.url.href}`);
  console.log('[devpilot-host] Live Bedrock enabled; model-call budget: 1.');

  const shutdown = () => {
    void host.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  main().catch((error: unknown) => {
    console.error(`[devpilot-host] Startup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exitCode = 1;
  });
}
