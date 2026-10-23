# DevPilot AI

**Evidence-grounded autonomous software repair.**

DevPilot takes a software failure signal—such as a failing test, CI failure, stack trace, bug report, or log output—and investigates the repository using controlled tools.

It collects evidence, evaluates competing hypotheses, proposes a minimal patch, reviews that proposal, and only considers a repair successful after reproducing the failure and proving the same failure is resolved in an isolated Git worktree.

The core repair path is:

**INCIDENT → EVIDENCE → HYPOTHESES → PROPOSAL → REVIEW → RED → PATCH → GREEN → GROUNDED REPORT**

Built for the **Build, Ship, Shape: Amazon Developer Hackathon**.

---

## Why DevPilot?

AI coding agents can produce plausible fixes without proving that the fix actually addresses the reported failure.

DevPilot takes a different approach:

- **Evidence before conclusions**
- **Rules before model escalation**
- **Competing hypotheses instead of a single guess**
- **Proposal review before modification**
- **Isolated worktree repair**
- **Failure-specific verification**
- **Original repository protection**
- **Replayable, grounded investigation state**

A repair is not accepted merely because a command exits with code `0`.

The specific failure observed during the RED baseline must also be demonstrated as passing after the patch.

---

## Core Principles

### Grounded claims

Every evidence item has a stable, content-addressed ID and a source location.

Hypotheses and report claims cite evidence IDs, and the engine rejects references to evidence that was never collected.

### Verified, not asserted

A fix counts as verified only when the failing command goes from RED to GREEN inside a temporary worktree, and the specific tests that failed are observed passing.

### Event-sourced

Every state change is represented as an `InvestigationEvent`.

State is derived by reducing the event log, allowing investigations to be serialized, replayed, streamed, and validated.

### Bounded

Investigations operate under explicit step and time budgets and terminate in a defined state.

### Incident-agnostic

The investigation engine does not hardcode the answer to a particular incident.

Strategy comes from planners; expected answers exist only in evaluation fixtures.

---

## Architecture

```text
apps/
  cli/        Command-line entry point
  mcp/        Self-hosted MCP server over the service layer
  api/        HTTP API
  web/        React web UI

packages/
  core/       Zod schemas for investigation data
  tools/      Repository tools, sandbox and command policy
  planners/   Planner contract and deterministic RulePlanner
  engine/     Investigation engine, repair workflow and grounding
  service/    Transport-free investigation orchestration
  eval/       Evaluation and ground-truth contracts

fixtures/     Sample repositories used by tests and evaluation
tests/        Cross-package integration tests
```

The current working system is centered around the service, planner, repair engine, and self-hosted MCP/host composition.

---

## Investigation Flow

```text
                 ┌─────────────────────┐
                 │    Failure Signal   │
                 │ test / CI / logs    │
                 └──────────┬──────────┘
                            │
                            ▼
                 ┌─────────────────────┐
                 │     Evidence       │
                 │ read/search/run    │
                 └──────────┬──────────┘
                            │
                            ▼
                 ┌─────────────────────┐
                 │     Hypotheses      │
                 │ evidence grounded   │
                 └──────────┬──────────┘
                            │
                    ┌───────┴────────┐
                    │                │
             Rule-solvable       Uncertain
                    │                │
                    │                ▼
                    │        ┌───────────────┐
                    │        │ Model         │
                    │        │ Escalation    │
                    │        └───────┬───────┘
                    │                │
                    └────────┬───────┘
                             ▼
                    ┌─────────────────┐
                    │ Patch Proposal  │
                    └────────┬────────┘
                             ▼
                    ┌─────────────────┐
                    │ Proposal Review │
                    └────────┬────────┘
                             ▼
                    ┌─────────────────┐
                    │ RED baseline    │
                    └────────┬────────┘
                             ▼
                    ┌─────────────────┐
                    │ Isolated        │
                    │ Git worktree    │
                    └────────┬────────┘
                             ▼
                    ┌─────────────────┐
                    │ Apply Patch     │
                    └────────┬────────┘
                             ▼
                    ┌─────────────────┐
                    │ GREEN           │
                    │ same failure    │
                    │ now passes      │
                    └────────┬────────┘
                             ▼
                    ┌─────────────────┐
                    │ Grounded Report │
                    └─────────────────┘
```

