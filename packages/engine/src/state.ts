import type {
  Evidence,
  Hypothesis,
  InvestigationAction,
  InvestigationBudget,
  RepairFailureStatus,
  Signal,
  TerminalStatus,
  VerificationResult,
} from '@devpilot/core';

export type InvestigationStatus = 'running' | TerminalStatus;

/** Immutable snapshot of an investigation, derived entirely from its event log. */
export interface InvestigationState {
  readonly investigationId: string;
  readonly signal: Signal;
  readonly budget: InvestigationBudget;
  readonly status: InvestigationStatus;
  readonly terminalReason?: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly stepCount: number;
  readonly lastSequence: number;
  readonly actions: readonly InvestigationAction[];
  /** IDs of actions that have completed or failed; an action finishes at most once. */
  readonly finishedActionIds: readonly string[];
  readonly evidence: readonly Evidence[];
  readonly hypotheses: readonly Hypothesis[];
  readonly verifications: readonly VerificationResult[];
  /** Present once `repair_started` has been applied. */
  readonly repair?: RepairState;
}

/** Repair phases advance strictly in this order; `failed` can follow any phase before `verified`. */
export type RepairPhase = 'started' | 'baseline_verified' | 'worktree_created' | 'patch_applied' | 'verified' | 'failed';

export interface RepairState {
  readonly phase: RepairPhase;
  readonly verificationCommand: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly expectedFailure: readonly string[];
  readonly patchSha256: string;
  readonly description?: string;
  readonly hypothesisId?: string;
  /**
   * Number of planned actions when the current phase began. Evidence for the
   * next phase must come from an action planned at or after this index, so
   * nothing recorded before the step can be cited as its proof.
   */
  readonly phaseActionIndex: number;
  readonly baselineVerificationId?: string;
  readonly baselineEvidenceId?: string;
  readonly workspace?: string;
  readonly baseCommit?: string;
  readonly worktreeVerificationId?: string;
  readonly worktreeEvidenceId?: string;
  readonly patchEvidenceId?: string;
  readonly patchedFiles?: readonly string[];
  readonly finalVerificationId?: string;
  readonly finalEvidenceId?: string;
  readonly changedFiles?: readonly string[];
  readonly failure?: { readonly status: RepairFailureStatus; readonly reason: string; readonly worktreeRemoved: boolean };
}

export function isTerminalStatus(status: InvestigationStatus): status is TerminalStatus {
  return status !== 'running';
}
