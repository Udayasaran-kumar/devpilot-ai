# @devpilot/mcp

Self-hosted Model Context Protocol server for DevPilot AI, served over
Streamable HTTP on `http://127.0.0.1:8788/mcp`.

It is a protocol adapter over `@devpilot/service`: three tools
(`list_repositories`, `start_investigation`, `get_investigation_result`),
each one `InvestigationService` call. It does not import the engine or tools,
and callers cannot supply repository paths, commands, planners, or budgets.

- `src/server.ts`: `createDevPilotMcpServer(service)`, the tools and the safe
  error mapping.
- `src/http.ts`: `startMcpHttpServer({ service, port, token, maxBodyBytes })`,
  the loopback `node:http` server with path, method, Host, Origin, and bearer
  checks in front of the SDK handler.
- `src/index.ts`: reads `DEVPILOT_MCP_TOKEN` and `DEVPILOT_MCP_CONFIG`,
  creates the one `InvestigationService`, and starts the server.

Run with `npm run mcp` from the repository root; configuration and the
security model are described in the root README under "MCP server".
