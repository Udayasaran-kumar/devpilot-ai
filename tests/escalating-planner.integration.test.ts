import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { InvestigationEventSchema, type InvestigationEvent, type Signal } from '@devpilot/core';
import { GroundedRepairPipeline, InvestigationEngine, replayInvestigation } from '@devpilot/engine';
import { RulePlanner, type Planner } from '@devpilot/planners';
import { EscalatingPlanner, type EscalationEvent, type EscalationRequest, type ModelClient } from '@devpilot/planner-bedrock';
import { createDefaultToolRegistry, RepositorySandbox, resolveGitExecutable } from '@devpilot/tools';
import { git } from '../packages/tools/test/support/git-repository.js';

const CHECKOUT_ROOT = fileURLToPath(new URL('../fixtures/sample-repository/', import.meta.url));
const SHIPPING_ROOT = fileURLToPath(new URL('../fixtures/shipping-repository/', import.meta.url));
const START = Date.parse('2026-01-01T00:00:00.000Z');

const CHECKOUT_SIGNAL: Signal = {
  id: 'sig-checkout-tax',
  kind: 'failing_test',
  title: 'Checkout total is too high when a discount code is used',
  content: 'not ok 2 - applies tax to the discounted amount\n    200 !== 180',
  command: 'npm test',
  receivedAt: '2026-01-01T00:00:00.000Z',
};

const SHIPPING_SIGNAL: Signal = {
  id: 'sig-shipping-threshold',
  kind: 'failing_test',
  title: 'Orders exactly at the free-shipping threshold are charged shipping',
  content: 'not ok 3 - ships free exactly at the threshold\n    500 !== 0',
  command: 'npm test',
  receivedAt: '2026-01-01T00:00:00.000Z',
};

const BUGGY_LINE = '  const shipping = subtotal > freeThreshold ? 0 : flatRate;';
const FIXED_LINE = '  const shipping = subtotal >= freeThreshold ? 0 : flatRate;';

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

interface Edit {
  readonly path: string;
  readonly originalText: string;
  readonly replacementText: string;
}

const SHIPPING_EDIT: Edit = { path: 'src/shipping.ts', originalText: BUGGY_LINE, replacementText: FIXED_LINE };

/**
 * Stands in for a model on the shipping incident. Evidence IDs are content
 * addressed and vary between runs, so it reads them from the request, as a
 * model would, and answers with the given edit.
 */
function shippingModel(edit: Edit = SHIPPING_EDIT) {
  const requests: EscalationRequest[] = [];
  const client: ModelClient = {
    name: 'fake-shipping-model',
    assess: async (request) => {
      requests.push(request);
      const idOf = (kind: string, file?: string) =>
        request.evidence.find((item) => item.kind === kind && (file === undefined || (item.location.type === 'file' && item.location.path === file)))?.id;
      const source = idOf('source_code', 'src/shipping.ts');
      const test = idOf('source_code', 'test/shipping.test.ts');
      const run = idOf('command_output');
      const edited = request.evidence.find((item) => item.id === (edit.path === 'src/shipping.ts' ? source : test));
      const line = (edited?.content ?? '').split('\n').indexOf(edit.originalText) + 1;
      return {
        hypotheses: [
          {
            key: 'threshold-comparison',
            statement: 'The free-shipping check uses > where the documented rule is "at or above", so an order exactly at the threshold pays shipping.',
            supportingEvidenceIds: [source, test, run],
            contradictingEvidenceIds: [],
          },
          {
            key: 'flat-rate',
            statement: 'The caller passes the wrong flat rate.',
            supportingEvidenceIds: [],
            contradictingEvidenceIds: [test],
          },
        ],
        edit: { hypothesisKey: 'threshold-comparison', line, ...edit },
      };
    },
  };
  return { client, requests };
}

const countingModel = () => {
  const counter = { calls: 0 };
  const client: ModelClient = {
    name: 'counting-model',
    assess: async () => {
      counter.calls += 1;
      throw new Error('must not be called');
    },
  };
  return { client, counter };
};