---

## Repository Safety

All filesystem access goes through a `RepositorySandbox` bound to a repository root.

Requested paths are checked before and after resolution, preventing:

- `../` traversal
- outside absolute paths
- symlink escapes

Directory walks do not follow symlinks and skip `.git`, `.devpilot`, and `node_modules`.

Binary, non-UTF-8, and oversized files are not returned as repository evidence.

---

## Controlled Command Execution

`run_command` receives an argument vector rather than a shell command.

For example:

```text
{
  "command": "npm",
  "args": ["test"]
}
```

Commands must satisfy an explicit `CommandPolicy`.

The default policy allows `npm test`, optionally followed by plain script arguments.

The command runner:

- does not invoke a shell
- validates the working directory
- uses a filtered environment
- removes unsafe `PATH` entries
- prevents secret-looking environment variables from being passed
- enforces execution timeouts
- caps captured stdout and stderr
- replaces the repository root with `<repo>` in captured output

A non-zero exit code alone is not sufficient to establish that an incident was reproduced.

---

## Isolated Git Worktrees

Repairs never modify the original checkout.

A `GitWorktreeWorkspace` creates an isolated worktree from the repository's current commit:

```text
original repository
        │
        │ read-only investigation
        ▼
   RED baseline
        │
        ▼
 isolated Git worktree
        │
        ▼
   apply validated patch
        │
        ▼
   same command again
        │
        ▼
   GREEN verification
```

The worktree is independently sandboxed and is removed after the workflow completes.

The original working tree must remain unchanged.

---

## Patch Safety

`apply_patch` is available only inside an active repair worktree.

Patches are parsed and validated before being applied.

The patch system rejects unsafe or malformed changes including:

- malformed unified diffs
- binary patches
- renames and copies
- mode changes
- unsafe paths
- absolute paths
- `..` path segments
- `.git` and `.devpilot` paths
- symlink or submodule modes
- patches that do not exactly match the current file contents
- attempts to modify the failing test itself

Patch application is all-or-nothing.

Every patch attempt also produces evidence containing its status, reason, affected files, workspace identity, patch hash, and patch text.

---

## RED → PATCH → GREEN

`RepairWorkflow` is a deterministic orchestrator.

It does not invent, improve, or choose patches.

The workflow is:

1. Run the verification command against the original repository.
2. Confirm the expected failure.
3. Identify the specific failing tests.
4. Create an isolated Git worktree.
5. Confirm the same failure exists in the unpatched worktree.
6. Apply the reviewed patch.
7. Run the identical command again.
8. Confirm GREEN.
9. Confirm the previously failing tests specifically passed.
10. Verify the original repository and its Git metadata remain unchanged.
11. Confirm the worktree contains exactly the expected changes.
12. Produce the repaired result and grounded evidence.

A successful exit code is therefore only one part of the proof.

---

## Rule-First, Model-Escalation Planning

DevPilot does not require a model call for every incident.

The planner first attempts deterministic, evidence-driven reasoning.

If the rules can explain the incident, the repair can proceed without a model call.

When the deterministic planner cannot sufficiently explain the failure, the investigation can escalate to the model planner.

The model is still constrained by the investigation's evidence and proposal/review/verification pipeline.

This creates a useful separation:

```text
                    Investigation
                         │
                         ▼
                 Evidence collection
                         │
                         ▼
                  Rule-based planner
                    /           \
                   /             \
              sufficient       insufficient
                 │                   │
                 ▼                   ▼
              Proposal        Model escalation
                 │                   │
                 └─────────┬─────────┘
                           ▼
                     Proposal Review
                           │
                           ▼
                    RED → PATCH → GREEN
```

---

