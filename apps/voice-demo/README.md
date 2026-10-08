# @devpilot/voice-demo

Voice-style demonstration client for DevPilot AI. It reaches DevPilot only
through the self-hosted MCP server (`@devpilot/mcp`) over Streamable HTTP, so
the demo exercises the same boundary any other MCP client would.

This checkpoint contains only the server-side MCP client. There is no browser
UI, HTTP server, speech, or intent handling yet.

- `src/mcp-client.ts`: `DevPilotMcpClient.connect({ url, token })`, with
  `listRepositories()`, `startInvestigation(repositoryId)`, and
  `getInvestigationResult(jobId)`.

```ts
const devpilot = await DevPilotMcpClient.connect({ url: 'http://127.0.0.1:8788/mcp', token: process.env.DEVPILOT_MCP_TOKEN! });
const [repository] = await devpilot.listRepositories();
const job = await devpilot.startInvestigation(repository.repositoryId);
const { job: status, outcome } = await devpilot.getInvestigationResult(job.jobId);
```

`startInvestigation` sends only the repository ID, so the repository must have
a `defaultSignal` in the MCP server's configuration.

## Behaviour

- **One connection, reused.** `connect` negotiates the protocol era
  (`versionNegotiation: { mode: 'auto' }`), then calls `listTools()` and
  refuses a server that does not list the three DevPilot tools. The tool list
  also lets the SDK check each result against the tool's output schema.
- **Checked results.** A tool error (`isError`) becomes
  `McpClientError('tool_error')`, with the server's public text in `detail`.
  Structured content is checked again against the expected shape, strictly:
  unknown fields, malformed IDs, and ungrounded outcomes that carry claims are
  refused as `invalid_response`.
- **One reconnect.** If a call fails because the connection broke (for example,
  the MCP server restarted), the client reconnects and retries that call once.
  If that also fails, the call fails with `unavailable`. Concurrent callers
  share one reconnect. Tool errors, invalid responses, authentication
  failures, and timeouts are not retried. A retried `startInvestigation`
  cannot start a second job: the server refuses a second investigation of a
  busy repository.
- **The token stays in the Authorization header.** It is never logged, never
  part of an error, and removed from any server text placed in `detail`.
  `McpClientError` messages are fixed text (`CLIENT_ERROR_TEXT`); underlying
  errors go only to the optional `onError` callback. Plain `http` is accepted
  for loopback hosts only, and URLs with embedded credentials are refused.

## Boundaries

The source imports only `@modelcontextprotocol/client` and Node built-ins:
no `@devpilot/*` package, no MCP server packages, no `child_process`. A test
enforces this.

The tests start the real MCP server (`startMcpHttpServer`) on an ephemeral
port over a git fixture repository, and use a loopback relay in front of it
to rewrite responses or cut connections.
