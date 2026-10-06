import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { InvestigationEvent } from '@devpilot/core';
import { InvestigationStateError, isTerminalStatus, reduceInvestigation, replayInvestigation } from '../src/index.js';

const NOW = '2026-01-01T00:00:00.000Z';
const base = { investigationId: 'inv-1', timestamp: NOW };

const started: InvestigationEvent = {
  ...base,
  type: 'investigation_started',
  sequence: 0,
  signal: { id: 'sig-1', kind: 'bug_report', title: 'Crash on save', content: 'App crashes on save', receivedAt: NOW },
  budget: { maxSteps: 10, maxDurationMs: 60_000 },
};

const planned: InvestigationEvent = {
  ...base,
  type: 'action_planned',
  sequence: 1,
  action: { id: 'action-1', tool: 'search', input: { query: 'save' }, rationale: 'Find save handler', hypothesisIds: [] },
};

const completed: InvestigationEvent = {
  ...base,
  type: 'investigation_completed',
  sequence: 2,
  status: 'completed',
  reason: 'done',
};

describe('reduceInvestigation', () => {
  it('reaches a terminal state', () => {
    const running = replayInvestigation([started, planned]);
    assert.equal(running.status, 'running');
    assert.equal(isTerminalStatus(running.status), false);
    assert.equal(running.stepCount, 1);

    const finished = reduceInvestigation(running, completed);
    assert.equal(finished.status, 'completed');
    assert.equal(isTerminalStatus(finished.status), true);
    assert.equal(finished.terminalReason, 'done');
    assert.equal(finished.endedAt, NOW);
  });

  it('rejects events after a terminal state', () => {
    const finished = replayInvestigation([started, planned, completed]);
    assert.throws(
      () => reduceInvestigation(finished, { ...planned, sequence: 3 }),
      InvestigationStateError,
    );
  });

  it('requires investigation_started first and gapless sequences', () => {
    assert.throws(() => reduceInvestigation(undefined, planned), /First event must be investigation_started/);
    const running = reduceInvestigation(undefined, started);
    assert.throws(() => reduceInvestigation(running, { ...planned, sequence: 2 }), /Expected event sequence 1/);
    assert.throws(() => reduceInvestigation(running, started), /already started/);
  });

  it('does not mutate the previous state', () => {
    const running = reduceInvestigation(undefined, started);
    const snapshot = structuredClone(running);
    reduceInvestigation(running, planned);
    assert.deepEqual(running, snapshot);
  });
});
