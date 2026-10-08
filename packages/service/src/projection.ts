import type { RepairReport, ReportRepairStatus } from '@devpilot/core';
import { validateRepairReport, type GroundedRepairRun, type ReportSources } from '@devpilot/engine';
import { InvestigationOutcomeSchema, type InvestigationOutcome, type ProjectedFailure } from './contracts.js';

/** What a job keeps from a pipeline run: the report and whether it is grounded. Logs, states, and the worktree are dropped. */
export interface RetainedReport {
  readonly investigationId: string;
  readonly report: RepairReport;
  /** The pipeline's grounding validation and the service's own re-validation both passed. */
  readonly groundingValid: boolean;
  readonly baselineFailures: readonly ProjectedFailure[];
}

/**
 * Re-validates the run's report against its own logs instead of relying only
 * on the grounding the pipeline returned, then keeps the report and nothing
 * that could reach the repository (worktree handle, event logs, states).
 */
export function retainReport(run: GroundedRepairRun): RetainedReport {
  const investigation = run.investigation.state;
  if (!investigation) throw new Error('The pipeline returned an investigation that never started');
  const sources: ReportSources = run.repair
    ? { investigation, repair: { result: run.repair.result, state: run.repair.state } }
    : { investigation, ...(run.report.verification.reason !== null ? { notAttemptedReason: run.report.verification.reason } : {}) };
  const groundingValid = run.grounding.valid && validateRepairReport(run.report, sources).valid;
  return {
    investigationId: investigation.investigationId,
    report: run.report,
    groundingValid,
    baselineFailures: (run.repair?.result.baselineFailures ?? []).map((failure) => ({
      testFile: failure.testFile,
      suite: [...failure.suite],
      testName: failure.testName,
    })),
  };
}

export interface ProjectionContext {
  readonly displayName: string;
  /** Paths that must never appear in a projection: repository roots, the home directory, and their real paths. */
  readonly hostPaths: readonly string[];
  /** Statements from the service about what it did after the run, appended to the limitations. */
  readonly notes?: readonly string[];
}

/**
 * Projects a retained report for clients. Only a grounded report contributes
 * its status, claims, failures, and files; anything else, or anything that
 * mentions a host path, becomes "no verified result". The spoken summary is
 * a fixed template over the grounded fields.
 */
export function projectOutcome(retained: RetainedReport, context: ProjectionContext): InvestigationOutcome {
  if (!retained.groundingValid) {
    return unverified(retained.investigationId, context.displayName, 'The report did not pass grounding validation, so no findings are reported.');
  }
  const { report } = retained;
  const outcome: InvestigationOutcome = {
    investigationId: retained.investigationId,
    groundingValid: true,
    repairStatus: report.repairStatus,
    claims: report.claims.map((claim) => ({ ...claim, evidenceIds: [...claim.evidenceIds], actionIds: [...claim.actionIds] })),
    baselineFailures: retained.baselineFailures.map((failure) => ({ ...failure, suite: [...failure.suite] })),
    affectedFiles: [...report.affectedFiles],
    limitations: [...report.limitations, ...(context.notes ?? [])],
    spokenSummary: spokenSummary(context.displayName, report, retained.baselineFailures),
  };
  if (mentionsHostPath(outcome, context.hostPaths)) {
    return unverified(retained.investigationId, context.displayName, 'The result was withheld because it mentions a path on the host machine.');
  }
  return InvestigationOutcomeSchema.parse(outcome);
}

function unverified(investigationId: string, displayName: string, limitation: string): InvestigationOutcome {
  return InvestigationOutcomeSchema.parse({
    investigationId,
    groundingValid: false,
    repairStatus: null,
    claims: [],
    baselineFailures: [],
    affectedFiles: [],
    limitations: [limitation],
    spokenSummary: `DevPilot has no verified result for ${displayName}.`,
  });
}

const STATUS_PHRASES: Record<Exclude<ReportRepairStatus, 'repaired'>, string> = {
  not_attempted: 'no proposed patch passed review, so no repair was attempted',
  baseline_not_red: 'the failure did not reproduce on the repository',
  baseline_inconclusive: 'the failure could not be attributed to specific failing tests',
  worktree_failed: 'the isolated worktree did not reproduce the failure',
  patch_failed: 'the proposed patch did not apply',
  verification_failed: 'the previously failing tests still failed after the patch',
  verification_inconclusive: 'the run after the patch did not show every previously failing test passing',
  safety_check_failed: 'a safety check failed after the patch',
  error: 'the repair workflow stopped with an error',
};

function spokenSummary(displayName: string, report: RepairReport, failures: readonly ProjectedFailure[]): string {
  const verifiedClaims = report.claims.filter((claim) => claim.kind === 'verification').length;
  if (report.repairStatus === 'repaired' && failures.length > 0 && verifiedClaims > 0) {
    const names = failures.map((failure) => `"${failure.testName}"`);
    const listed = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
    const subject = failures.length === 1 ? 'the failing test' : `${failures.length} failing tests`;
    return `DevPilot reproduced ${subject} in ${displayName} and verified a patch in an isolated worktree: ${listed} passed after the change. The patch was not applied to the repository.`;
  }
  if (report.repairStatus === 'repaired') return `DevPilot investigated ${displayName}; the report's claims describe the result.`;
  return `DevPilot investigated ${displayName} but did not verify a repair: ${STATUS_PHRASES[report.repairStatus]}.`;
}

function mentionsHostPath(outcome: InvestigationOutcome, hostPaths: readonly string[]): boolean {
  const text = JSON.stringify(outcome);
  return hostPaths.some((hostPath) => hostPath.length > 1 && text.includes(hostPath));
}
