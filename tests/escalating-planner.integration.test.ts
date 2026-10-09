import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { InvestigationEventSchema, type InvestigationEvent, type Signal } from '@devpilot/core';
import { GroundedRepairPipeline, InvestigationEngine, replayInvestigation } from '@devpilot/engine';
import { RulePlanner, type Planner } from '@devpilot/planners';
import { EscalatingPlanner, type EscalationEvent } from '@devpilot/planner-bedrock';
import { BedrockModelClient } from '@devpilot/planner-bedrock/bedrock';
import { InvestigationService, RepositoryRegistry } from '@devpilot/service';
import { createDefaultToolRegistry, RepositorySandbox, resolveGitExecutable } from '@devpilot/tools';
import {
  countingModel,
  SHIPPING_BUGGY_LINE,
  SHIPPING_EDIT,
  SHIPPING_FIXED_LINE,
  SHIPPING_ROOT,
  SHIPPING_SIGNAL,
  SHIPPING_STATEMENT,
  shippingModel,
  type LineEdit,
} from '../packages/planner-bedrock/test/support/fake-models.js';
import { converseOutput, fakeRuntime, promptData, shippingRuntime, userText } from '../packages/planner-bedrock/test/support/fake-runtime.js';
import { createGitRepositoryFixture, git } from '../packages/tools/test/support/git-repository.js';

const CHECKOUT_ROOT = fileURLToPath(new URL('../fixtures/sample-repository/', import.meta.url));
const START = Date.parse('2026-01-01T00:00:00.000Z');

const CHECKOUT_SIGNAL: Signal = {
  id: 'sig-checkout-tax',
  kind: 'failing_test',
  title: 'Checkout total is too high when a discount code is used',
  content: 'not ok 2 - applies tax to the discounted amount\n    200 !== 180',
  command: 'npm test',
  receivedAt: '2026-01-01T00:00:00.000Z',
};

const SHIPPING: Signal = { ...SHIPPING_SIGNAL, id: 'sig-shipping-threshold', command: 'npm test', receivedAt: '2026-01-01T00:00:00.000Z' };

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

async function investigate(root: string, signal: Signal, planner: Planner) {
  let tick = START;
  const engine = new InvestigationEngine({
    planner,
    tools: createDefaultToolRegistry(await RepositorySandbox.create(root)),
    clock: () => (tick += 1000),
    generateId: () => 'inv-escalation',
  });
  const session = await engine.investigate(signal);
  const state = session.state;
  assert.ok(state);
  assert.deepEqual(replayInvestigation(session.events), state, 'state is exactly the replayed event log');
  for (const event of session.events) InvestigationEventSchema.parse(JSON.parse(JSON.stringify(event)));
  return { events: session.events, state };
}

/** Masks test-runner durations and numbers evidence IDs by first appearance, as in the evidence planner tests. */
function normalizeTimings(events: readonly InvestigationEvent[]): string {
  const ids = new Map<string, string>();
  return JSON.stringify(events)
    .replace(/duration_ms:? [\d.]+/g, 'duration_ms: <masked>')
    .replace(/"durationMs":\d+/g, '"durationMs":"<masked>"')
    .replace(/ev-[0-9a-f]{16}/g, (id) => {
      if (!ids.has(id)) ids.set(id, `ev-${ids.size}`);
      return ids.get(id) ?? id;
    });
}

