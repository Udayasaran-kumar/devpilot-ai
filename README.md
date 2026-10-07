# DevPilot AI

An evidence-grounded developer agent. Give it a failure signal (a failing test,
CI failure, stack trace, bug report, or log output) and it investigates a real
repository with controlled tools, weighs competing hypotheses against
supporting and contradicting evidence, and only claims a fix is verified after
proving it red-to-green in an isolated git worktree.

Built for the Build, Ship, Shape: Amazon Developer Hackathon.

> Status: early. Domain schemas, the event-sourced engine skeleton, planner
> contracts, a minimal CLI, sandboxed repository tools (`read_file`,
> `search_code`, `list_files`, `run_command`), and RED/GREEN verification of
> command results exist. Git worktrees, patching, the Bedrock planner, MCP
> server, HTTP API, and web UI are not implemented yet.

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
  tools/      Tool contract and registry, RepositorySandbox, CommandPolicy, and
              the read_file, search_code, list_files, and run_command tools
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
symlinks and skip `.git`, `.devpilot`, and `node_modules`; binary, non-UTF-8,
and oversized files are never returned.

| Tool          | Observes                                         | Evidence                       |
| ------------- | ------------------------------------------------ | ------------------------------ |
| `read_file`   | A UTF-8 file or inclusive 1-based line range     | One `source_code` item         |
| `search_code` | Case-sensitive literal matches, one per line     | One `search_result` per match  |
| `list_files`  | Sorted recursive listing of files and dirs       | None (structural only)         |
| `run_command` | Exit code, stdout, stderr, timeout of a command  | One `command_output` item      |

Evidence IDs come from `createEvidenceId` over the tool name, the exact
location, and the observed content, so the same observation always has the
same ID. `createDefaultToolRegistry(sandbox)` registers all four tools.

### Command execution

`run_command` takes an argv array (`{ "command": "npm", "args": ["test"] }`)
and never uses a shell. Commands must pass an explicit `CommandPolicy`; the
default allows only `npm test`, optionally followed by `--` and plain script
arguments. The working directory must pass the same sandbox checks as file
paths. Commands get a minimal environment (`PATH`, `HOME`, temp and locale
variables, plus `NO_COLOR` and npm settings that disable network side
effects); secret-looking names such as `AWS_*` or `*_API_KEY` are never
passed, and `PATH` entries that are relative or inside the repository are
removed. Each run has a timeout (default 10s, maximum 30s) that kills the
whole process group, and stdout and stderr are each capped at 64 KiB. The
repository root is replaced with `<repo>` in captured output.

`verifyCommandResult` turns a command result into a `VerificationResult`.
Exit code 0 is GREEN and non-zero is RED, but a RED run only confirms a
reproduction when its output contains text taken from the signal; otherwise
it is `inconclusive`. Timeouts and terminations are `inconclusive`, and
commands that cannot start are `not_run`.

### Isolated worktree workspaces

`GitWorktreeWorkspace.create(repositoryRoot, { allowedRoot })` checks out the
repository's current commit as a detached `git worktree` at
`<repository>/.devpilot/worktrees/<name>`, so files can change there while the
original working tree stays untouched. `getSandbox()` returns a
`RepositorySandbox` rooted at the worktree, so the repository tools and
`run_command` work on it unchanged. `remove()` runs `git worktree remove
--force`, discarding the worktree's changes; it is idempotent.

- The repository must be the top level of a git working tree with at least
  one commit, inside `allowedRoot` after symlinks are resolved.
- `.devpilot` and `.devpilot/worktrees` must be real directories, not symlinks.
  The workspace directory is claimed with an exclusive `mkdir`, so an existing
  path is never reused. A failed `create` removes what it made.
- `.devpilot/.gitignore` (containing `*`) is created if missing, so the
  original repository's `git status` stays clean without editing its own
  `.gitignore`.
- `remove()` only deletes the directory it created, and only while it is
  still a real directory that git lists as a worktree of the repository.
- git runs from internally built argv arrays without a shell, with hooks and
  `core.fsmonitor` disabled and a filtered environment. `resolveGitExecutable`
  probes each `git` on `PATH` with `git --version` and uses the first that
  works, skipping broken shims such as macOS's `/usr/bin/git` before the Xcode
  license is accepted.

Real friction encountered while building this is recorded in
[`HACKATHON_FRICTION_LOG.md`](HACKATHON_FRICTION_LOG.md).

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
