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
import { EscalatingPlanner, type EscalationEvent, type ModelClient } from '@devpilot/planner-bedrock';
import { BedrockModelClient, renderEscalationPrompt, type EscalationPrompt } from '@devpilot/planner-bedrock/bedrock';
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
  /** The ID of the search hit the rules collect at src/shipping.ts:9; evidence IDs are the same in every run. */
  const shippingHitId = async () => {
    const { state } = await investigate(SHIPPING_ROOT, SHIPPING, new RulePlanner());
    const hits = state.evidence.filter((item) => item.kind === 'search_result');
    assert.deepEqual(
      hits.map((item) => item.location.type === 'file' && [item.location.path, item.location.startLine, item.content]),
      [['src/shipping.ts', 9, SHIPPING_BUGGY_LINE]],
    );
    return hits[0]?.id ?? '';
  };

  it('sends the shipping search hit only as line 9 of src/shipping.ts, as three citable items', async () => {
    const hit = await shippingHitId();
    const { runtime, sends } = shippingRuntime();
    const { state } = await investigate(SHIPPING_ROOT, SHIPPING, new EscalatingPlanner({ model: new BedrockModelClient({ runtime }) }));

    assert.equal(sends.length, 1);
    assert.deepEqual(
      promptData(sends[0]!.command).evidence.map((item) => [item.kind, item.location.path ?? item.location.command, item.matchedLines]),
      [
        ['source_code', 'test/shipping.test.ts', undefined],
        ['source_code', 'src/shipping.ts', [9]],
        ['command_output', 'npm test', undefined],
      ],
    );
    assert.ok(state.evidence.some((item) => item.id === hit), 'the hit was collected');
    assert.ok(!userText(sends[0]!.command).includes(hit), 'but is not offered for citation');
    assert.equal(state.patchProposals.at(-1)?.status, 'awaiting_verification');
  });

  it('offers exactly three citable evidence IDs for the shipping incident, none of them the folded hit', async () => {
    const hit = await shippingHitId();
    const prompts: EscalationPrompt[] = [];
    const recorder: ModelClient = {
      name: 'prompt-recorder',
      assess: async (request) => {
        prompts.push(renderEscalationPrompt(request));
        return { hypotheses: [], edit: null };
      },
    };
    const { state } = await investigate(SHIPPING_ROOT, SHIPPING, new EscalatingPlanner({ model: recorder }));

    assert.equal(prompts.length, 1);
    const [prompt] = prompts;
    const idOf = (kind: string, file?: string) => state.evidence.find((item) => item.kind === kind && (file === undefined || (item.location.type === 'file' && item.location.path === file)))?.id;
    assert.deepEqual(
      [...(prompt?.sentEvidenceIds ?? [])].sort(),
      [idOf('source_code', 'test/shipping.test.ts'), idOf('source_code', 'src/shipping.ts'), idOf('command_output')].sort(),
    );
    assert.deepEqual(prompt?.foldedEvidenceIds, [hit]);
    assert.deepEqual(prompt?.omittedEvidenceIds, []);
    assert.ok(!prompt?.sentEvidenceIds.includes(hit));
  });

  it('a tied shipping assessment reports numeric selection diagnostics, proposes nothing, and leaves the rule outcome', async () => {
    const MARKER = 'marker-5b7u';
    const { runtime, sends } = fakeRuntime((command) => {
      const evidence = promptData(command).evidence;
      const ids = evidence.map((item) => item.id);
      const source = evidence.find((item) => item.kind === 'source_code' && item.location.path === 'src/shipping.ts');
      const line = source?.lines?.find(([, text]) => text === SHIPPING_BUGGY_LINE)?.[0] ?? 0;
      return converseOutput(
        JSON.stringify({
          hypotheses: [
            { key: 'threshold-comparison', statement: `${MARKER}: ${SHIPPING_STATEMENT}`, supportingEvidenceIds: ids, contradictingEvidenceIds: [] },
            { key: `${MARKER}-test-expectation`, statement: `${MARKER}: the test expects the wrong total.`, supportingEvidenceIds: ids, contradictingEvidenceIds: [] },
          ],
          edit: { hypothesisKey: 'threshold-comparison', path: 'src/shipping.ts', line, originalText: SHIPPING_BUGGY_LINE, replacementText: SHIPPING_FIXED_LINE },
        }),
      );
    });
    const events: EscalationEvent[] = [];
    const rules = await investigate(SHIPPING_ROOT, SHIPPING, new RulePlanner());
    const escalated = await investigate(SHIPPING_ROOT, SHIPPING, new EscalatingPlanner({ model: new BedrockModelClient({ runtime }), onEvent: (event) => events.push(event) }));

    assert.equal(sends.length, 1);
    assert.equal(promptData(sends[0]!.command).evidence.length, 3);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.ok(event?.type === 'fallback');
    const { detail: _detail, ...safe } = event;
    assert.deepEqual(safe, {
      type: 'fallback',
      investigationId: 'inv-escalation',
      reason: 'invalid_output',
      stage: 'no_exclusive_winner',
      selectionDiagnostics: [
        { supportingCount: 3, contradictingCount: 0, computedConfidence: 0.75 },
        { supportingCount: 3, contradictingCount: 0, computedConfidence: 0.75 },
      ],
      editPresent: true,
    });
    const text = JSON.stringify(safe);
    assert.ok(!text.includes(MARKER) && !text.includes('ev-') && !text.includes('shipping'), 'numbers and fixed names only');
    assert.deepEqual(escalated.state.patchProposals, []);
    assert.deepEqual(escalated.state.hypotheses, []);
    assert.equal(normalizeTimings(escalated.events), normalizeTimings(rules.events));
  });

  it('selects the evidence-grounded cause over a distinct rival that the source contradicts, and repairs it', async () => {
    const rivalRuntime = () =>
      fakeRuntime((command) => {
        const evidence = promptData(command).evidence;
        const find = (kind: string, file?: string) => evidence.find((item) => item.kind === kind && (file === undefined || item.location.path === file));
        const source = find('source_code', 'src/shipping.ts');
        const test = find('source_code', 'test/shipping.test.ts');
        const run = find('command_output');
        const line = source?.lines?.find(([, text]) => text === SHIPPING_BUGGY_LINE)?.[0] ?? 0;
        return converseOutput(
          JSON.stringify({
            hypotheses: [
              { key: 'threshold-comparison', statement: SHIPPING_STATEMENT, supportingEvidenceIds: [source?.id, test?.id, run?.id], contradictingEvidenceIds: [] },
              {
                key: 'test-expectation',
                statement: 'The test expects free shipping at the threshold, but the threshold order should pay the flat rate.',
                supportingEvidenceIds: [run?.id],
                contradictingEvidenceIds: [source?.id],
              },
            ],
            edit: { hypothesisKey: 'threshold-comparison', path: 'src/shipping.ts', line, originalText: SHIPPING_BUGGY_LINE, replacementText: SHIPPING_FIXED_LINE },
          }),
        );
      });

    const recorded = rivalRuntime();
    const { state } = await investigate(SHIPPING_ROOT, SHIPPING, new EscalatingPlanner({ model: new BedrockModelClient({ runtime: recorded.runtime }) }));
    assert.equal(recorded.sends.length, 1);
    assert.deepEqual(
      state.hypotheses.map((item) => [item.id, item.status, item.confidence]),
      [
        ['hyp-model-threshold-comparison', 'selected', 0.75],
        ['hyp-model-test-expectation', 'weakened', 0.33],
      ],
    );
    assert.equal(state.patchProposals.at(-1)?.status, 'awaiting_verification');
    assert.deepEqual(state.patchProposals.at(-1)?.proposal.affectedPaths, ['src/shipping.ts']);

    const realGit = await resolveGitExecutable();
    const fixture = await createGitRepositoryFixture(realGit, SHIPPING_ROOT);
    const { runtime, sends } = rivalRuntime();
    const events: EscalationEvent[] = [];
    const run = await new GroundedRepairPipeline({
      allowedRoot: fixture.allowedRoot,
      git: realGit,
      planner: new EscalatingPlanner({ model: new BedrockModelClient({ runtime }), onEvent: (event) => events.push(event) }),
    }).run({ repositoryRoot: fixture.root, signal: SHIPPING });
    try {
      assert.equal(sends.length, 1);
      assert.deepEqual(events, [{ type: 'escalated', investigationId: events[0]?.investigationId, model: 'bedrock:amazon.nova-pro-v1:0', selectedHypothesisId: 'hyp-model-threshold-comparison' }]);
      assert.equal(run.proposal?.status, 'awaiting_verification');
      assert.equal(run.repair?.result.status, 'repaired', run.repair?.result.reason ?? undefined);
      assert.equal(run.grounding.valid, true);
      assert.equal(run.report.selectedHypothesis?.id, 'hyp-model-threshold-comparison');
    } finally {
      await run.repair?.workspace?.remove();
      await fixture.cleanup();
    }
  });

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

  describe('the edit path must be a read source file the selected hypothesis cites, written exactly', () => {
    interface ShippingIds {
      readonly src: string;
      readonly test: string;
      readonly run: string;
      readonly hit: string;
    }
    const cases: Array<[string, (ids: ShippingIds) => { support: string[]; path: string }, 'model_error' | 'edit_source_not_cited' | 'edit_path_unknown' | 'accepted', boolean?]> = [
      ['A: cites the search hit folded into src/shipping.ts, which was never sent', (ids) => ({ support: [ids.test, ids.run, ids.hit], path: 'src/shipping.ts' }), 'model_error'],
      ['B: cites only the test file and the test run', (ids) => ({ support: [ids.test, ids.run], path: 'src/shipping.ts' }), 'edit_source_not_cited', false],
      ['C: path written ./src/shipping.ts', (ids) => ({ support: [ids.src, ids.test, ids.run], path: './src/shipping.ts' }), 'edit_path_unknown', false],
      ['D: path written shipping.ts', (ids) => ({ support: [ids.src, ids.test, ids.run], path: 'shipping.ts' }), 'edit_path_unknown', false],
      ['E: path written <repo>/src/shipping.ts', (ids) => ({ support: [ids.src, ids.test, ids.run], path: '<repo>/src/shipping.ts' }), 'edit_path_unknown', false],
      ['F: cites the file read, path src/shipping.ts', (ids) => ({ support: [ids.src, ids.test, ids.run], path: 'src/shipping.ts' }), 'accepted'],
    ];

    for (const [name, choose, expected, citedSearchResult] of cases) {
      it(`${name}: ${expected}`, async () => {
        const hit = await shippingHitId();
        const { runtime, sends } = fakeRuntime((command) => {
          const evidence = promptData(command).evidence;
          const idOf = (kind: string, file?: string) => evidence.find((item) => item.kind === kind && (file === undefined || item.location.path === file))?.id ?? '';
          const ids = { src: idOf('source_code', 'src/shipping.ts'), test: idOf('source_code', 'test/shipping.test.ts'), run: idOf('command_output'), hit };
          const line = evidence.find((item) => item.id === ids.src)?.lines?.find(([, text]) => text === SHIPPING_BUGGY_LINE)?.[0] ?? 0;
          const { support, path: editPath } = choose(ids);
          return converseOutput(
            JSON.stringify({
              hypotheses: [{ key: 'threshold-comparison', statement: SHIPPING_STATEMENT, supportingEvidenceIds: support, contradictingEvidenceIds: [] }],
              edit: { hypothesisKey: 'threshold-comparison', path: editPath, line, originalText: SHIPPING_BUGGY_LINE, replacementText: SHIPPING_FIXED_LINE },
            }),
          );
        });
        const events: EscalationEvent[] = [];
        const { state } = await investigate(SHIPPING_ROOT, SHIPPING, new EscalatingPlanner({ model: new BedrockModelClient({ runtime }), onEvent: (event) => events.push(event) }));

        assert.equal(sends.length, 1);
        if (expected === 'accepted') {
          assert.deepEqual(events.map((event) => event.type), ['escalated']);
          assert.equal(state.patchProposals.at(-1)?.status, 'awaiting_verification');
          assert.deepEqual(state.patchProposals.at(-1)?.proposal.affectedPaths, ['src/shipping.ts']);
        } else {
          assert.deepEqual(
            events.map((event) => event.type === 'fallback' && [event.reason, event.stage, event.citedSearchResultAtEditPath]),
            [expected === 'model_error' ? ['model_error', undefined, undefined] : ['invalid_output', expected, citedSearchResult]],
          );
          assert.deepEqual(state.patchProposals, []);
          assert.deepEqual(state.hypotheses, [], 'the rule outcome stands');
        }
      });
    }

    interface Hypothesis {
      readonly key: string;
      readonly statement: string;
      readonly supportingEvidenceIds: readonly string[];
      readonly contradictingEvidenceIds: readonly string[];
    }
    interface EditShape {
      readonly hypotheses: readonly Hypothesis[];
      readonly edit: { readonly hypothesisKey: string; readonly path: string; readonly originalText: string; readonly replacementText: string };
    }
    const TEST_ASSERTION = '  assert.equal(quote.shipping, 0);';
    const CODE_BUG = 'threshold-comparison';
    const TEST_BUG = 'test-expectation';
    const TEST_BUG_STATEMENT = 'The test expects free shipping at the threshold, but the threshold order should pay the flat rate.';
    /** Selected hypotheses cite exactly two supporting items (confidence 0.66); every rival scores lower, so selection passes and the edit-source check refuses. */
    type EditSourceDiagnostics = readonly [editSourceCitedAs: string, editSourceCitedByRival: string, editTargetsSignalTest: boolean];
    const shapes: Array<[string, (ids: Omit<ShippingIds, 'hit'>) => EditShape, EditSourceDiagnostics]> = [
      [
        'B1: the selected hypothesis supports the test file and test run and edits src/shipping.ts; no rival cites that file',
        (ids) => ({
          hypotheses: [
            { key: CODE_BUG, statement: SHIPPING_STATEMENT, supportingEvidenceIds: [ids.test, ids.run], contradictingEvidenceIds: [] },
            { key: 'flat-rate', statement: 'The caller passes the wrong flat rate.', supportingEvidenceIds: [], contradictingEvidenceIds: [ids.test] },
          ],
          edit: { hypothesisKey: CODE_BUG, path: 'src/shipping.ts', originalText: SHIPPING_BUGGY_LINE, replacementText: SHIPPING_FIXED_LINE },
        }),
        ['none', 'none', false],
      ],
      [
        'B2: as B1, with a distinct rival that src/shipping.ts contradicts',
        (ids) => ({
          hypotheses: [
            { key: CODE_BUG, statement: SHIPPING_STATEMENT, supportingEvidenceIds: [ids.test, ids.run], contradictingEvidenceIds: [] },
            { key: TEST_BUG, statement: TEST_BUG_STATEMENT, supportingEvidenceIds: [ids.run], contradictingEvidenceIds: [ids.src] },
          ],
          edit: { hypothesisKey: CODE_BUG, path: 'src/shipping.ts', originalText: SHIPPING_BUGGY_LINE, replacementText: SHIPPING_FIXED_LINE },
        }),
        ['none', 'contradicting', false],
      ],
      [
        'B3: the selected hypothesis supports src/shipping.ts and the test run and edits test/shipping.test.ts, which it does not cite',
        (ids) => ({
          hypotheses: [
            { key: TEST_BUG, statement: TEST_BUG_STATEMENT, supportingEvidenceIds: [ids.src, ids.run], contradictingEvidenceIds: [] },
            { key: CODE_BUG, statement: SHIPPING_STATEMENT, supportingEvidenceIds: [ids.test], contradictingEvidenceIds: [] },
          ],
          edit: { hypothesisKey: TEST_BUG, path: 'test/shipping.test.ts', originalText: TEST_ASSERTION, replacementText: '  assert.equal(quote.shipping, 500);' },
        }),
        ['none', 'supporting', true],
      ],
    ];

    it('B1, B2, and B3 share a refusal stage but report distinct edit-source diagnostics', () => {
      const reported = shapes.map(([, , diagnostics]) => JSON.stringify(diagnostics));
      assert.equal(new Set(reported).size, shapes.length);
    });

    for (const [name, shape, diagnostics] of shapes) {
      it(`${name}: edit_source_not_cited, with no proposal and no repair`, async () => {
        const answer = () =>
          fakeRuntime((command) => {
            const evidence = promptData(command).evidence;
            const idOf = (kind: string, file?: string) => evidence.find((item) => item.kind === kind && (file === undefined || item.location.path === file))?.id ?? '';
            const ids = { src: idOf('source_code', 'src/shipping.ts'), test: idOf('source_code', 'test/shipping.test.ts'), run: idOf('command_output') };
            assert.ok(ids.src && ids.test && ids.run, 'every cited ID is one the prompt shows');
            const { hypotheses, edit } = shape(ids);
            const edited = evidence.find((item) => item.kind === 'source_code' && item.location.path === edit.path);
            const line = edited?.lines?.find(([, text]) => text === edit.originalText)?.[0];
            assert.ok(line !== undefined, 'the edit quotes a line the prompt shows');
            return converseOutput(JSON.stringify({ hypotheses, edit: { ...edit, line } }));
          });

        const events: EscalationEvent[] = [];
        const replies = answer();
        const rules = await investigate(SHIPPING_ROOT, SHIPPING, new RulePlanner());
        const escalated = await investigate(SHIPPING_ROOT, SHIPPING, new EscalatingPlanner({ model: new BedrockModelClient({ runtime: replies.runtime }), onEvent: (event) => events.push(event) }));
        assert.equal(replies.sends.length, 1);
        assert.deepEqual(
          events.map((event) => [event.type, event.type === 'fallback' && [event.reason, event.stage, event.citedSearchResultAtEditPath]]),
          [['fallback', ['invalid_output', 'edit_source_not_cited', false]]],
          'refused at the edit-source check, after selection passed, and never reported as escalated',
        );
        const [event] = events;
        assert.ok(event?.type === 'fallback');
        assert.deepEqual([event.editSourceCitedAs, event.editSourceCitedByRival, event.editTargetsSignalTest], diagnostics);
        const { detail: _detail, ...safe } = event;
        for (const forbidden of ['ev-', 'shipping', SHIPPING_BUGGY_LINE.trim(), TEST_BUG_STATEMENT]) {
          assert.ok(!JSON.stringify(safe).includes(forbidden), `the diagnostics carry no ${forbidden}`);
        }
        assert.deepEqual(escalated.state.patchProposals, []);
        assert.deepEqual(escalated.state.hypotheses, [], 'the rule outcome stands');
        assert.equal(normalizeTimings(escalated.events), normalizeTimings(rules.events));

        const realGit = await resolveGitExecutable();
        const fixture = await createGitRepositoryFixture(realGit, SHIPPING_ROOT);
        const pipelineReplies = answer();
        const pipelineEvents: EscalationEvent[] = [];
        const run = await new GroundedRepairPipeline({
          allowedRoot: fixture.allowedRoot,
          git: realGit,
          planner: new EscalatingPlanner({ model: new BedrockModelClient({ runtime: pipelineReplies.runtime }), onEvent: (event) => pipelineEvents.push(event) }),
        }).run({ repositoryRoot: fixture.root, signal: SHIPPING });
        try {
          assert.equal(pipelineReplies.sends.length, 1);
          assert.deepEqual(
            pipelineEvents.map((event) => event.type === 'fallback' && event.stage),
            ['edit_source_not_cited'],
          );
          assert.equal(run.proposal, undefined, 'no proposal passed review');
          assert.equal(run.repair, undefined, 'no repair was attempted');
        } finally {
          await run.repair?.workspace?.remove();
          await fixture.cleanup();
        }
      });
    }
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
