# @devpilot/alexa-simulator

## 1. What it is

A web page for talking to DevPilot the way a developer would talk to a voice
assistant: type "investigate the failing tests", then "what did you find?",
and read what DevPilot would say back, with a result card beside it. The
investigations are real: every answer comes from the DevPilot MCP server
running the grounded repair pipeline on a registered repository.

## 2. An Alexa+ style simulation for the hackathon

This is an Alexa+ style simulation built for the hackathon demo. It is not
an Amazon or Alexa product, does not integrate with Alexa+, and uses no
Amazon branding. There is no microphone, speech recognition, or speech
output; typed text stands in for speech.

## 3. The browser is not an MCP client

The page never speaks MCP. It does not import `@modelcontextprotocol/client`,
does not send `initialize`, `tools/list`, or `tools/call`, and never contacts
the MCP server. Its only requests are to this app's own endpoints:

| Method and path     | Purpose                                                    |
| ------------------- | ---------------------------------------------------------- |
| `GET /`             | The page                                                   |
| `GET /app.js`       | The page's script, bundled from `src/web` at startup       |
| `GET /app.css`      | The page's stylesheet                                      |
| `GET /api/status`   | `{ status: "connected" \| "unavailable" }`: can the backend reach MCP? |
| `POST /api/dialog`  | One conversation turn                                      |

Any other path is 404 and any other method 405. There is no `/mcp` route and
no proxy.

## 4. The simulator backend is the MCP client

```text
Browser
  ↓   same-origin POST /api/dialog { utterance, state }
Simulator /api/dialog
  ↓   VoiceDialog.respond(utterance, state)
VoiceDialog
  ↓
DevPilotMcpClient
  ↓   Streamable HTTP, Authorization: Bearer <token>
DevPilot MCP Server
  ↓
InvestigationService
  ↓
GroundedRepairPipeline
```

The simulator does not proxy or rewrite MCP tool results. Raw MCP results are consumed server-side by the existing DevPilot MCP client and passed through VoiceDialog before any data reaches the browser.

## 5. It uses the existing DevPilotMcpClient

The backend holds one `DevPilotMcpClient` from `apps/voice-demo`, connected
on first use (`src/server/mcp-connection.ts`). That client already
negotiates the protocol, checks every result strictly, reconnects once after
a broken connection, and keeps the token out of errors. The simulator adds
no MCP code of its own.

## 6. VoiceDialog is the presentation-safe boundary

Each `/api/dialog` request is answered by `VoiceDialog.respond` from
`apps/voice-demo`, unchanged. `VoiceDialog` classifies the utterance,
selects the repository, calls the MCP client, interprets the result, and
leaves claims and limitations that mention verification commands,
hypothesis or evidence IDs, workflow states, paths, URLs, or credentials off
the card. It is the only presentation filter: the simulator does not
classify, select, interpret, or filter anything. It checks the request
shape, calls `VoiceDialog`, and returns its response and state unchanged.

## 7. The browser receives only DialogResponse and DialogState

```ts
// POST /api/dialog
request:  { utterance: string, state: DialogState }
response: { response: DialogResponse, state: DialogState }

DialogResponse = { kind, speech, jobId?, card? }
DialogCard     = { repository?, repositories?, jobStatus?, verified?, repairStatus?,
                   claims?, baselineFailures?, affectedFiles?, limitations? }
DialogState    = { repositoryId?, jobId?, investigationStarted }
```

The speech is shown exactly as sent, and the card is rendered field by field.
The browser never receives raw MCP results, `structuredContent`, the
verification command, evidence, hypothesis, or action IDs, or anything
`VoiceDialog` leaves off the card.

The backend refuses a request that is not exactly this shape before calling
`VoiceDialog` (400): the utterance must be a non-blank string of at most 500
characters; the state may hold only `repositoryId` (the MCP server's ID
format), `jobId` (an opaque bounded ID), and `investigationStarted` (a
boolean). Unknown fields, nested objects, and oversized strings are refused,
so credentials, commands, paths, MCP or planner configuration, evidence, and
hypotheses cannot be sent. Requests must also be same-origin (403), JSON
(415), at most 4 KiB (413), and addressed to `127.0.0.1:<port>` or
`localhost:<port>` (403, which blocks DNS rebinding).

Every error response is `{ "error": "Sorry, I couldn't complete that request." }`;
stack traces, MCP errors, URLs, server paths, environment variable names, and
tokens never reach a response. The page shows "Sorry, I couldn't complete
that request." or, when the simulator cannot be reached, "DevPilot is
currently unavailable."

## 8. MCP credentials stay on the server

The MCP URL and token are read from the environment by the backend only.
They are not `VITE_*` variables, not bundled into the page's script (a test
checks the built bundle), never returned in a response, and never logged:
log lines name an error's type, or the MCP client's fixed error text, and
nothing else. The page is served with a content security policy that allows
scripts, styles, and requests from its own origin only.