describe('rules-first, model-escalation planner on real repositories', () => {
  it('the rules alone cannot explain the shipping incident', async () => {
    const { state } = await investigate(SHIPPING_ROOT, SHIPPING, new RulePlanner());
    assert.equal(state.status, 'completed');
    assert.deepEqual(state.hypotheses, []);
    assert.deepEqual(state.patchProposals, []);
    assert.equal(state.terminalReason, `No competing hypotheses could be formed from \`${SHIPPING_BUGGY_LINE.trim()}\`.`);
  });

  it('a rule-solvable incident makes zero model calls and produces exactly the rule planner event log', async () => {
    const { client, counter } = countingModel();
    const events: EscalationEvent[] = [];
    const escalating = new EscalatingPlanner({ model: client, onEvent: (event) => events.push(event) });
    const rules = await investigate(CHECKOUT_ROOT, CHECKOUT_SIGNAL, new RulePlanner());
    const withEscalation = await investigate(CHECKOUT_ROOT, CHECKOUT_SIGNAL, escalating);

    assert.equal(counter.calls, 0);
    assert.equal(escalating.modelCalls, 0);
    assert.deepEqual(events, []);
    assert.equal(normalizeTimings(withEscalation.events), normalizeTimings(rules.events));
    assert.equal(withEscalation.state.patchProposals.at(-1)?.status, 'awaiting_verification');
    assert.ok(!withEscalation.state.hypotheses.some((item) => item.id.startsWith('hyp-model-')));
  });

  it('escalates once on the shipping incident; review accepts the locally rendered proposal', async () => {
    const model = shippingModel();
    const events: EscalationEvent[] = [];
    const planner = new EscalatingPlanner({ model: model.client, onEvent: (event) => events.push(event) });
    const { events: log, state } = await investigate(SHIPPING_ROOT, SHIPPING, planner);

    assert.equal(model.requests.length, 1);
    assert.match(model.requests[0]?.ruleConclusion ?? '', /^No competing hypotheses could be formed/);
    assert.deepEqual(events, [
      { type: 'escalated', investigationId: 'inv-escalation', model: 'fake-shipping-model', selectedHypothesisId: 'hyp-model-threshold-comparison' },
    ]);

    const types = log.map((event) => event.type);
    assert.equal(types.filter((type) => type === 'hypotheses_updated').length, 3);
    assert.ok(types.indexOf('patch_proposed') < types.indexOf('patch_reviewed'));
    assert.equal(state.status, 'completed');
    assert.deepEqual(
      state.hypotheses.map(({ id, status, confidence }) => [id, status, confidence]),
      [
        ['hyp-model-threshold-comparison', 'selected', 0.75],
        ['hyp-model-flat-rate', 'weakened', 0],
      ],
    );
    const record = state.patchProposals.at(-1);
    assert.equal(record?.status, 'awaiting_verification');
    assert.deepEqual(record?.violations, []);
    assert.deepEqual(record?.proposal.affectedPaths, ['src/shipping.ts']);
    assert.match(record?.proposal.patch ?? '', new RegExp(`^-${escape(SHIPPING_BUGGY_LINE)}\\n\\+${escape(SHIPPING_FIXED_LINE)}$`, 'm'));
    assert.equal(record?.proposal.expectedOutcome, 'If the hypothesis holds, `npm test` exits 0 and "ships free exactly at the threshold" no longer fails.');
  });

  it('only the repair workflow proves the model-assisted proposal RED -> PATCH -> GREEN, in a worktree', async () => {
    const realGit = await resolveGitExecutable();
    const fixture = await createGitRepositoryFixture(realGit, SHIPPING_ROOT);
    const model = shippingModel();
    let tick = START;
    const run = await new GroundedRepairPipeline({
      allowedRoot: fixture.allowedRoot,
      git: realGit,
      planner: new EscalatingPlanner({ model: model.client }),
      clock: () => (tick += 1000),
      generateId: (purpose) => `${purpose}-shipping`,
    }).run({ repositoryRoot: fixture.root, signal: SHIPPING });
    try {
      assert.equal(model.requests.length, 1);
      assert.equal(run.proposal?.status, 'awaiting_verification');
      const repair = run.repair;
      assert.ok(repair);
      assert.equal(repair.result.status, 'repaired', repair.result.reason ?? undefined);
      assert.equal(repair.result.hypothesisId, 'hyp-model-threshold-comparison');
      assert.equal(repair.state.repair?.patchSha256, sha256(run.proposal?.proposal.patch ?? ''), 'the proposal reached the workflow unmodified');
      assert.deepEqual(repair.result.changedFiles, ['src/shipping.ts']);
      assert.deepEqual(repair.state.repair?.expectedFailure, ['ships free exactly at the threshold', '500 !== 0']);
      assert.equal(repair.result.originalUnchanged, true);
      assert.ok((await readFile(path.join(fixture.root, 'src/shipping.ts'), 'utf8')).includes(SHIPPING_BUGGY_LINE), 'the original repository is unchanged');
      assert.ok((await readFile(path.join(repair.workspace?.getSandbox().root ?? '', 'src/shipping.ts'), 'utf8')).includes(SHIPPING_FIXED_LINE));
      assert.deepEqual(run.grounding.issues, []);
      assert.equal(run.grounding.valid, true);
      assert.equal(run.report.selectedHypothesis?.id, 'hyp-model-threshold-comparison');
      assert.equal(run.report.confidence, 0.75);
    } finally {
      await run.repair?.workspace?.remove();
      await fixture.cleanup();
    }
  });

  it('a model edit to the failing test passes the local checks but is refused by the existing review', async () => {
    const edit: LineEdit = {
      path: 'test/shipping.test.ts',
      originalText: '  assert.equal(quote.shipping, 0);',
      replacementText: '  assert.equal(quote.shipping, 500);',
    };
    const testSource = await readFile(path.join(SHIPPING_ROOT, edit.path), 'utf8');
    assert.ok(testSource.split('\n').includes(edit.originalText), 'the fixture contains the line being edited');
    const model = shippingModel(edit);
    const { state } = await investigate(SHIPPING_ROOT, SHIPPING, new EscalatingPlanner({ model: model.client }));

    const record = state.patchProposals.at(-1);
    assert.equal(record?.status, 'patch_rejected');
    assert.ok(record?.violations.some((violation) => violation.code === 'test_file' && violation.path === edit.path));
    assert.equal(state.status, 'completed');
    assert.match(state.terminalReason ?? '', /rejected by review/);
  });

  it('an invalid model reply leaves the rule outcome exactly as if the model had never been asked', async () => {
    const model = shippingModel({ ...SHIPPING_EDIT, originalText: SHIPPING_FIXED_LINE });
    const events: EscalationEvent[] = [];
    const rules = await investigate(SHIPPING_ROOT, SHIPPING, new RulePlanner());
    const escalated = await investigate(SHIPPING_ROOT, SHIPPING, new EscalatingPlanner({ model: model.client, onEvent: (event) => events.push(event) }));

    assert.equal(model.requests.length, 1);
    assert.deepEqual(
      events.map((event) => event.type === 'fallback' && event.reason),
      ['invalid_output'],
    );
    assert.equal(normalizeTimings(escalated.events), normalizeTimings(rules.events));
    assert.deepEqual(escalated.state.hypotheses, []);
    assert.deepEqual(escalated.state.patchProposals, []);
  });
});