## Hypothesis Selection

DevPilot treats hypothesis selection as an evidence problem rather than simply accepting the model's most confident answer.

Evidence can support or contradict hypotheses.

Evidence that explains multiple hypotheses equally well does not distinguish between them.

The planner therefore avoids manufacturing contradictions merely to force a selection.

When competing hypotheses remain indistinguishable, the repair is refused rather than guessing.

This is especially important for model-assisted repair: uncertainty is treated as a reason to stop, not a reason to fabricate confidence.

---

## MCP Server and Host

DevPilot exposes the investigation service through a self-hosted MCP server.

The composition root keeps the transport layer separated from the investigation engine and planner.

The host provides:

- repository registration
- investigation orchestration
- planner integration
- MCP access
- bearer-token authentication
- origin controls
- loopback operation for the local demo
- bounded model-call configuration

The public-facing MCP responses intentionally avoid exposing internal model text, raw diffs, host filesystem paths, or authentication tokens.

---

## Grounded Reports

The final report is validated against the underlying investigation evidence and event log.

The system checks that report claims do not contradict the actual recorded state.

This prevents a successful-looking report from becoming a second, unverified source of truth.

The repair result carries proof of:

- the incident
- baseline RED evidence
- unpatched worktree RED evidence
- reviewed proposal
- applied patch
- final GREEN evidence
- affected files
- baseline failure identities
- original-repository integrity

---

## Validation

The repository contains extensive automated coverage across the investigation, planner, MCP, repair, and grounding layers.

The final validation run completed with:

```text
919 tests
150 suites
919 passed
0 failed
0 cancelled
0 skipped
```

Additional integration coverage verifies the operator-boundary repair behavior and the DevPilot host's rule-first/model-escalation path.

---

## Example Repair

DevPilot's shipping fixture demonstrates a boundary-condition repair.

The failing behavior comes from an operator boundary where:

```text
>
```

must become:

```text
>=
```

The important part is not the individual operator change.

The workflow proves that:

1. the failure exists before the patch,
2. the hypothesis is supported by collected evidence,
3. the proposal is reviewed,
4. the patch is applied only in an isolated worktree,
5. the same failing test passes afterward,
6. the original repository remains unchanged.

---

## Project Structure

```text
apps/
├── cli/
├── mcp/
├── api/
├── web/
└── devpilot-host/

packages/
├── core/
├── tools/
├── planners/
├── engine/
├── service/
├── planner-bedrock/
└── eval/

fixtures/
└── ...

tests/
└── integration and end-to-end coverage
```

---

## Running the Project

Install dependencies:

```bash
npm install
```

Run the complete validation suite:

```bash
npm run check
```

Run tests directly:

```bash
npm test
```

The repository also provides scripts for the CLI, MCP server, simulator, and the live Bedrock host.

The live Bedrock host requires the appropriate environment configuration and explicitly requires:

```text
DEVPILOT_LIVE_BEDROCK=1
DEVPILOT_MCP_TOKEN=<token>
DEVPILOT_MCP_CONFIG=<config-file>
```

See `.env.example` and the source configuration for the supported environment variables.

---

## Safety Philosophy

DevPilot is intentionally conservative.

A system that modifies source code should be able to answer:

> **What failed?**

> **What evidence supports the diagnosis?**

> **Why was this hypothesis selected?**

> **What exact patch was proposed?**

> **Was the failure reproduced before changing anything?**

> **Did the same failure actually disappear afterward?**

> **Did the original repository remain untouched?**

If the system cannot establish those facts, the repair should not be presented as verified.

---

## Hackathon

Built for the **Build, Ship, Shape: Amazon Developer Hackathon**.

DevPilot focuses on a practical problem in AI-assisted software development:

**How can an autonomous coding agent make changes while producing evidence that the change is actually correct?**

The answer in DevPilot is not simply a better prompt.

It is a controlled repair pipeline where models operate inside a deterministic, evidence-grounded verification system.

---

## License

See [LICENSE](LICENSE).