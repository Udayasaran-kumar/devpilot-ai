import { createHash } from 'node:crypto';
import { formatCommandLine, type Evidence, type InvestigationAction, type InvestigationEvent, type VerificationResult } from '@devpilot/core';
import { APPLY_PATCH_TOOL_NAME, RUN_COMMAND_TOOL_NAME } from '@devpilot/tools';
import { isTerminalStatus, type InvestigationState, type RepairPhase, type RepairState } from './state.js';

export type InvestigationReducer = (
  state: InvestigationState | undefined,
  event: InvestigationEvent,
) => InvestigationState;

export class InvestigationStateError extends Error {
  override readonly name = 'InvestigationStateError';
}

export const reduceInvestigation: InvestigationReducer = (state, event) => {
  if (event.type === 'investigation_started') {
    if (state !== undefined) {
      throw new InvestigationStateError(`Investigation ${state.investigationId} has already started`);
    }
    if (event.sequence !== 0) {
      throw new InvestigationStateError('investigation_started must have sequence 0');
    }
    return {
      investigationId: event.investigationId,
      signal: event.signal,
      budget: event.budget,
      status: 'running',
      startedAt: event.timestamp,
      stepCount: 0,
      lastSequence: 0,
      actions: [],
      finishedActionIds: [],
      evidence: [],
      hypotheses: [],
      verifications: [],
    };
  }

  if (state === undefined) {
    throw new InvestigationStateError(`First event must be investigation_started, received ${event.type}`);
  }
  if (event.investigationId !== state.investigationId) {
    throw new InvestigationStateError(
      `Event for investigation ${event.investigationId} applied to ${state.investigationId}`,
    );
  }
  if (event.sequence !== state.lastSequence + 1) {
    throw new InvestigationStateError(
      `Expected event sequence ${state.lastSequence + 1}, received ${event.sequence}`,
    );
  }
  if (isTerminalStatus(state.status)) {
    throw new InvestigationStateError(`Cannot apply ${event.type} to a ${state.status} investigation`);
  }

  const next = { ...state, lastSequence: event.sequence };
  switch (event.type) {
    case 'action_planned':
      if (state.actions.some((action) => action.id === event.action.id)) {
        throw new InvestigationStateError(`Action ${event.action.id} has already been planned`);
      }
      return { ...next, stepCount: state.stepCount + 1, actions: [...state.actions, event.action] };
    case 'action_completed': {
      requireUnfinishedAction(state, event.actionId);
      const misattributed = event.evidence.find((item) => (item.source.actionId ?? event.actionId) !== event.actionId);
      if (misattributed) {
        throw new InvestigationStateError(
          `Evidence ${misattributed.id} names action ${misattributed.source.actionId}, not ${event.actionId}`,
        );
      }
      return {
        ...next,
        finishedActionIds: [...state.finishedActionIds, event.actionId],
        evidence: upsertById(state.evidence, event.evidence),
      };
    }
    case 'action_failed':
      requireUnfinishedAction(state, event.actionId);
      return { ...next, finishedActionIds: [...state.finishedActionIds, event.actionId] };
    case 'hypotheses_updated':
      return {
        ...next,
        stepCount: state.stepCount + 1,
        hypotheses: upsertById(state.hypotheses, event.hypotheses),
      };
    case 'verification_recorded':
      return { ...next, verifications: [...state.verifications, event.verification] };
    case 'investigation_completed':
      if (state.repair && state.repair.phase !== 'verified' && state.repair.phase !== 'failed') {
        throw new InvestigationStateError('A repair must end with repair_verified or repair_failed before completing');
      }
      return { ...next, status: event.status, terminalReason: event.reason, endedAt: event.timestamp };
    case 'repair_started':
      if (state.repair) {
        throw new InvestigationStateError('Repair has already started');
      }
      if (event.verificationCommand !== formatCommandLine(event.command, event.args)) {
        throw new InvestigationStateError('repair_started verificationCommand does not match its command and args');
      }
      return {
        ...next,
        repair: {
          phase: 'started',
          verificationCommand: event.verificationCommand,
          command: event.command,
          args: event.args,
          timeoutMs: event.timeoutMs,
          expectedFailure: event.expectedFailure,
          patchSha256: event.patchSha256,
          ...(event.description !== undefined ? { description: event.description } : {}),
          ...(event.hypothesisId !== undefined ? { hypothesisId: event.hypothesisId } : {}),
          phaseActionIndex: state.actions.length,
        },
      };
    case 'baseline_verified': {
      const repair = requireRepairPhase(state, event.type, 'started');
      requireCommandProof(state, repair, event.type, event.verificationId, event.evidenceId, 'red');
      return {
        ...next,
        repair: {
          ...repair,
          phase: 'baseline_verified',
          phaseActionIndex: state.actions.length,
          baselineVerificationId: event.verificationId,
          baselineEvidenceId: event.evidenceId,
        },
      };
    }
    case 'worktree_created': {
      const repair = requireRepairPhase(state, event.type, 'baseline_verified');
      requireFreshVerification(repair, event.type, event.verificationId);
      requireCommandProof(state, repair, event.type, event.verificationId, event.evidenceId, 'red');
      return {
        ...next,
        repair: {
          ...repair,
          phase: 'worktree_created',
          phaseActionIndex: state.actions.length,
          workspace: event.workspace,
          baseCommit: event.baseCommit,
          worktreeVerificationId: event.verificationId,
          worktreeEvidenceId: event.evidenceId,
        },
      };
    }
    case 'patch_applied': {
      const repair = requireRepairPhase(state, event.type, 'worktree_created');
      const evidence = state.evidence.find((item) => item.id === event.evidenceId);
      if (evidence?.kind !== 'patch_application' || evidence.location.type !== 'patch') {
        throw new InvestigationStateError(`patch_applied cites unknown patch evidence ${event.evidenceId}`);
      }
      const { location } = evidence;
      if (location.status !== 'applied' || location.workspace !== repair.workspace) {
        throw new InvestigationStateError(
          `Patch evidence ${event.evidenceId} is ${location.status} in worktree ${location.workspace}, not applied in ${repair.workspace}`,
        );
      }
      if (!sameSet(location.paths, event.files.map((file) => file.path))) {
        throw new InvestigationStateError('patch_applied files differ from the patch evidence');
      }
      const action = requireProducingAction(state, repair, event.type, evidence, APPLY_PATCH_TOOL_NAME);
      const patch = action.input['patch'];
      if (typeof patch !== 'string' || sha256(patch) !== repair.patchSha256) {
        throw new InvestigationStateError('patch_applied evidence is for a different patch than the repair request');
      }
      return {
        ...next,
        repair: {
          ...repair,
          phase: 'patch_applied',
          phaseActionIndex: state.actions.length,
          patchEvidenceId: event.evidenceId,
          patchedFiles: event.files.map((file) => file.path),
        },
      };
    }
    case 'repair_verified': {
      const repair = requireRepairPhase(state, event.type, 'patch_applied');
      requireFreshVerification(repair, event.type, event.verificationId);
      requireCommandProof(state, repair, event.type, event.verificationId, event.evidenceId, 'green');
      const evidenceIndex = (id: string | undefined) => state.evidence.findIndex((item) => item.id === id);
      if (evidenceIndex(event.evidenceId) <= evidenceIndex(repair.patchEvidenceId)) {
        throw new InvestigationStateError('repair_verified must cite command output recorded after the patch');
      }
      if (!sameSet(repair.patchedFiles ?? [], event.changedFiles)) {
        throw new InvestigationStateError('repair_verified changed files must be exactly the patched files');
      }
      return {
        ...next,
        repair: {
          ...repair,
          phase: 'verified',
          finalVerificationId: event.verificationId,
          finalEvidenceId: event.evidenceId,
          changedFiles: event.changedFiles,
        },
      };
    }
    case 'repair_failed': {
      const repair = state.repair;
      if (!repair || repair.phase === 'verified' || repair.phase === 'failed') {
        throw new InvestigationStateError('repair_failed requires a repair in progress');
      }
      return {
        ...next,
        repair: {
          ...repair,
          phase: 'failed',
          failure: { status: event.status, reason: event.reason, worktreeRemoved: event.worktreeRemoved },
        },
      };
    }
  }
};

