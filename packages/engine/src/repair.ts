import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  formatCommandLine,
  InvestigationEventSchema,
  RepairRequestSchema,
  RepairResultSchema,
  verifyCommandResult,
  type InvestigationAction,
  type InvestigationBudget,
  type InvestigationEvent,
  type JsonObject,
  type PatchStatus,
  type RepairFailureStatus,
  type RepairRequest,
  type RepairResult,
  type TerminalStatus,
  type VerificationExpectation,
  type VerificationResult,
} from '@devpilot/core';
import {
  APPLY_PATCH_TOOL_NAME,
  ApplyPatchOutputSchema,
  createDefaultToolRegistry,
  createWorkspaceToolRegistry,
  DEFAULT_COMMAND_POLICY,
  DEFAULT_COMMAND_TIMEOUT_MS,
  diffFingerprints,
  fingerprintGitMetadata,
  fingerprintTree,
  GitWorktreeWorkspace,
  MAX_COMMAND_TIMEOUT_MS,
  RepositorySandbox,
  RUN_COMMAND_TOOL_NAME,
  RunCommandOutputSchema,
  SandboxError,
  type CommandPolicy,
  type GitExecutable,
  type HostEnvironment,
  type ToolRegistry,
  type TreeFingerprint,
} from '@devpilot/tools';
import { SECRET_FILE_PATTERN } from './patch-policy.js';
import { reduceInvestigation } from './reducer.js';
import type { InvestigationEventListener } from './session.js';
import type { InvestigationState } from './state.js';
import { describeError, invokeTool } from './tool-invocation.js';

/** Four actions: baseline run, unpatched worktree run, apply_patch, verification run. */
export const REPAIR_BUDGET: InvestigationBudget = { maxSteps: 4, maxDurationMs: 10 * 60_000 };
export const BASELINE_VERIFICATION_ID = 'ver-baseline';
export const WORKTREE_BASELINE_VERIFICATION_ID = 'ver-worktree-baseline';
export const REPAIR_VERIFICATION_ID = 'ver-repair';

/** Trusted configuration. Nothing here comes from the repair request. */
export interface RepairWorkflowOptions {
  /** The repository must be inside this directory. Defaults to the repository root itself. */
  readonly allowedRoot?: string;
  /** Applies to every verification run. Defaults to `npm test` only. */
  readonly commandPolicy?: CommandPolicy;
  readonly commandTimeoutMs?: number;
  readonly git?: GitExecutable;
  readonly hostEnvironment?: HostEnvironment;
  /** Epoch milliseconds; inject a fake clock for deterministic event logs. */
  readonly clock?: () => number;
  readonly generateId?: () => string;
}

export interface RepairRun {
  readonly result: RepairResult;
  readonly events: readonly InvestigationEvent[];
  readonly state: InvestigationState;
  /**
   * The worktree if it still exists: the patched worktree after a repair, or
   * one whose removal failed. The caller removes it.
   */
  readonly workspace: GitWorktreeWorkspace | undefined;
}

/** The request was refused before anything ran. */
export class RepairRequestError extends Error {
  override readonly name = 'RepairRequestError';
}

/**
 * Deterministic RED -> PATCH -> GREEN workflow. It orchestrates existing
 * primitives only: `run_command` on the original repository's read-only
 * registry for the baseline, a `GitWorktreeWorkspace` for isolation, and
 * `run_command` plus `apply_patch` on the worktree's registry.
 * Every step is an event; the reducer refuses `repair_verified` unless the
 * log holds a confirmed RED baseline, a confirmed RED in the unpatched
 * worktree, the applied patch, and a confirmed GREEN run of the same command.
 */
export class RepairWorkflow {
  readonly #options: RepairWorkflowOptions;
  readonly #policy: CommandPolicy;
  readonly #timeoutMs: number;

