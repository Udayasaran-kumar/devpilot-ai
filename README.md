# DevPilot AI

An evidence-grounded developer agent. Give it a failure signal (a failing test,
CI failure, stack trace, bug report, or log output) and it investigates a real
repository with controlled tools, weighs competing hypotheses against
supporting and contradicting evidence, and only claims a fix is verified after
proving it red-to-green in an isolated git worktree.

Built for the Build, Ship, Shape: Amazon Developer Hackathon.

> Status: foundation only. Domain schemas, the event-sourced engine skeleton,
> tool and planner contracts, and a minimal CLI exist. Real tools, the Bedrock
> planner, MCP server, HTTP API, and web UI are not implemented yet.

## Principles

- **Grounded claims.** Every evidence item has a stable, content-addressed ID
  and a source location. Hypotheses and report claims cite evidence IDs; the
  engine rejects references to evidence that was never collected.
- **Verified, not asserted.** A fix counts as verified only when the failing
  command goes from red to green inside a temporary worktree.
- **Event-sourced.** Every state change is a serializable `InvestigationEvent`.
  State is a pure reduction of the event log, so runs can be streamed, stored,
  and replayed.
- **Bounded.** Investigations run under explicit step and time budgets and
  always end in a terminal state.
- **Incident-agnostic.** No objectives, search terms, hypothesis rules, or
  report text are hardcoded for a specific incident. Strategy comes from
  planners; expected answers live only in evaluation fixtures.

## Architecture

```
apps/
  cli/        Command-line entry point (minimal today)
  mcp/        MCP server (planned)
  api/        HTTP API (planned)
  web/        React web UI (planned)
packages/
  core/       Zod schemas: Signal, Evidence, Hypothesis, InvestigationAction,
              VerificationResult, Report, InvestigationEvent
  tools/      Tool contract (name, description, input/output schemas, run) and registry
  planners/   Planner contract, PlannerDecision schema, RulePlanner placeholder
  engine/     InvestigationState, reducer, InvestigationSession, InvestigationEngine
  eval/       Fixture, GroundTruth, EvaluationResult, Evaluator contracts
fixtures/     Evaluation fixtures (none yet)
tests/        Cross-package integration tests
```

Package dependencies flow one way:

```
core  <-  tools  <-  planners  <-  engine  <-  apps/*
core  <-  eval
```

### Investigation loop

1. The engine emits `investigation_started` with the signal and budget.
2. While the state is not terminal, it checks the step and time budgets, then
   asks the planner for the next `PlannerDecision`, validated with Zod:
   - `act`: emit `action_planned`, validate the tool input, run the tool,
     validate its output and evidence, then emit `action_completed` or
     `action_failed`.
   - `update_hypotheses`: verify every cited evidence ID exists, then emit
     `hypotheses_updated`.
   - `finish`: emit `investigation_completed`.
3. Terminal statuses are `completed`, `step_budget_exhausted`,
   `time_budget_exhausted`, and `failed`.

Each event passes through `reduceInvestigation`, which enforces gapless
sequence numbers and refuses events after a terminal state.

## Getting started

Requires Node.js 22 or newer.

```sh
npm install
npm run cli
```

## Scripts

| Command             | Description                                  |
| ------------------- | -------------------------------------------- |
| `npm run cli`       | Run the CLI                                  |
| `npm test`          | Run all tests with `node:test` via `tsx`     |
| `npm run typecheck` | Type-check every package and test with `tsc` |
| `npm run check`     | Typecheck, then test                         |

Workspace packages are consumed directly from TypeScript source through their
`exports` field; there is no build step yet.

## License

MIT