describe('InvestigationService with the escalating planner', () => {
  it('repairs the shipping incident through the service, asks the model only for it, and projects no model text', async () => {
    const realGit = await resolveGitExecutable();
    const shipping = await createGitRepositoryFixture(realGit, SHIPPING_ROOT);
    const checkout = await createGitRepositoryFixture(realGit);
    try {
      const registry = new RepositoryRegistry();
      const npmTest = { command: 'npm', args: ['test'] };
      registry.register({ repositoryId: 'shipping', displayName: 'Shipping', repositoryRoot: shipping.root, allowedRoot: shipping.allowedRoot, verification: npmTest });
      registry.register({ repositoryId: 'checkout', displayName: 'Checkout', repositoryRoot: checkout.root, allowedRoot: checkout.allowedRoot, verification: npmTest });
      const model = shippingModel();
      const planner = new EscalatingPlanner({ model: model.client });
      const service = new InvestigationService({ registry, git: realGit, planner });

      const checkoutJob = service.startInvestigation({ repositoryId: 'checkout', signal: { kind: 'failing_test', title: CHECKOUT_SIGNAL.title, content: CHECKOUT_SIGNAL.content } });
      const shippingJob = service.startInvestigation({ repositoryId: 'shipping', signal: SHIPPING_SIGNAL });
      assert.equal((await service.waitForJob({ jobId: checkoutJob.jobId })).status, 'completed');
      assert.equal((await service.waitForJob({ jobId: shippingJob.jobId })).status, 'completed');

      assert.equal(model.requests.length, 1, 'only the incident the rules cannot explain reaches the model');
      assert.equal(planner.modelCalls, 1);
      const checkoutOutcome = service.getResult({ jobId: checkoutJob.jobId }).outcome;
      assert.equal(checkoutOutcome?.repairStatus, 'repaired');
      assert.ok(!JSON.stringify(checkoutOutcome).includes('hyp-model-'));

      const result = service.getResult({ jobId: shippingJob.jobId });
      const outcome = result.outcome;
      assert.ok(outcome);
      assert.equal(outcome.groundingValid, true);
      assert.equal(outcome.repairStatus, 'repaired');
      assert.deepEqual(outcome.baselineFailures.map((failure) => failure.testName), ['ships free exactly at the threshold']);
      assert.deepEqual(outcome.affectedFiles, ['src/shipping.ts']);
      assert.ok(outcome.claims.some((claim) => claim.kind === 'verification'));
      assert.ok(outcome.claims.some((claim) => claim.kind === 'proposal' && claim.statement.includes('hyp-model-threshold-comparison')));
      assert.match(outcome.spokenSummary, /verified a patch in an isolated worktree/);

      const text = JSON.stringify(result);
      assert.ok(!text.includes(SHIPPING_STATEMENT) && !text.includes('at or above'), 'model-written hypothesis text is not projected');
      assert.ok(!text.includes('@@ '), 'no diff hunks');
      for (const hostPath of [shipping.base, shipping.root, shipping.canonicalRoot, homedir(), tmpdir()]) assert.ok(!text.includes(hostPath));
      assert.equal(git(realGit, shipping.root, 'status', '--porcelain'), '');
      assert.ok((await readFile(path.join(shipping.root, 'src/shipping.ts'), 'utf8')).includes(SHIPPING_BUGGY_LINE));
    } finally {
      await shipping.cleanup();
      await checkout.cleanup();
    }
  });
});