function requireUnfinishedAction(state: InvestigationState, actionId: string): void {
  if (!state.actions.some((action) => action.id === actionId)) {
    throw new InvestigationStateError(`Action ${actionId} was never planned`);
  }
  if (state.finishedActionIds.includes(actionId)) {
    throw new InvestigationStateError(`Action ${actionId} has already finished`);
  }
}

function requireRepairPhase(state: InvestigationState, eventType: string, phase: RepairPhase): RepairState {
  if (!state.repair) {
    throw new InvestigationStateError(`${eventType} requires repair_started`);
  }
  if (state.repair.phase !== phase) {
    throw new InvestigationStateError(`${eventType} requires repair phase ${phase}, not ${state.repair.phase}`);
  }
  return state.repair;
}

function requireFreshVerification(repair: RepairState, eventType: string, verificationId: string): void {
  if (verificationId === repair.baselineVerificationId || verificationId === repair.worktreeVerificationId) {
    throw new InvestigationStateError(`${eventType} must cite a new verification, not ${verificationId}`);
  }
}

/**
 * A confirmed RED (reproducing the expected failure) or GREEN verification of
 * the repair command, citing output that a `run_command` action of this phase
 * produced with exactly the repair's command, arguments, and timeout.
 */
function requireCommandProof(
  state: InvestigationState,
  repair: RepairState,
  eventType: string,
  verificationId: string,
  evidenceId: string,
  outcome: 'red' | 'green',
): void {
  const verification = state.verifications.findLast((item) => item.id === verificationId);
  if (!verification) {
    throw new InvestigationStateError(`Unknown verification ${verificationId}`);
  }
  if (verification.command !== repair.verificationCommand) {
    throw new InvestigationStateError(
      `Verification ${verificationId} ran ${JSON.stringify(verification.command)}, not the repair command ${JSON.stringify(repair.verificationCommand)}`,
    );
  }
  if (!isConfirmed(verification, outcome)) {
    throw new InvestigationStateError(
      outcome === 'red'
        ? `${eventType} requires a confirmed RED reproduction of the expected failure`
        : `${eventType} requires a confirmed GREEN run of the baseline command`,
    );
  }

  const evidence = state.evidence.find((item) => item.id === evidenceId);
  if (!verification.evidenceIds.includes(evidenceId) || !evidence) {
    throw new InvestigationStateError(`Verification ${verificationId} does not cite recorded evidence ${evidenceId}`);
  }
  const { location } = evidence;
  if (evidence.kind !== 'command_output' || location.type !== 'command' || location.command !== repair.verificationCommand) {
    throw new InvestigationStateError(`Evidence ${evidenceId} is not output of the repair command`);
  }
  const consistent =
    outcome === 'green'
      ? location.exitCode === 0
      : location.exitCode !== undefined &&
        location.exitCode !== 0 &&
        repair.expectedFailure.every((text) => evidence.content?.includes(text) === true);
  if (!consistent) {
    throw new InvestigationStateError(`Evidence ${evidenceId} does not show the ${outcome.toUpperCase()} result its verification claims`);
  }

  const action = requireProducingAction(state, repair, eventType, evidence, RUN_COMMAND_TOOL_NAME);
  if (!isRepairCommandInput(action, repair)) {
    throw new InvestigationStateError(`Action ${action.id} did not run the repair command with its exact arguments and timeout`);
  }
}

