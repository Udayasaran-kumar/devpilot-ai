# @devpilot/mcp (planned)

Model Context Protocol server that exposes the DevPilot AI investigation engine
to MCP-capable clients (IDEs, coding agents).

Planned responsibilities:

- Expose investigation entry points (submit a signal, run or resume an
  investigation) as MCP tools.
- Stream `InvestigationEvent`s back to the client as progress notifications.
- Expose reports and evidence as MCP resources addressable by evidence ID.
- Reuse `@devpilot/engine` directly; contain no investigation logic of its own.

Not implemented yet.