describe('the Bedrock model client against a local Converse runtime', () => {
  it('repairs the shipping incident from the rendered prompt alone, in one request that names no host path', async () => {
    const realGit = await resolveGitExecutable();
    const fixture = await createGitRepositoryFixture(realGit, SHIPPING_ROOT);
    const { runtime, sends } = shippingRuntime();
    const events: EscalationEvent[] = [];
    const run = await new GroundedRepairPipeline({
      allowedRoot: fixture.allowedRoot,
      git: realGit,
      planner: new EscalatingPlanner({ model: new BedrockModelClient({ runtime }), onEvent: (event) => events.push(event) }),
    }).run({ repositoryRoot: fixture.root, signal: SHIPPING });
    try {
      assert.equal(sends.length, 1);
      assert.deepEqual(events.map((event) => event.type), ['escalated']);
      assert.equal(run.repair?.result.status, 'repaired', run.repair?.result.reason ?? undefined);
      assert.equal(run.grounding.valid, true);
      assert.equal(run.report.selectedHypothesis?.id, 'hyp-model-threshold-comparison');

      const request = JSON.stringify(sends[0]?.command.input);
      for (const hostPath of [fixture.base, fixture.root, fixture.canonicalRoot, homedir(), tmpdir(), '/private/']) {
        assert.ok(!request.includes(hostPath), `the request mentions ${hostPath}`);
      }
      assert.ok(userText(sends[0]!.command).includes('src/shipping.ts'));
    } finally {
      await run.repair?.workspace?.remove();
      await fixture.cleanup();
    }
  });

  it('a reply the planner refuses reports only its stage and leaves the rule outcome exactly as without the model', async () => {
    const { runtime, sends } = fakeRuntime((command) => {
      const ids = promptData(command).evidence.map((item) => item.id);
      const hypothesis = (key: string) => ({ key, statement: `Hypothesis ${key}.`, supportingEvidenceIds: ids.slice(0, 3), contradictingEvidenceIds: [] });
      return converseOutput(JSON.stringify({ hypotheses: [hypothesis('first'), hypothesis('second')], edit: null }));
    });
    const events: EscalationEvent[] = [];
    const rules = await investigate(SHIPPING_ROOT, SHIPPING, new RulePlanner());
    const escalated = await investigate(SHIPPING_ROOT, SHIPPING, new EscalatingPlanner({ model: new BedrockModelClient({ runtime }), onEvent: (event) => events.push(event) }));

    assert.equal(sends.length, 1);
    assert.deepEqual(
      events.map((event) => event.type === 'fallback' && [event.reason, event.stage]),
      [['invalid_output', 'no_exclusive_winner']],
    );
    assert.equal(normalizeTimings(escalated.events), normalizeTimings(rules.events));
    assert.deepEqual(escalated.state.patchProposals, []);
  });

  it('is never asked about an incident the rules explain', async () => {
    const { runtime, sends } = fakeRuntime(() => {
      throw new Error('unexpected model request');
    });
    const { state } = await investigate(CHECKOUT_ROOT, CHECKOUT_SIGNAL, new EscalatingPlanner({ model: new BedrockModelClient({ runtime }) }));
    assert.equal(sends.length, 0);
    assert.equal(state.patchProposals.at(-1)?.status, 'awaiting_verification');
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
