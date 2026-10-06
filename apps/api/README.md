# @devpilot/api (planned)

HTTP API over the DevPilot AI investigation engine, primarily serving the web UI
and CI integrations.

Planned responsibilities:

- Accept signals (failing test output, CI logs, stack traces, bug reports) and
  start investigations.
- Stream `InvestigationEvent`s to clients (for example via Server-Sent Events).
- Serve final reports, evidence, and verification results.
- Validate every request and response with the `@devpilot/core` Zod schemas.
- Reuse `@devpilot/engine` directly; contain no investigation logic of its own.

Not implemented yet.
