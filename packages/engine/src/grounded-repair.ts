import path from 'node:path';
import {
  formatCommandLine,
  type InvestigationBudget,
  type PatchProposalRecord,
  type RepairReport,
  type RepairVerification,
  type Signal,
} from '@devpilot/core';
import { analyzeInvestigation, RulePlanner, type Planner } from '@devpilot/planners';
import {
  createDefaultToolRegistry,
  DEFAULT_COMMAND_POLICY,
  RepositorySandbox,
  SandboxError,
  type CommandPolicy,
  type GitExecutable,
  type HostEnvironment,
} from '@devpilot/tools';
import { InvestigationEngine } from './engine.js';
import { RepairRequestError, RepairWorkflow, type RepairRun } from './repair.js';
import { buildRepairReport, validateRepairReport, type ReportGrounding, type ReportSources } from './repair-report.js';
import type { InvestigationSession } from './session.js';
import type { InvestigationState } from './state.js';

/** Trusted configuration, shared by the investigation and the repair workflow. */
export interface GroundedRepairOptions {
  /** Defaults to the evidence-driven `RulePlanner`. */
  readonly planner?: Planner;
  readonly budget?: Partial<InvestigationBudget>;
  /** The repository must be inside this directory. Defaults to the repository root itself. */
  readonly allowedRoot?: string;
  readonly commandPolicy?: CommandPolicy;
  readonly commandTimeoutMs?: number;
  readonly git?: GitExecutable;
  readonly hostEnvironment?: HostEnvironment;
  /** Epoch milliseconds; inject a fake clock for deterministic runs. */
  readonly clock?: () => number;
  readonly generateId?: (purpose: 'investigation' | 'repair') => string;
}

export interface GroundedRepairRun {
  readonly investigation: InvestigationSession;
  /** The proposal handed to the repair workflow, if review accepted one. */
  readonly proposal: PatchProposalRecord | undefined;
  readonly repair: RepairRun | undefined;
  readonly report: RepairReport;
  readonly grounding: ReportGrounding;
}

/**
 * Incident -> evidence -> competing hypotheses -> proposal -> review ->
 * RED/PATCH/GREEN -> grounded report. The planner only proposes: the
 * investigation runs read-only tools on the original repository, and an
 * accepted proposal's patch is passed unmodified to `RepairWorkflow`, whose
 * result is the only source of the repair status.
 */
export class GroundedRepairPipeline {
  readonly #options: GroundedRepairOptions;

  constructor(options: GroundedRepairOptions = {}) {
    this.#options = options;
  }

  async run(input: { readonly repositoryRoot: string; readonly signal: Signal }): Promise<GroundedRepairRun> {
    const options = this.#options;
    const clock = options.clock ?? Date.now;
    const sandbox = await this.#sandbox(input.repositoryRoot);
    const engine = new InvestigationEngine({
      planner: options.planner ?? new RulePlanner(),
      tools: createDefaultToolRegistry(sandbox),
      clock,
      ...(options.budget ? { budget: options.budget } : {}),
      ...(options.generateId ? { generateId: () => options.generateId?.('investigation') ?? 'investigation' } : {}),
    });
    const investigation = await engine.investigate(input.signal);
    const state = investigation.state;
    if (!state) throw new Error('The investigation did not start');

    const proposal = state.patchProposals.find((record) => record.status === 'awaiting_verification');
    let repair: RepairRun | undefined;
    let notAttemptedReason: string | undefined;
    if (!proposal) {
      notAttemptedReason = 'no patch proposal passed review';
    } else if (state.status === 'failed') {
      notAttemptedReason = `the investigation failed after proposal ${proposal.id} passed review: ${state.terminalReason ?? 'no reason given'}`;
    } else {
      const verification = verificationFor(state);
      if (typeof verification === 'string') {
        notAttemptedReason = verification;
      } else {
        try {
          repair = await this.#workflow(clock).repair({
            repositoryRoot: input.repositoryRoot,
            signal: input.signal,
            verification,
            patch: proposal.proposal.patch,
            description: `Proposal ${proposal.id} for ${proposal.proposal.hypothesisId}`,
            hypothesisId: proposal.proposal.hypothesisId,
          });
        } catch (error) {
          if (!(error instanceof RepairRequestError)) throw error;
          notAttemptedReason = `the repair request was refused: ${error.message}`;
        }
      }
    }

    const sources: ReportSources = {
      investigation: state,
      ...(repair ? { repair: { result: repair.result, state: repair.state } } : {}),
      ...(notAttemptedReason !== undefined ? { notAttemptedReason } : {}),
    };
    const report = buildRepairReport({ ...sources, createdAt: new Date(clock()).toISOString() });
    return { investigation, proposal, repair, report, grounding: validateRepairReport(report, sources) };
  }

  /** A sandbox on the original repository, inside the allowed root, for read-only investigation. */
  async #sandbox(repositoryRoot: string): Promise<RepositorySandbox> {
    const { allowedRoot, commandPolicy, hostEnvironment } = this.#options;
    let root: string;
    try {
      const allowed = await RepositorySandbox.create(allowedRoot ?? repositoryRoot);
      const resolved = await allowed.resolveSafePath(path.resolve(repositoryRoot));
      if (resolved.type !== 'directory') throw new RepairRequestError(`Repository root is not a directory: ${repositoryRoot}`);
      root = resolved.absolutePath;
    } catch (error) {
      if (error instanceof SandboxError) throw new RepairRequestError(`Repository root refused: ${error.message}`);
      throw error;
    }
    return RepositorySandbox.create(root, {
      commandPolicy: commandPolicy ?? DEFAULT_COMMAND_POLICY,
      ...(hostEnvironment ? { hostEnvironment } : {}),
    });
  }

  #workflow(clock: () => number): RepairWorkflow {
    const { allowedRoot, commandPolicy, commandTimeoutMs, git, hostEnvironment, generateId } = this.#options;
    return new RepairWorkflow({
      clock,
      ...(allowedRoot !== undefined ? { allowedRoot } : {}),
      ...(commandPolicy ? { commandPolicy } : {}),
      ...(commandTimeoutMs !== undefined ? { commandTimeoutMs } : {}),
      ...(git ? { git } : {}),
      ...(hostEnvironment ? { hostEnvironment } : {}),
      ...(generateId ? { generateId: () => generateId('repair') } : {}),
    });
  }
}

/**
 * The repair workflow re-runs the command the investigation reproduced, and
 * requires the failure it saw: the failing test's name and its comparison,
 * but only as far as the signal itself quotes them.
 */
function verificationFor(state: InvestigationState): RepairVerification | string {
  const analysis = analyzeInvestigation({
    investigationId: state.investigationId,
    signal: state.signal,
    stepCount: state.stepCount,
    remainingSteps: 0,
    actions: state.actions,
    evidence: state.evidence,
    hypotheses: state.hypotheses,
    verifications: state.verifications,
    patchProposals: state.patchProposals,
    tools: [],
  });
  const command = analysis.command;
  const failure = analysis.reproduction?.failure;
  if (!command || !failure) return 'the investigation did not reproduce a failing test to verify against';
  const expectedFailure = [failure.name, failure.comparison]
    .filter((text): text is string => text !== undefined && state.signal.content.includes(text));
  if (expectedFailure.length === 0) {
    return 'the signal does not quote the failing test or its comparison, so there is no grounded expected failure';
  }
  if (formatCommandLine(command.command, command.args) !== state.signal.command) {
    return 'the reproduced command differs from the signal command';
  }
  return { command: command.command, args: [...command.args], expectedFailure };
}
