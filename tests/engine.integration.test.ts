import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { createEvidenceId, InvestigationEventSchema, type Signal } from '@devpilot/core';
import { InvestigationEngine, replayInvestigation } from '@devpilot/engine';
import { RulePlanner, type PlannerRule } from '@devpilot/planners';
import { InMemoryToolRegistry, type Tool } from '@devpilot/tools';

const signal: Signal = {
  id: 'sig-integration',
  kind: 'ci_failure',
  title: 'CI job failed',
  content: 'job "unit" exited with code 1',
  command: 'npm test',
  receivedAt: '2026-01-01T00:00:00.000Z',
};

/** A fake registered under the run_command action type. */
const fakeReproduce: Tool<{ command: string }, { exitCode: number }> = {
  name: 'run_command',
  description: 'Pretends to run a command and reports a failing exit code',
  inputSchema: z.object({ command: z.string().min(1) }),
  outputSchema: z.object({ exitCode: z.number().int() }),
  async run(input, context) {
    const location = { type: 'command', command: input.command, exitCode: 1 } as const;
    return {
      status: 'success',
      output: { exitCode: 1 },
      evidence: [
        {
          id: createEvidenceId({ tool: 'run_command', location, content: 'exit 1' }),
          kind: 'command_output',
          summary: `"${input.command}" exited with code 1`,
          content: 'exit 1',
          location,
          source: { tool: 'run_command' },
          collectedAt: context.now(),
        },
      ],
    };
  },
};

const rules: PlannerRule[] = [
  {
    name: 'reproduce-signal-command',
    matches: (context) => context.signal.command !== undefined && context.actions.length === 0,
    decide: (context) => ({
      type: 'act',
      tool: 'run_command',
      input: { command: context.signal.command ?? '' },
      rationale: 'Reproduce the reported failure before forming hypotheses',
      expectedEvidence: 'Failing command output',
    }),
  },
];

describe('engine + rule planner + tool registry', () => {
  it('runs end to end, emits schema-valid events, and replays to the same state', async () => {
    let tick = Date.parse(signal.receivedAt);
    const engine = new InvestigationEngine({
      planner: new RulePlanner(rules),
      tools: new InMemoryToolRegistry([fakeReproduce]),
      clock: () => (tick += 10),
      generateId: () => 'inv-integration',
    });

    const session = await engine.investigate(signal);

    assert.equal(session.state?.status, 'completed');
    assert.equal(session.state?.evidence.length, 1);
    for (const event of session.events) {
      InvestigationEventSchema.parse(JSON.parse(JSON.stringify(event)));
    }
    assert.deepEqual(replayInvestigation(session.events), session.state);
  });
});
