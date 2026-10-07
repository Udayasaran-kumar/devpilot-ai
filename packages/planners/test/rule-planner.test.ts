import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RulePlanner, type PlannerContext, type PlannerRule } from '../src/index.js';

const context: PlannerContext = {
  investigationId: 'inv-1',
  signal: {
    id: 'sig-1',
    kind: 'log_output',
    title: 'Error in logs',
    content: 'ERROR something broke',
    receivedAt: '2026-01-01T00:00:00.000Z',
  },
  stepCount: 0,
  remainingSteps: 5,
  actions: [],
  evidence: [],
  hypotheses: [],
  verifications: [],
  patchProposals: [],
  tools: [{ name: 'search_code', description: 'Search the repository' }],
};

describe('RulePlanner', () => {
  it('finishes when no rule matches', async () => {
    const decision = await new RulePlanner().next(context);
    assert.equal(decision.type, 'finish');
  });

  it('applies the first matching rule', async () => {
    const rules: PlannerRule[] = [
      { name: 'never', matches: () => false, decide: () => ({ type: 'finish', reason: 'never' }) },
      {
        name: 'search-first',
        matches: (ctx) => ctx.actions.length === 0,
        decide: () => ({
          type: 'act',
          tool: 'search_code',
          input: { query: 'x' },
          rationale: 'Start broad',
          expectedEvidence: 'Search hits',
        }),
      },
      { name: 'fallback', matches: () => true, decide: () => ({ type: 'finish', reason: 'fallback' }) },
    ];
    const decision = await new RulePlanner(rules).next(context);
    assert.deepEqual(decision, {
      type: 'act',
      tool: 'search_code',
      input: { query: 'x' },
      rationale: 'Start broad',
      expectedEvidence: 'Search hits',
    });
  });
});
