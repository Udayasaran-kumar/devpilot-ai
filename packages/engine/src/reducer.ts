import type { InvestigationEvent } from '@devpilot/core';
import { isTerminalStatus, type InvestigationState } from './state.js';

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
      return { ...next, stepCount: state.stepCount + 1, actions: [...state.actions, event.action] };
    case 'action_completed':
      return { ...next, evidence: upsertById(state.evidence, event.evidence) };
    case 'action_failed':
      return next;
    case 'hypotheses_updated':
      return {
        ...next,
        stepCount: state.stepCount + 1,
        hypotheses: upsertById(state.hypotheses, event.hypotheses),
      };
    case 'verification_recorded':
      return { ...next, verifications: [...state.verifications, event.verification] };
    case 'investigation_completed':
      return { ...next, status: event.status, terminalReason: event.reason, endedAt: event.timestamp };
  }
};

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
