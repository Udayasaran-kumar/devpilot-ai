import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { createEvidenceId, type InvestigationEvent, type Signal } from '@devpilot/core';
import type { Planner, PlannerContext, PlannerDecision } from '@devpilot/planners';
import { InMemoryToolRegistry, type Tool } from '@devpilot/tools';
import { InvestigationEngine, replayInvestigation } from '../src/index.js';

const START = Date.parse('2026-01-01T00:00:00.000Z');

const signal: Signal = {
  id: 'sig-1',
  kind: 'stack_trace',
  title: 'TypeError in parser',
  content: "TypeError: Cannot read properties of undefined (reading 'length')",
  receivedAt: '2026-01-01T00:00:00.000Z',
};

const lookupTool: Tool<{ term: string }, { hits: number }> = {
  name: 'fake_lookup',
  description: 'Returns one deterministic observation per term',
  inputSchema: z.object({ term: z.string().min(1) }),
  outputSchema: z.object({ hits: z.number().int() }),
  async run(input, context) {
    const location = { type: 'signal', signalId: 'sig-1' } as const;
    return {
      status: 'success',
      output: { hits: 1 },
      evidence: [
        {
          id: createEvidenceId({ tool: 'fake_lookup', location, content: input.term }),
          kind: 'signal_excerpt',
          summary: `Signal mentions "${input.term}"`,
          content: input.term,
          location,
          source: { tool: 'fake_lookup' },
          collectedAt: context.now(),
        },
      ],
    };
  },
};

function scriptedPlanner(decide: (context: PlannerContext) => PlannerDecision): Planner {
  return { name: 'scripted', next: async (context) => decide(context) };
}

function createEngine(planner: Planner, budget?: { maxSteps?: number; maxDurationMs?: number }, clock = () => START) {
  return new InvestigationEngine({
    planner,
    tools: new InMemoryToolRegistry([lookupTool]),
    clock,
    generateId: () => 'inv-test',
    ...(budget ? { budget } : {}),
  });
}

const act = (term: string, tool = 'fake_lookup'): PlannerDecision => ({
  type: 'act',
  tool,
  input: { term },
  rationale: `Look up ${term}`,
});

describe('InvestigationEngine', () => {
  it('emits an ordered, serializable event stream for a full run', async () => {
    const planner = scriptedPlanner((context) => {
      if (context.actions.length === 0) return act('length');
      if (context.hypotheses.length === 0) {
        return {
          type: 'update_hypotheses',
          hypotheses: [
            {
              id: 'hyp-1',
              statement: 'Parser receives undefined input',
              status: 'supported',
              confidence: 0.6,
              supportingEvidenceIds: context.evidence.map((item) => item.id),
              contradictingEvidenceIds: [],
            },
          ],
        };
      }
      return { type: 'finish', reason: 'Enough evidence gathered' };
    });

    const streamed: InvestigationEvent[] = [];
    const session = await createEngine(planner).investigate(signal, (event) => streamed.push(event));

    assert.deepEqual(
      session.events.map((event) => event.type),
      ['investigation_started', 'action_planned', 'action_completed', 'hypotheses_updated', 'investigation_completed'],
    );
    assert.deepEqual(streamed, session.events);
    assert.deepEqual(
      session.events.map((event) => event.sequence),
      [0, 1, 2, 3, 4],
    );
    assert.deepEqual(JSON.parse(JSON.stringify(session.events)), session.events);

    const state = session.state;
    assert.ok(state);
    assert.equal(state.status, 'completed');
    assert.equal(state.stepCount, 2);
    assert.equal(state.evidence.length, 1);
    assert.deepEqual(state.evidence[0]?.source, { tool: 'fake_lookup', actionId: 'action-1' });
    assert.deepEqual(state.hypotheses[0]?.supportingEvidenceIds, [state.evidence[0]?.id]);
    assert.deepEqual(replayInvestigation(session.events), state);
  });

  it('is deterministic given the same clock, ids, planner, and tools', async () => {
    const planner = scriptedPlanner((context) =>
      context.actions.length < 2 ? act(`term-${context.actions.length}`) : { type: 'finish', reason: 'done' },
    );
    const first = await createEngine(planner).investigate(signal);
    const second = await createEngine(planner).investigate(signal);
    assert.deepEqual(first.events, second.events);
  });

  it('stops at the step budget', async () => {
    const session = await createEngine(scriptedPlanner(() => act('loop')), { maxSteps: 3 }).investigate(signal);
    assert.equal(session.state?.status, 'step_budget_exhausted');
    assert.equal(session.state?.actions.length, 3);
  });

  it('stops at the time budget', async () => {
    let now = START;
    const clock = () => {
      now += 100;
      return now;
    };
    const session = await createEngine(scriptedPlanner(() => act('slow')), { maxDurationMs: 250 }, clock).investigate(
      signal,
    );
    assert.equal(session.state?.status, 'time_budget_exhausted');
  });

  it('records tool failures without aborting the investigation', async () => {
    const planner = scriptedPlanner((context) => {
      if (context.actions.length === 0) return act('x', 'missing_tool');
      if (context.actions.length === 1) return { type: 'act', tool: 'fake_lookup', input: { term: 42 }, rationale: 'Bad input' };
      return { type: 'finish', reason: 'done' };
    });
    const session = await createEngine(planner).investigate(signal);
    const failures = session.events.filter((event) => event.type === 'action_failed');
    assert.equal(failures.length, 2);
    assert.match(failures[0]?.type === 'action_failed' ? failures[0].error : '', /Unknown tool "missing_tool"/);
    assert.match(failures[1]?.type === 'action_failed' ? failures[1].error : '', /Invalid input/);
    assert.equal(session.state?.status, 'completed');
  });

  it('fails the investigation when hypotheses cite unknown evidence', async () => {
    const planner = scriptedPlanner(() => ({
      type: 'update_hypotheses',
      hypotheses: [
        {
          id: 'hyp-1',
          statement: 'Ungrounded guess',
          status: 'proposed',
          confidence: 0.9,
          supportingEvidenceIds: ['ev-doesnotexist'],
          contradictingEvidenceIds: [],
        },
      ],
    }));
    const session = await createEngine(planner).investigate(signal);
    assert.equal(session.state?.status, 'failed');
    assert.match(session.state?.terminalReason ?? '', /ev-doesnotexist/);
  });

  it('fails the investigation when the planner throws or returns an invalid decision', async () => {
    const throwing = await createEngine(
      scriptedPlanner(() => {
        throw new Error('model unavailable');
      }),
    ).investigate(signal);
    assert.equal(throwing.state?.status, 'failed');
    assert.match(throwing.state?.terminalReason ?? '', /model unavailable/);

    const invalid = await createEngine(
      scriptedPlanner(() => ({ type: 'act', tool: 'fake_lookup', input: { term: 'x' }, rationale: '' })),
    ).investigate(signal);
    assert.equal(invalid.state?.status, 'failed');
  });

  it('returns the same run when run() is called repeatedly', async () => {
    const session = createEngine(scriptedPlanner(() => ({ type: 'finish', reason: 'done' }))).createSession(signal);
    const [a, b] = await Promise.all([session.run(), session.run()]);
    assert.equal(a, b);
    assert.equal(session.events.length, 2);
  });
});
