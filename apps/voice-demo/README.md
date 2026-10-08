# @devpilot/voice-demo

Voice-style demonstration client for DevPilot AI. It reaches DevPilot only
through the self-hosted MCP server (`@devpilot/mcp`) over Streamable HTTP, so
the demo exercises the same boundary any other MCP client would.

So far it contains the server-side MCP client and the dialog layer. There is
no browser UI, HTTP server, or speech yet.

- `src/mcp-client.ts`: `DevPilotMcpClient.connect({ url, token })`, with
  `listRepositories()`, `startInvestigation(repositoryId)`, and
  `getInvestigationResult(jobId)`.
- `src/intents.ts`: `classifyIntent(utterance)`, fixed phrase patterns for
  `START_INVESTIGATION`, `GET_RESULT`, and `HELP` (everything else).
- `src/dialog.ts`: `new VoiceDialog(client, { repositoryId })` and
  `respond(utterance, state)`, which returns `{ intent, response, state }`.
  The response is `{ kind, speech, jobId?, card? }`; the state is
  `{ repositoryId, jobId, investigationStarted }` and holds no credentials.

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

## Dialog

- **Starting is explicit.** Starting an investigation has side effects, so a
  start phrase preceded by a negation ("don't investigate", "let's not
  investigate", "no, investigate"), followed by one ("investigate nothing"),
  or preceded by a question about whether to start ("should I investigate?")
  is treated as a request for help. A negation in what to investigate, as in
  "investigate why the tests do not pass", is not.
- **Repository:** one named in the utterance (by ID or display name), then the
  one this conversation already investigated, then the configured
  `DEVPILOT_DEMO_REPOSITORY_ID`, then the only registered repository. With
  several and no selection, the dialog asks the user to choose.
- **Speech** is fixed text or the server's `spokenSummary`; the dialog never
  describes a result itself. A verified repair (grounded, status `repaired`)
  is spoken exactly as the server summarised it. Any other completed result
  starts with "The investigation finished, but DevPilot did not verify a
  repair." followed by the server's summary.
- **Cards** present the server's result without changing it: claims and
  limitations that mention the verification command, hypothesis or evidence
  IDs, review states, paths outside the repository, URLs, or credential-like
  values are left off, and the rest are shown exactly as the server wrote
  them. Nothing is reworded or added in their place.
- **Refusals:** a busy repository is reported without claiming a new start,
  and the current job is kept. An unknown job (for example, after a server
  restart) is reported as no longer available. The server sends no error
  codes, so these are recognised by its exact public text
  (`SERVER_REFUSAL_TEXT`); anything else, and every other error, gets the
  generic "Sorry, I couldn't complete that request."

## Boundaries

The source imports only `@modelcontextprotocol/client` and Node built-ins:
no `@devpilot/*` package, no MCP server packages, no `child_process`. Only
`mcp-client.ts` imports the SDK; the dialog reaches DevPilot through it, and
the classifier imports nothing. A test enforces this.

The tests start the real MCP server (`startMcpHttpServer`) on an ephemeral
port over a git fixture repository, and use a loopback relay in front of it
to rewrite responses or cut connections.
