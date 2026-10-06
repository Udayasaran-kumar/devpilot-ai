# DevPilot AI

An evidence-grounded developer agent. Give it a failure signal (a failing test,
CI failure, stack trace, bug report, or log output) and it investigates a real
repository with controlled tools, weighs competing hypotheses against
supporting and contradicting evidence, and only claims a fix is verified after
proving it red-to-green in an isolated git worktree.

Built for the Build, Ship, Shape: Amazon Developer Hackathon.

> Status: early. Domain schemas, the event-sourced engine skeleton, planner
> contracts, a minimal CLI, and sandboxed read-only repository tools
> (`read_file`, `search_code`, `list_files`) exist. Command execution, git
> worktrees, the Bedrock planner, MCP server, HTTP API, and web UI are not
> implemented yet.

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
  tools/      Tool contract and registry, RepositorySandbox, and the read-only
              read_file, search_code, and list_files tools
  planners/   Planner contract, PlannerDecision schema, RulePlanner placeholder
  engine/     InvestigationState, reducer, InvestigationSession, InvestigationEngine
  eval/       Fixture, GroundTruth, EvaluationResult, Evaluator contracts
fixtures/     Sample repositories used by tests and evaluation
tests/        Cross-package integration tests
```

### Repository tools

All filesystem access goes through a `RepositorySandbox` bound to one
repository root. Each requested path is checked lexically, then resolved with
`realpath` and checked again against the canonical root using path-relative
comparison (not string prefixes), so `../` traversal, outside absolute paths,
and symlinks that escape the root are rejected. Directory walks never follow
symlinks and skip `.git` and `node_modules`; binary, non-UTF-8, and oversized
files are never returned.

| Tool          | Observes                                         | Evidence                       |
| ------------- | ------------------------------------------------ | ------------------------------ |
| `read_file`   | A UTF-8 file or inclusive 1-based line range     | One `source_code` item         |
| `search_code` | Case-sensitive literal matches, one per line     | One `search_result` per match  |
| `list_files`  | Sorted recursive listing of files and dirs       | None (structural only)         |

Evidence IDs come from `createEvidenceId` over the tool name, the exact file
location, and the observed content, so the same observation always has the
same ID. `createDefaultToolRegistry(sandbox)` registers all three tools.

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
