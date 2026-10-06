import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import {
  findDanglingEvidenceIds,
  InvestigationEventSchema,
  verifyCommandResult,
  type Signal,
} from '@devpilot/core';
import { InvestigationEngine, replayInvestigation } from '@devpilot/engine';
import { RulePlanner } from '@devpilot/planners';
import {
  createDefaultToolRegistry,
  RepositorySandbox,
  RunCommandOutputSchema,
  type RunCommandOutput,
  type ToolRegistry,
} from '@devpilot/tools';

const FIXTURE_ROOT = fileURLToPath(new URL('../fixtures/sample-repository', import.meta.url));

const signal: Signal = {
  id: 'sig-checkout-tax',
  kind: 'failing_test',
  title: 'Checkout test fails in CI',
  content: [
    'not ok 2 - applies tax to the discounted amount',
    '  error: |-',
    '    Expected values to be strictly equal:',
    '    200 !== 180',
  ].join('\n'),
  command: 'npm test',
  receivedAt: '2026-01-01T00:00:00.000Z',
};

/** Failure markers taken verbatim from the signal; nothing here is specific to the engine or tools. */
const EXPECTED_FAILURE = ['applies tax to the discounted amount', '200 !== 180'];

async function runNpmTest(registry: ToolRegistry): Promise<{ output: RunCommandOutput; evidenceId: string }> {
  const tool = registry.get('run_command');
  assert.ok(tool);
  const result = await tool.run(
    { command: 'npm', args: ['test'] },
    { investigationId: 'inv-direct', actionId: 'action-1', now: () => signal.receivedAt },
  );
  assert.equal(result.status, 'success', result.status === 'error' ? result.error : '');
  assert.ok(result.status === 'success');
  const output = RunCommandOutputSchema.parse(result.output);
  const evidenceId = output.evidenceIds[0];
  assert.ok(evidenceId);
  assert.deepEqual(
    result.evidence.map((item) => item.id),
    [evidenceId],
  );
  return { output, evidenceId };
}

describe('sandboxed verification of the sample repository', () => {
  for (const text of EXPECTED_FAILURE) {
    assert.ok(signal.content.includes(text));
  }

  it('reproduces the failing fixture test as RED through the default tool registry', async () => {
    const registry = createDefaultToolRegistry(await RepositorySandbox.create(FIXTURE_ROOT));
    const { output, evidenceId } = await runNpmTest(registry);
    assert.equal(output.exitCode, 1);
    assert.equal(output.timedOut, false);

    const verification = verifyCommandResult({
      id: 'ver-reproduce',
      result: output,
      evidenceId,
      expectation: 'fails',
      expectedOutput: EXPECTED_FAILURE,
    });
    assert.equal(verification.commandOutcome, 'red');
    assert.equal(verification.status, 'confirmed');
    assert.deepEqual(verification.evidenceIds, [evidenceId]);
  });

  describe('red to green on a working copy', () => {
    let workdir: string;
    before(async () => {
      workdir = await mkdtemp(path.join(tmpdir(), 'devpilot-redgreen-'));
      await cp(FIXTURE_ROOT, workdir, { recursive: true });
    });
    after(async () => {
      await rm(workdir, { recursive: true, force: true });
    });

    it('goes RED before the fix and GREEN after it', async () => {
      const registry = createDefaultToolRegistry(await RepositorySandbox.create(workdir));

      const before = await runNpmTest(registry);
      const red = verifyCommandResult({
        id: 'ver-red',
        result: before.output,
        evidenceId: before.evidenceId,
        expectation: 'fails',
        expectedOutput: EXPECTED_FAILURE,
      });
      assert.equal(red.commandOutcome, 'red');
      assert.equal(red.status, 'confirmed');

      const checkoutPath = path.join(workdir, 'src', 'checkout.ts');
      const source = await readFile(checkoutPath, 'utf8');
      assert.ok(source.includes('Math.round(subtotal * TAX_RATE)'));
      await writeFile(checkoutPath, source.replace('Math.round(subtotal * TAX_RATE)', 'Math.round(discounted * TAX_RATE)'));

      const afterFix = await runNpmTest(registry);
      const green = verifyCommandResult({
        id: 'ver-green',
        result: afterFix.output,
        evidenceId: afterFix.evidenceId,
        expectation: 'passes',
      });
      assert.equal(afterFix.output.exitCode, 0);
      assert.equal(green.commandOutcome, 'green');
      assert.equal(green.status, 'confirmed');
      assert.notEqual(afterFix.evidenceId, before.evidenceId);

      const reproduceAfterFix = verifyCommandResult({
        id: 'ver-reproduce-after-fix',
        result: afterFix.output,
        evidenceId: afterFix.evidenceId,
        expectation: 'fails',
        expectedOutput: EXPECTED_FAILURE,
      });
      assert.equal(reproduceAfterFix.status, 'rejected');
    });
  });

  it('records the command result as engine events that replay to the same state', async () => {
    let tick = Date.parse(signal.receivedAt);
    const engine = new InvestigationEngine({
      planner: new RulePlanner([
        {
          name: 'reproduce-signal-command',
          matches: (context) => context.actions.length === 0,
          decide: () => ({
            type: 'act',
            tool: 'run_command',
            input: { command: 'npm', args: ['test'] },
            rationale: 'Reproduce the reported failure',
          }),
        },
      ]),
      tools: createDefaultToolRegistry(await RepositorySandbox.create(FIXTURE_ROOT)),
      clock: () => (tick += 5),
      generateId: () => 'inv-command',
    });

    const session = await engine.investigate(signal);
    const state = session.state;
    assert.ok(state);
    assert.equal(state.status, 'completed');

    const completed = session.events.find((event) => event.type === 'action_completed');
    assert.ok(completed && completed.type === 'action_completed');
    const output = RunCommandOutputSchema.parse(completed.output);
    assert.equal(output.exitCode, 1);
    assert.equal(completed.evidence.length, 1);
    const [commandEvidence] = completed.evidence;
    assert.ok(commandEvidence);
    assert.equal(commandEvidence.kind, 'command_output');
    assert.deepEqual(commandEvidence.source, { tool: 'run_command', actionId: 'action-1' });
    assert.deepEqual(commandEvidence.location, { type: 'command', command: 'npm test', exitCode: 1 });

    for (const event of session.events) {
      InvestigationEventSchema.parse(JSON.parse(JSON.stringify(event)));
    }
    assert.deepEqual(replayInvestigation(session.events), state);
    assert.deepEqual(replayInvestigation(JSON.parse(JSON.stringify(session.events))), state);

    const verification = verifyCommandResult({
      id: 'ver-engine',
      result: output,
      evidenceId: commandEvidence.id,
      expectation: 'fails',
      expectedOutput: EXPECTED_FAILURE,
    });
    assert.equal(verification.status, 'confirmed');
    assert.deepEqual(findDanglingEvidenceIds(verification.evidenceIds, state.evidence), []);
  });
});
