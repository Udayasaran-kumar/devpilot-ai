# @devpilot/host

Composition root for DevPilot AI with the rules-first, model-escalation
planner. `startDevPilotHost({ registry, model, token, port })` builds one
`EscalatingPlanner` around the given `ModelClient`, one `InvestigationService`
with that planner, and serves it with `startMcpHttpServer` from
`@devpilot/mcp`, unchanged: loopback only, with the same Host, Origin, and
bearer checks, tools, and result projection.

There is no launcher or model client here yet. Tests inject a deterministic
fake model; `npm run mcp` remains the rules-only server.