  constructor(options: RepairWorkflowOptions = {}) {
    const timeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
      throw new RangeError(`commandTimeoutMs must be an integer from 1 to ${MAX_COMMAND_TIMEOUT_MS}`);
    }
    this.#options = options;
    this.#policy = options.commandPolicy ?? DEFAULT_COMMAND_POLICY;
    this.#timeoutMs = timeoutMs;
  }

  /** Validates the request (throwing `RepairRequestError` before anything runs), then runs the repair. */
  async repair(input: RepairRequest, onEvent?: InvestigationEventListener): Promise<RepairRun> {
    const request = this.#validate(input);
    const repository = await this.#resolveRepository(request.repositoryRoot);
    const execution = new RepairExecution(request, repository, this.#options, this.#policy, this.#timeoutMs, onEvent);
    return execution.run();
  }

  #validate(input: RepairRequest): RepairRequest {
    const parsed = RepairRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new RepairRequestError(`Invalid repair request: ${z.prettifyError(parsed.error)}`);
    }
    const request = parsed.data;
    const { command, args, expectedFailure } = request.verification;
    const decision = this.#policy.check(command, args);
    if (!decision.allowed) {
      throw new RepairRequestError(`Verification command refused: ${decision.reason}`);
    }
    const ungrounded = expectedFailure.filter((text) => !request.signal.content.includes(text));
    if (ungrounded.length > 0) {
      throw new RepairRequestError(
        `Expected failure text must be copied from the signal; not found: ${ungrounded.map((t) => JSON.stringify(t)).join(', ')}`,
      );
    }
    const commandLine = formatCommandLine(command, args);
    if (request.signal.command !== undefined && request.signal.command !== commandLine) {
      throw new RepairRequestError(
        `Verification command ${JSON.stringify(commandLine)} differs from the signal's ${JSON.stringify(request.signal.command)}`,
      );
    }
    return request;
  }

  /** Canonical repository root, inside the allowed root by the sandbox's containment rules. */
  async #resolveRepository(repositoryRoot: string): Promise<RepositorySandbox> {
    let resolvedRoot: string;
    try {
      const allowed = await RepositorySandbox.create(this.#options.allowedRoot ?? repositoryRoot);
      const resolved = await allowed.resolveSafePath(path.resolve(repositoryRoot));
      if (resolved.type !== 'directory') {
        throw new RepairRequestError(`Repository root is not a directory: ${repositoryRoot}`);
      }
      resolvedRoot = resolved.absolutePath;
    } catch (error) {
      if (error instanceof SandboxError) {
        throw new RepairRequestError(`Repository root refused: ${error.message}`);
      }
      throw error;
    }
    // The original's refs and config are compared before and after, which needs a real .git directory.
    const git = await lstat(path.join(resolvedRoot, '.git')).catch(() => undefined);
    if (!git?.isDirectory()) {
      throw new RepairRequestError('Repository root must be the main working tree of a git repository (.git directory)');
    }
    return RepositorySandbox.create(resolvedRoot, {
      commandPolicy: this.#policy,
      ...(this.#options.hostEnvironment ? { hostEnvironment: this.#options.hostEnvironment } : {}),
    });
  }
}

type EventPayload = InvestigationEvent extends infer E
  ? E extends unknown
    ? Omit<E, 'investigationId' | 'sequence' | 'timestamp'>
    : never
  : never;

type Failure = { readonly ok: false; readonly status: RepairFailureStatus; readonly reason: string };
type VerificationRun =
  | { readonly ok: true; readonly verification: VerificationResult; readonly evidenceId: string }
  | { readonly ok: false; readonly reason: string; readonly evidenceId: string | null };
interface RepositoryFingerprint {
  readonly tree: TreeFingerprint;
  readonly git: TreeFingerprint;
}

/** One repair run: owns the event log, the worktree, and the facts that end up in the result. */
class RepairExecution {
  readonly #request: RepairRequest;
  readonly #original: RepositorySandbox;
  readonly #options: RepairWorkflowOptions;
  readonly #listener: InvestigationEventListener | undefined;
  readonly #investigationId: string;
  readonly #clock: () => number;
  /** Identical input for every run of the command; built once and never modified. */
  readonly #commandInput: Readonly<JsonObject>;
  readonly #commandLine: string;
  readonly #timeoutMs: number;
  readonly #events: InvestigationEvent[] = [];
  #state: InvestigationState | undefined;