## 9. Environment variables

| Variable                       | Meaning                                                           |
| ------------------------------ | ----------------------------------------------------------------- |
| `DEVPILOT_MCP_TOKEN`           | Required. The MCP server's bearer token.                          |
| `DEVPILOT_MCP_URL`             | Optional, default `http://127.0.0.1:8788/mcp`.                    |
| `DEVPILOT_SIMULATOR_PORT`      | Optional, default `8790`.                                         |
| `DEVPILOT_DEMO_REPOSITORY_ID`  | Optional. Repository to investigate when the user names none.     |

See `.env.example`. The simulator does not read env files; export the
variables in your shell.

## 10. Starting the MCP server

From the repository root, with a configuration file that registers at least
one repository with a `defaultSignal` (see "MCP server" in the root README):

```sh
export DEVPILOT_MCP_TOKEN="$(openssl rand -hex 32)"
DEVPILOT_MCP_CONFIG=./devpilot-mcp.json npm run mcp
```

The simulator needs no change to the MCP server's `Origin` allowlist: the
browser never contacts it.

## 11. Starting the simulator

In another shell, with the same token:

```sh
export DEVPILOT_MCP_TOKEN="<the MCP server's token>"
npm run simulator
```

Open <http://localhost:8790/>.

The header's indicator shows whether the simulator backend can reach the
DevPilot MCP server, and nothing else:

- **Available**: `GET /api/status` returned `{ "status": "connected" }`. The
  backend made a real `list_repositories` call through its one
  `DevPilotMcpClient`, and it succeeded.
- **Unavailable**: `GET /api/status` returned
  `{ "status": "unavailable" }`, because that call failed (the server is
  down, refused the token, or anything else), or because the simulator
  itself could not be reached. The reason is logged server-side by type
  only and never sent to the browser.

The page checks this when it loads, and again after a failed request; it
does not poll. The investigation's state is shown separately, below the
header: "Investigation in progress" with the repository's name, or "No
active investigation". Having no investigation, or a running one, never
changes the connection indicator.

## 12. Example interaction

```text
You:      investigate the failing tests
DevPilot: Which repository should I investigate? Say "investigate" followed
          by its name: Shop or Quiet.
          [Shop] [Quiet]                       ← choosing sends "Investigate repository shop"
DevPilot: Investigation started for Shop. I'll check the failing tests. Ask
          me what I found in a little while.
          ┌ Investigation in progress ┐
You:      [Check result]                       ← sends "What did you find?"
DevPilot: I'm still investigating. The repair has not been verified yet.
You:      what did you find?
DevPilot: (the MCP server's spoken summary of the verified repair)
          ┌ Verified repair ┐  failing tests, affected files, claims, limitations
```

Starting needs an explicit request; "don't investigate" starts nothing. The
page does not poll: results are fetched only when you ask. Only one request
is in flight at a time, and "Clear conversation" forgets the messages, the
state, and the job. The card is headed "Verified repair", "Repair not
verified", "Investigation in progress", or "Investigation failed", and only
a grounded, repaired result is shown as verified.

## Layout and tests

- `src/server`: `config.ts` (environment), `mcp-connection.ts` (the shared
  client), `request.ts` (request and state validation), `http.ts` (server
  and routes), `assets.ts` (bundles `src/web` with esbuild),
  `simulator.ts` and `main.ts` (wiring and startup).
- `src/web`: `conversation.ts` (conversation controller and its
  `/api/dialog` transport), `view.tsx`, `App.tsx`, `main.tsx`, `index.html`,
  `styles.css`. It imports only `react`, `react-dom/client`, its own files,
  types from `apps/voice-demo/src/dialog.ts`, and the utterance length limit
  from `apps/voice-demo/src/intents.ts`.
- `src` imports `apps/voice-demo` sources by relative path, because that
  package exports only `mcp-client.ts`.

```sh
npm test --workspace @devpilot/alexa-simulator
```

`test/server.test.ts` covers routing and request validation, generic errors,
and the browser bundle's contents. A hostile MCP result, carrying a
verification command, hypothesis, evidence, and action IDs, a host path,
workflow states, and a bearer token, is passed through the real
`VoiceDialog`, and the HTTP response bodies are checked to contain none of
it. An end-to-end test runs the real MCP server over a git fixture, chooses
a repository, starts an investigation, and reads the verified result through
`/api/dialog`, then checks that no raw MCP detail, token, MCP URL, or host
path reached the browser. `GET /api/status` is checked against a real MCP
server that is running, then stopped, and one that refuses the token; its
body is always exactly `{"status":"connected"}` or
`{"status":"unavailable"}`. `test/ui.test.ts` covers the page: empty state,
Available and Unavailable, the investigation status kept apart from the
connection, messages, cards, verified styling, repository choices, generic
errors, clear, Check result, one request at a time, and no polling.
