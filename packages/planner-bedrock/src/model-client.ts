import type { EvidenceKind, EvidenceLocation, Signal } from '@devpilot/core';

/** One collected evidence item as the model sees it. The ID is the only way the model can refer to it. */
export interface EscalationEvidence {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly summary: string;
  readonly location: EvidenceLocation;
  readonly content?: string;
}

/** What the model is asked to assess: the incident, why the rules stopped, and the evidence collected so far. */
export interface EscalationRequest {
  readonly investigationId: string;
  readonly signal: Pick<Signal, 'title' | 'content' | 'command'>;
  readonly ruleConclusion: string;
  readonly evidence: readonly EscalationEvidence[];
}

export interface ModelCallOptions {
  /** Aborted when the planner stops waiting for the reply. */
  readonly signal: AbortSignal;
}

/**
 * The model consulted on escalation. It returns its raw reply (for example
 * the input of a forced tool call); the reply is untrusted and the planner
 * validates it before anything reaches the investigation.
 */
export interface ModelClient {
  readonly name: string;
  assess(request: EscalationRequest, options: ModelCallOptions): Promise<unknown>;
}

/**
 * Thrown by a client when the model cannot be used at all (no access, no
 * credentials, a spend limit), as opposed to a failed call. It disables
 * escalation for the rest of the process.
 */
export class ModelUnavailableError extends Error {
  override readonly name = 'ModelUnavailableError';
}