function isConfirmed(verification: VerificationResult, outcome: 'red' | 'green'): boolean {
  const expectation = outcome === 'red' ? 'fails' : 'passes';
  return verification.expectation === expectation && verification.commandOutcome === outcome && verification.status === 'confirmed';
}

/** The action that produced `evidence`: planned during the current phase, using `tool`. */
function requireProducingAction(
  state: InvestigationState,
  repair: RepairState,
  eventType: string,
  evidence: Evidence,
  tool: string,
): InvestigationAction {
  const index = state.actions.findIndex((action) => action.id === evidence.source.actionId);
  const action = state.actions[index];
  if (!action || index < repair.phaseActionIndex || action.tool !== tool) {
    throw new InvestigationStateError(
      `${eventType} cites evidence ${evidence.id}, which no ${tool} action of this repair step produced`,
    );
  }
  return action;
}

function isRepairCommandInput(action: InvestigationAction, repair: RepairState): boolean {
  const { input } = action;
  const args = input['args'];
  return (
    sameSet(Object.keys(input), ['command', 'args', 'timeoutMs']) &&
    input['command'] === repair.command &&
    input['timeoutMs'] === repair.timeoutMs &&
    Array.isArray(args) &&
    args.length === repair.args.length &&
    args.every((arg, index) => arg === repair.args[index])
  );
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return left.length === a.length && right.length === b.length && a.length === b.length && a.every((item, index) => item === b[index]);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function replayInvestigation(
  events: Iterable<InvestigationEvent>,
  reducer: InvestigationReducer = reduceInvestigation,
): InvestigationState {
  let state: InvestigationState | undefined;
  for (const event of events) {
    state = reducer(state, event);
  }
  if (state === undefined) {
    throw new InvestigationStateError('Cannot replay an empty event log');
  }
  return state;
}

function upsertById<T extends { readonly id: string }>(existing: readonly T[], updates: readonly T[]): T[] {
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const item of updates) {
    byId.set(item.id, item);
  }
  return [...byId.values()];
}