describe('rules-first, model-escalation planner on real repositories', () => {
  it('the rules alone cannot explain the shipping incident', async () => {
    const { state } = await investigate(SHIPPING_ROOT, SHIPPING_SIGNAL, new RulePlanner());
    assert.equal(state.status, 'completed');
    assert.deepEqual(state.hypotheses, []);
    assert.deepEqual(state.patchProposals, []);
    assert.equal(state.terminalReason, `No competing hypotheses could be formed from \`${BUGGY_LINE.trim()}\`.`);
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
    const { events: log, state } = await investigate(SHIPPING_ROOT, SHIPPING_SIGNAL, planner);

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
    assert.match(record?.proposal.patch ?? '', new RegExp(`^-${escape(BUGGY_LINE)}\\n\\+${escape(FIXED_LINE)}$`, 'm'));
    assert.equal(record?.proposal.expectedOutcome, 'If the hypothesis holds, `npm test` exits 0 and "ships free exactly at the threshold" no longer fails.');
  });

  it('only the repair workflow proves the model-assisted proposal RED -> PATCH -> GREEN, in a worktree', async () => {
    const realGit = await resolveGitExecutable();
    const base = await mkdtemp(path.join(tmpdir(), 'devpilot-escalation-'));
    const allowedRoot = path.join(base, 'allowed');
    const root = path.join(allowedRoot, 'shipping');
    await mkdir(allowedRoot);
    await cp(SHIPPING_ROOT, root, { recursive: true });
    git(realGit, root, 'init', '-q', '-b', 'main');
    git(realGit, root, 'add', '-A');
    git(realGit, root, 'commit', '-q', '-m', 'Initial commit');

    const model = shippingModel();
    let tick = START;
    const run = await new GroundedRepairPipeline({
      allowedRoot,
      git: realGit,
      planner: new EscalatingPlanner({ model: model.client }),
      clock: () => (tick += 1000),
      generateId: (purpose) => `${purpose}-shipping`,
    }).run({ repositoryRoot: root, signal: SHIPPING_SIGNAL });
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
      assert.ok((await readFile(path.join(root, 'src/shipping.ts'), 'utf8')).includes(BUGGY_LINE), 'the original repository is unchanged');
      assert.ok((await readFile(path.join(repair.workspace?.getSandbox().root ?? '', 'src/shipping.ts'), 'utf8')).includes(FIXED_LINE));
      assert.deepEqual(run.grounding.issues, []);
      assert.equal(run.grounding.valid, true);
      assert.equal(run.report.selectedHypothesis?.id, 'hyp-model-threshold-comparison');
      assert.equal(run.report.confidence, 0.75);
    } finally {
      await run.repair?.workspace?.remove();
      await rm(base, { recursive: true, force: true });
    }
  });

  it('a model edit to the failing test passes the local checks but is refused by the existing review', async () => {
    const edit: Edit = {
      path: 'test/shipping.test.ts',
      originalText: '  assert.equal(quote.shipping, 0);',
      replacementText: '  assert.equal(quote.shipping, 500);',
    };
    const testSource = await readFile(path.join(SHIPPING_ROOT, edit.path), 'utf8');
    assert.ok(testSource.split('\n').includes(edit.originalText), 'the fixture contains the line being edited');
    const model = shippingModel(edit);
    const { state } = await investigate(SHIPPING_ROOT, SHIPPING_SIGNAL, new EscalatingPlanner({ model: model.client }));

    const record = state.patchProposals.at(-1);
    assert.equal(record?.status, 'patch_rejected');
    assert.ok(record?.violations.some((violation) => violation.code === 'test_file' && violation.path === edit.path));
    assert.equal(state.status, 'completed');
    assert.match(state.terminalReason ?? '', /rejected by review/);
  });

  it('an invalid model reply leaves the rule outcome exactly as if the model had never been asked', async () => {
    const model = shippingModel({ ...SHIPPING_EDIT, originalText: '  const shipping = subtotal >= freeThreshold ? 0 : flatRate;' });
    const events: EscalationEvent[] = [];
    const rules = await investigate(SHIPPING_ROOT, SHIPPING_SIGNAL, new RulePlanner());
    const escalated = await investigate(SHIPPING_ROOT, SHIPPING_SIGNAL, new EscalatingPlanner({ model: model.client, onEvent: (event) => events.push(event) }));

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

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