  #workspace: GitWorktreeWorkspace | undefined;
  #originalBefore: RepositoryFingerprint | undefined;
  #baselineEvidenceId: string | null = null;
  #worktreeBaselineEvidenceId: string | null = null;
  #patchStatus: PatchStatus | null = null;
  #patchEvidenceId: string | null = null;
  #finalEvidenceId: string | null = null;
  #changedFiles: string[] = [];
  #originalUnchanged: boolean | null = null;

  constructor(
    request: RepairRequest,
    original: RepositorySandbox,
    options: RepairWorkflowOptions,
    policy: CommandPolicy,
    timeoutMs: number,
    listener: InvestigationEventListener | undefined,
  ) {
    this.#request = request;
    this.#original = original;
    this.#options = { ...options, commandPolicy: policy };
    this.#listener = listener;
    this.#investigationId = (options.generateId ?? (() => `repair-${randomUUID()}`))();
    this.#clock = options.clock ?? Date.now;
    const { command, args } = request.verification;
    this.#commandInput = Object.freeze({ command, args: [...args], timeoutMs });
    this.#commandLine = formatCommandLine(command, args);
    this.#timeoutMs = timeoutMs;
  }

  async run(): Promise<RepairRun> {
    const request = this.#request;
    this.#emit({ type: 'investigation_started', signal: request.signal, budget: REPAIR_BUDGET });
    this.#emit({
      type: 'repair_started',
      verificationCommand: this.#commandLine,
      command: request.verification.command,
      args: [...request.verification.args],
      timeoutMs: this.#timeoutMs,
      expectedFailure: [...request.verification.expectedFailure],
      patchSha256: sha256(request.patch),
      ...(request.description !== undefined ? { description: request.description } : {}),
      ...(request.hypothesisId !== undefined ? { hypothesisId: request.hypothesisId } : {}),
    });

    let failure: Failure | undefined;
    try {
      failure = await this.#execute();
    } catch (error) {
      failure = { ok: false, status: 'error', reason: `Repair stopped by an unexpected error: ${describeError(error)}` };
    }

    if (failure === undefined) {
      this.#emit({ type: 'investigation_completed', status: 'completed', reason: 'Repair verified: RED baseline, patch applied, GREEN in the worktree.' });
    } else {
      await this.#finishFailure(failure);
    }
    return this.#buildRun();
  }

  /** Returns undefined when the repair is verified, otherwise why it stopped. */
  async #execute(): Promise<Failure | undefined> {
    const originalTools = createDefaultToolRegistry(this.#original);
    this.#originalBefore = await this.#fingerprintOriginal();

    // Phase 1: baseline on the original repository must be a confirmed RED reproduction.
    const baseline = await this.#verify(
      originalTools,
      BASELINE_VERIFICATION_ID,
      'fails',
      'Reproduce the incident on the original repository before any change (baseline)',
      'Command output that fails with the expected failure text (confirmed RED)',
    );
    this.#baselineEvidenceId = baseline.evidenceId;
    if (!baseline.ok) return fail('baseline_inconclusive', baseline.reason);
    const { verification: red } = baseline;
    if (red.status === 'rejected') return fail('baseline_not_red', red.summary);
    if (red.status !== 'confirmed') return fail('baseline_inconclusive', red.summary);
    this.#emit({ type: 'baseline_verified', verificationId: red.id, evidenceId: baseline.evidenceId });

    // Phase 2: an isolated worktree, identical to what the baseline tested, that is RED there too.
    try {
      this.#workspace = await GitWorktreeWorkspace.create(this.#original.root, {
        ...(this.#options.allowedRoot !== undefined ? { allowedRoot: this.#options.allowedRoot } : {}),
        ...(this.#options.git ? { git: this.#options.git } : {}),
        ...(this.#options.hostEnvironment ? { hostEnvironment: this.#options.hostEnvironment } : {}),
        sandboxOptions: {
          ...(this.#options.commandPolicy ? { commandPolicy: this.#options.commandPolicy } : {}),
          ...(this.#options.hostEnvironment ? { hostEnvironment: this.#options.hostEnvironment } : {}),
        },
      });
    } catch (error) {
      return fail('worktree_failed', `Could not create the isolated worktree: ${describeError(error)}`);
    }
    const workspace = this.#workspace;
    const drift = diffFingerprints(this.#originalBefore.tree, await fingerprintTree(workspace.getRoot()));
    if (drift.length > 0) {
      return fail(
        'worktree_failed',
        `The worktree (commit ${workspace.baseCommit.slice(0, 12)}) differs from the working tree the baseline ran on: ` +
          `${summarizePaths(drift)}. Commit or stash local changes and remove untracked and ignored files first.`,
      );
    }
    const worktreeTools = createWorkspaceToolRegistry(workspace);
    // Without this control run, a difference the fingerprint cannot see (node_modules, files outside the
    // repository, git state) could make the unpatched worktree GREEN and the patch look like the fix.
    const control = await this.#verify(
      worktreeTools,
      WORKTREE_BASELINE_VERIFICATION_ID,
      'fails',
      `Reproduce the incident in worktree ${workspace.name} before the patch`,
      'Command output in the unpatched worktree that fails with the expected failure text (confirmed RED)',
    );
    this.#worktreeBaselineEvidenceId = control.evidenceId;
    if (!control.ok || control.verification.status !== 'confirmed') {
      const reason = control.ok ? control.verification.summary : control.reason;
      return fail('worktree_failed', `The unpatched worktree does not reproduce the baseline RED: ${reason}`);
    }
    this.#emit({
      type: 'worktree_created',
      workspace: workspace.name,
      baseCommit: workspace.baseCommit,
      verificationId: control.verification.id,
      evidenceId: control.evidenceId,
    });

    // Phase 3: apply the patch through apply_patch on the worktree's registry.
    const patchInput: JsonObject = {
      patch: this.#request.patch,
      ...(this.#request.description !== undefined ? { description: this.#request.description } : {}),
    };
    const patched = await this.#act(
      worktreeTools,
      APPLY_PATCH_TOOL_NAME,
      patchInput,
      'Apply the proposed patch inside the isolated worktree',
      'Patch application evidence with status applied',
    );
    if (!patched.ok) return fail('patch_failed', patched.error);
    const patch = ApplyPatchOutputSchema.parse(patched.output);
    this.#patchStatus = patch.status;
    this.#patchEvidenceId = patch.evidenceIds[0] ?? null;
    if (patch.status !== 'applied' || this.#patchEvidenceId === null) {
      return fail('patch_failed', `apply_patch returned ${patch.status}: ${patch.reason ?? 'no reason given'}`);
    }
    this.#emit({ type: 'patch_applied', evidenceId: this.#patchEvidenceId, files: patch.files });

    // Phase 4: the same command, now expected to pass, in the patched worktree.
    const final = await this.#verify(
      worktreeTools,
      REPAIR_VERIFICATION_ID,
      'passes',
      `Rerun the baseline command in worktree ${workspace.name} after the patch`,
      'Command output of the same command in the patched worktree that exits 0 (confirmed GREEN)',
    );
    this.#finalEvidenceId = final.evidenceId;
    if (!final.ok) return fail('verification_inconclusive', final.reason);
    const { verification: green } = final;
    if (green.status === 'rejected') return fail('verification_failed', green.summary);
    if (green.status !== 'confirmed') return fail('verification_inconclusive', green.summary);

    // Phase 5: the original is untouched and the worktree holds exactly the patch.
    const originalChanges = await this.#checkOriginal();
    if (originalChanges.length > 0) {
      return fail('safety_check_failed', `The original repository changed: ${summarizePaths(originalChanges)}`);
    }
    const head = await workspace.head();
    if (head !== workspace.baseCommit) {
      return fail('safety_check_failed', `The worktree HEAD moved from ${workspace.baseCommit.slice(0, 12)} to ${head.slice(0, 12)} during verification`);
    }
    const changes = await this.#worktreeChanges(workspace);
    const patchedPaths = new Set(patch.files.map((file) => file.path));
    const patchDirectories = new Set(patch.files.flatMap((file) => parentDirectories(file.path)));
    this.#changedFiles = changes.filter((file) => !patchDirectories.has(file));
    const unexpected = this.#changedFiles.filter((file) => !patchedPaths.has(file));
    const unchanged = [...patchedPaths].filter((file) => !changes.includes(file));
    const secretLike = this.#changedFiles.filter((file) => SECRET_FILE_PATTERN.test(file));
    if (unexpected.length > 0) {
      return fail('safety_check_failed', `Files changed outside the patch during verification: ${summarizePaths(unexpected)}`);
    }
    if (unchanged.length > 0) {
      return fail('safety_check_failed', `Patched files show no change in the worktree: ${summarizePaths(unchanged)}`);
    }
    if (secretLike.length > 0) {
      return fail('safety_check_failed', `The patch adds files named like secrets: ${summarizePaths(secretLike)}`);
    }

    this.#emit({
      type: 'repair_verified',
      verificationId: green.id,
      evidenceId: final.evidenceId,
      changedFiles: this.#changedFiles,
      originalUnchanged: true,
    });
    return undefined;
  }

  /** Runs the fixed verification command once and records the verification. */
  async #verify(
    tools: ToolRegistry,
    id: string,
    expectation: VerificationExpectation,
    rationale: string,
    expectedEvidence: string,
  ): Promise<VerificationRun> {
    const outcome = await this.#act(tools, RUN_COMMAND_TOOL_NAME, this.#commandInput, rationale, expectedEvidence);
    if (!outcome.ok) return { ok: false, reason: outcome.error, evidenceId: null };
    const output = RunCommandOutputSchema.parse(outcome.output);
    const evidenceId = output.evidenceIds[0];
    if (evidenceId === undefined) return { ok: false, reason: 'run_command produced no evidence', evidenceId: null };

    const assessed = verifyCommandResult({
      id,
      result: output,
      evidenceId,
      expectation,
      ...(expectation === 'fails' ? { expectedOutput: this.#request.verification.expectedFailure } : {}),
      completedAt: this.#now(),
    });
    const verification: VerificationResult =
      this.#request.hypothesisId !== undefined ? { ...assessed, hypothesisId: this.#request.hypothesisId } : assessed;
    this.#emit({ type: 'verification_recorded', verification });
    return { ok: true, verification, evidenceId };
  }

  async #act(tools: ToolRegistry, tool: string, input: Readonly<JsonObject>, rationale: string, expectedEvidence: string) {
    const action: InvestigationAction = {
      id: `action-${(this.#state?.actions.length ?? 0) + 1}`,
      tool,
      input: structuredClone(input) as JsonObject,
      rationale,
      expectedEvidence,
      hypothesisIds: this.#request.hypothesisId !== undefined ? [this.#request.hypothesisId] : [],
    };
    this.#emit({ type: 'action_planned', action });
    const outcome = await invokeTool(tools, action, { investigationId: this.#investigationId, now: () => this.#now() });
    if (outcome.ok) {
      this.#emit({ type: 'action_completed', actionId: action.id, output: outcome.output, evidence: outcome.evidence });
    } else {
      this.#emit({ type: 'action_failed', actionId: action.id, error: outcome.error });
    }
    return outcome;
  }

  async #fingerprintOriginal(): Promise<RepositoryFingerprint> {
    return {
      tree: await fingerprintTree(this.#original.root),
      git: await fingerprintGitMetadata(this.#original.root),
    };
  }

  /** Working-tree and git-metadata paths of the original that changed since before the baseline. */
  async #checkOriginal(): Promise<string[]> {
    if (this.#originalBefore === undefined) return [];
    const after = await this.#fingerprintOriginal();
    const changes = [
      ...diffFingerprints(this.#originalBefore.tree, after.tree),
      ...diffFingerprints(this.#originalBefore.git, after.git),
    ];
    this.#originalUnchanged = changes.length === 0;
    return changes;
  }

  /**
   * Paths that differ between the tree the baseline ran on and the worktree
   * now: by content (which also sees ignored files and anything committed in
   * the worktree) and by `git status`.
   */
  async #worktreeChanges(workspace: GitWorktreeWorkspace): Promise<string[]> {
    if (this.#originalBefore === undefined) return [];
    const byContent = diffFingerprints(this.#originalBefore.tree, await fingerprintTree(workspace.getRoot()));
    const byGit = (await workspace.status()).changedPaths;
    return [...new Set([...byContent, ...byGit])].sort();
  }

  /** Records what changed, removes the worktree, and closes the log with repair_failed. */
  async #finishFailure(failure: Failure): Promise<void> {
    let reason = failure.reason;
    try {
      if (this.#originalUnchanged === null) {
        const changes = await this.#checkOriginal();
        if (changes.length > 0) reason += `; the original repository also changed: ${summarizePaths(changes)}`;
      }
      if (this.#workspace && !this.#workspace.removed && this.#changedFiles.length === 0) {
        this.#changedFiles = await this.#worktreeChanges(this.#workspace);
      }
    } catch (error) {
      reason += `; post-failure checks failed: ${describeError(error)}`;
    }

    let worktreeRemoved = false;
    if (this.#workspace) {
      try {
        await this.#workspace.remove();
        worktreeRemoved = true;
      } catch (error) {
        reason += `; the worktree could not be removed and is still on disk: ${describeError(error)}`;
      }
    }
    this.#emit({ type: 'repair_failed', status: failure.status, reason: this.#redact(reason), worktreeRemoved });
    const terminal: TerminalStatus = failure.status === 'error' ? 'failed' : 'completed';
    this.#emit({ type: 'investigation_completed', status: terminal, reason: `Repair not verified: ${failure.status}` });
  }

  #buildRun(): RepairRun {
    const state = this.#state;
    const repair = state?.repair;
    if (!state || !repair) {
      throw new Error('Repair log is incomplete');
    }
    // Status and proof IDs come from the reducer-checked log whenever the log has them.
    const repaired = repair.phase === 'verified';
    const retained = this.#workspace !== undefined && !this.#workspace.removed ? this.#workspace : undefined;
    const result = RepairResultSchema.parse({
      investigationId: this.#investigationId,
      status: repaired ? 'repaired' : (repair.failure?.status ?? 'error'),
      reason: repaired ? null : (repair.failure?.reason ?? 'Repair did not finish'),
      verificationCommand: this.#commandLine,
      hypothesisId: this.#request.hypothesisId ?? null,
      baselineVerificationId: recorded(state, BASELINE_VERIFICATION_ID),
      baselineEvidenceId: repair.baselineEvidenceId ?? this.#baselineEvidenceId,
      worktree: this.#workspace?.name ?? null,
      baseCommit: this.#workspace?.baseCommit ?? null,
      worktreeBaselineEvidenceId: repair.worktreeEvidenceId ?? this.#worktreeBaselineEvidenceId,
      patchStatus: this.#patchStatus,
      patchEvidenceId: repair.patchEvidenceId ?? this.#patchEvidenceId,
      finalVerificationId: recorded(state, REPAIR_VERIFICATION_ID),
      finalEvidenceId: repair.finalEvidenceId ?? this.#finalEvidenceId,
      changedFiles: repaired ? [...(repair.changedFiles ?? [])] : this.#changedFiles,
      originalUnchanged: this.#originalUnchanged,
      worktreeRetained: retained !== undefined,
    });
    return { result, events: [...this.#events], state, workspace: retained };
  }

  #emit(payload: EventPayload): void {
    const event = InvestigationEventSchema.parse({
      ...payload,
      investigationId: this.#investigationId,
      sequence: this.#events.length,
      timestamp: this.#now(),
    });
    this.#state = reduceInvestigation(this.#state, event);
    this.#events.push(event);
    this.#listener?.(event);
  }

  #redact(text: string): string {
    return text.split(this.#original.root).join('<repo>');
  }

  #now(): string {
    return new Date(this.#clock()).toISOString();
  }
}

function fail(status: RepairFailureStatus, reason: string): Failure {
  return { ok: false, status, reason };
}

function recorded(state: InvestigationState, verificationId: string): string | null {
  return state.verifications.some((verification) => verification.id === verificationId) ? verificationId : null;
}

/** `a/b/c.ts` -> `a`, `a/b`. */
function parentDirectories(file: string): string[] {
  const segments = file.split('/').slice(0, -1);
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
}

function summarizePaths(paths: readonly string[]): string {
  const shown = paths.slice(0, 10).join(', ');
  return paths.length > 10 ? `${shown} (+${paths.length - 10} more)` : shown;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
