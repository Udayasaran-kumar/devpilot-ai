import type {
  Evidence,
  Hypothesis,
  InvestigationAction,
  InvestigationBudget,
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
  readonly evidence: readonly Evidence[];
  readonly hypotheses: readonly Hypothesis[];
  readonly verifications: readonly VerificationResult[];
}

export function isTerminalStatus(status: InvestigationStatus): status is TerminalStatus {
  return status !== 'running';
}
