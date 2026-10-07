import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import {
  HypothesisSchema,
  InvestigationEventSchema,
  type Hypothesis,
  type InvestigationEvent,
  type Signal,
} from '@devpilot/core';
import { InvestigationEngine, replayInvestigation, type InvestigationState } from '@devpilot/engine';
import { PlannerDecisionSchema, RulePlanner, type Planner, type PlannerContext, type PlannerDecision } from '@devpilot/planners';
import { createDefaultToolRegistry, RepositorySandbox } from '@devpilot/tools';

const CHECKOUT_ROOT = fileURLToPath(new URL('../fixtures/sample-repository/', import.meta.url));
const PLANNER_SOURCE = fileURLToPath(new URL('../packages/planners/src/', import.meta.url));
const START = Date.parse('2026-01-01T00:00:00.000Z');

const CHECKOUT_SIGNAL: Signal = {
  id: 'sig-checkout-tax',
  kind: 'failing_test',
  title: 'Checkout total is too high when a discount code is used',
  content: 'not ok 2 - applies tax to the discounted amount\n    200 !== 180',
  command: 'npm test',
  receivedAt: '2026-01-01T00:00:00.000Z',
};

const PAYROLL_PACKAGE = JSON.stringify({
  name: 'payroll',
  private: true,
  type: 'module',
  scripts: { test: 'node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/payroll.test.ts' },
});
const payrollSource = (rate: string, pensionBase: string) =>
  [
    `export const PENSION_RATE = ${rate};`,
    '',
    'export function payslip(hours: number, hourlyRate: number, bonus: number) {',
    '  const base = hours * hourlyRate;',
    '  const gross = base + bonus;',
    `  const pension = Math.floor(${pensionBase} * PENSION_RATE);`,
    '  return { base, gross, pension };',
    '}',
    '',
  ].join('\n');
const payrollTest = (firstTestChecksPension: boolean) =>
  [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { payslip } from '../src/payroll.ts';",
    '',
    "test('pays hourly wages without a bonus', () => {",
    '  const slip = payslip(10, 100, 0);',
    '  assert.equal(slip.base, 1000);',
    ...(firstTestChecksPension ? ['  assert.equal(slip.pension, 50);'] : []),
    '});',
    '',
    "test('deducts pension from gross pay', () => {",
    '  const slip = payslip(10, 100, 200);',
    '  assert.equal(slip.gross, 1200);',
    '  assert.equal(slip.pension, 60);',
    '});',
    '',
  ].join('\n');
const PAYROLL_SIGNAL: Signal = {
  id: 'sig-payroll',
  kind: 'failing_test',
  title: 'Pension deduction ignores the bonus',
  content: 'not ok 2 - deducts pension from gross pay',
  command: 'npm test',
  receivedAt: '2026-01-01T00:00:00.000Z',
};

async function investigate(root: string, signal: Signal, planner: Planner = new RulePlanner()) {
  let tick = START;
  const engine = new InvestigationEngine({
    planner,
    tools: createDefaultToolRegistry(await RepositorySandbox.create(root)),
    clock: () => (tick += 1000),
    generateId: () => 'inv-planner',
  });
  const session = await engine.investigate(signal);
  const state = session.state;
  assert.ok(state);
  assert.deepEqual(replayInvestigation(session.events), state, 'state is exactly the replayed event log');
  for (const event of session.events) InvestigationEventSchema.parse(JSON.parse(JSON.stringify(event)));
  return { events: session.events, state };
}

/**
 * The test runner prints wall-clock durations, so raw command output (and the
 * content-addressed IDs of evidence built from it) differs between runs. Mask
 * the durations and number evidence IDs by first appearance; everything else
 * must be identical.
 */
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

const hypothesisUpdates = (events: readonly InvestigationEvent[]) =>
  events.flatMap((event) => (event.type === 'hypotheses_updated' ? [event] : []));
const byId = (state: InvestigationState, id: string) => state.hypotheses.find((item) => item.id === id);

/** Wraps the rule planner, replacing selected decisions to simulate a misbehaving (e.g. model-backed) planner. */
function overriding(override: (decision: PlannerDecision, context: PlannerContext) => unknown): Planner {
  const inner = new RulePlanner();
  return {
    name: 'overriding',
    next: async (context) => override(await inner.next(context), context) as PlannerDecision,
  };
}

describe('evidence-grounded rule planner on the checkout incident', () => {
  let run: Awaited<ReturnType<typeof investigate>>;
  before(async () => {
    run = await investigate(CHECKOUT_ROOT, CHECKOUT_SIGNAL);
  });

  it('collects evidence before hypothesising: reproduce, read the test, find and read the computation', () => {
    assert.deepEqual(
      run.state.actions.map((action) => [action.tool, action.input]),
      [
        ['run_command', { command: 'npm', args: ['test'] }],
        ['read_file', { path: 'test/checkout.test.ts' }],
        ['search_code', { query: 'tax =' }],
        ['read_file', { path: 'src/checkout.ts' }],
      ],
    );
    const firstUpdate = run.events.findIndex((event) => event.type === 'hypotheses_updated');
    const lastEvidence = run.events.findLastIndex((event) => event.type === 'action_completed');
    assert.ok(lastEvidence < firstUpdate);
  });

  it('A: forms multiple competing hypotheses, all unassessed at first', () => {
    const [proposed] = hypothesisUpdates(run.events);
    assert.ok(proposed);
    assert.ok(proposed.hypotheses.length >= 3, `expected competing hypotheses, got ${proposed.hypotheses.length}`);
    assert.equal(new Set(proposed.hypotheses.map((item) => item.id)).size, proposed.hypotheses.length);
    for (const hypothesis of proposed.hypotheses) {
      assert.equal(hypothesis.status, 'proposed');
      assert.equal(hypothesis.confidence, 0);
      assert.deepEqual([hypothesis.supportingEvidenceIds, hypothesis.contradictingEvidenceIds], [[], []]);
    }
    assert.deepEqual(
      proposed.hypotheses.map((item) => item.id),
      ['hyp-input-tax-subtotal-discounted', 'hyp-value-subtotal', 'hyp-value-discounted', 'hyp-constant-tax-rate'],
    );
  });

  it('B: evidence supports one hypothesis and weakens the others, citing collected evidence', () => {
    const assessed = hypothesisUpdates(run.events)[1];
    assert.ok(assessed);
    const status = Object.fromEntries(assessed.hypotheses.map((item) => [item.id, [item.status, item.confidence]]));
    assert.deepEqual(status, {
      'hyp-input-tax-subtotal-discounted': ['supported', 0.8],
      'hyp-value-subtotal': ['weakened', 0],
      'hyp-value-discounted': ['weakened', 0],
      'hyp-constant-tax-rate': ['weakened', 0],
    });
    const collected = new Set(run.state.evidence.map((item) => item.id));
    for (const hypothesis of assessed.hypotheses) {
      for (const id of [...hypothesis.supportingEvidenceIds, ...hypothesis.contradictingEvidenceIds]) {
        assert.ok(collected.has(id), `${hypothesis.id} cites uncollected evidence ${id}`);
      }
      assert.equal(hypothesis.confidence <= HypothesisSchema.parse(hypothesis).confidence, true);
    }
    const kinds = (hypothesis: Hypothesis | undefined) =>
      new Set(
        (hypothesis?.contradictingEvidenceIds ?? []).map((id) => run.state.evidence.find((item) => item.id === id)?.kind),
      );
    assert.deepEqual(kinds(byId(run.state, 'hyp-value-discounted')), new Set(['source_code', 'command_output']));
  });

  it('selects only the best-supported hypothesis, after assessment, without claiming certainty', () => {
    const selections = hypothesisUpdates(run.events).filter((event) => event.hypotheses.some((item) => item.status === 'selected'));
    assert.equal(selections.length, 1);
    const selected = run.state.hypotheses.filter((item) => item.status === 'selected');
    assert.deepEqual(selected.map((item) => item.id), ['hyp-input-tax-subtotal-discounted']);
    assert.ok((selected[0]?.confidence ?? 1) < 1);
    assert.equal(selected[0]?.supportingEvidenceIds.length, 4);
  });

  it('E: every action has a reason, expected evidence, a status, and its resulting evidence IDs', () => {
    for (const action of run.state.actions) {
      assert.ok(action.rationale.length > 20, action.id);
      assert.ok(action.expectedEvidence.length > 10, action.id);
      assert.equal(action.status, 'completed');
      assert.ok(action.resultingEvidenceIds.length > 0);
      for (const id of action.resultingEvidenceIds) {
        assert.equal(run.state.evidence.find((item) => item.id === id)?.source.actionId, action.id);
      }
    }
  });

  it('F: produces a reviewed patch proposal backed by the selected hypothesis evidence; nothing is applied', async () => {
    const [record] = run.state.patchProposals;
    assert.ok(record);
    assert.equal(record.status, 'awaiting_verification');
    assert.deepEqual(record.violations, []);
    const { proposal } = record;
    const selected = byId(run.state, proposal.hypothesisId);
    assert.equal(selected?.status, 'selected');
    assert.ok(proposal.supportingEvidenceIds.length > 0);
    for (const id of proposal.supportingEvidenceIds) assert.ok(selected?.supportingEvidenceIds.includes(id));
    assert.deepEqual(proposal.affectedPaths, ['src/checkout.ts']);
    assert.match(proposal.patch, /^-  const tax = Math\.round\(subtotal \* TAX_RATE\);$/m);
    assert.match(proposal.patch, /^\+  const tax = Math\.round\(discounted \* TAX_RATE\);$/m);
    assert.ok(proposal.confidence <= (selected?.confidence ?? 0));
    assert.ok(!run.state.actions.some((action) => action.tool === 'apply_patch'));
    assert.match(await readFile(path.join(CHECKOUT_ROOT, 'src/checkout.ts'), 'utf8'), /Math\.round\(subtotal \* TAX_RATE\)/);
    assert.equal(run.state.status, 'completed');
    assert.match(run.state.terminalReason ?? '', /awaiting verification by the repair workflow/);
    assert.equal(run.state.repair, undefined);
  });

  it('U: the same incident, repository, and evidence give the same hypotheses, actions, and proposal', async () => {
    const again = await investigate(CHECKOUT_ROOT, CHECKOUT_SIGNAL);
    assert.deepEqual(normalizeTimings(again.events), normalizeTimings(run.events));
    const planner = new RulePlanner();
    const context = structuredClone({
      investigationId: run.state.investigationId,
      signal: run.state.signal,
      stepCount: 4,
      remainingSteps: 21,
      actions: run.state.actions,
      evidence: run.state.evidence,
      hypotheses: [],
      verifications: [],
      patchProposals: [],
      tools: createDefaultToolRegistry(await RepositorySandbox.create(CHECKOUT_ROOT)).describe(),
    }) satisfies PlannerContext;
    assert.deepEqual(await planner.next(context), await planner.next(structuredClone(context)));
  });

  it('G: at every step of the replayed log, fresh and reused planners make the decision the session recorded, in any call order', async () => {
    const contexts: { context: PlannerContext; next: InvestigationEvent }[] = [];
    const tools = createDefaultToolRegistry(await RepositorySandbox.create(CHECKOUT_ROOT)).describe().map(({ name, description }) => ({ name, description }));
    for (let index = 1; index < run.events.length; index += 1) {
      const state = replayInvestigation(run.events.slice(0, index));
      const next = run.events[index];
      if (!next || state.status !== 'running' || state.actions.some((action) => action.status === 'planned') || next.type === 'patch_reviewed') continue;
      contexts.push({
        next,
        context: {
          investigationId: state.investigationId,
          signal: state.signal,
          stepCount: state.stepCount,
          remainingSteps: state.budget.maxSteps - state.stepCount,
          actions: state.actions,
          evidence: state.evidence,
          hypotheses: state.hypotheses,
          verifications: state.verifications,
          patchProposals: state.patchProposals,
          tools,
        } as PlannerContext,
      });
    }
    assert.equal(contexts.length, run.state.stepCount + 1, 'one planner call per step, plus the final finish');

    const shared = new RulePlanner();
    const decide = async (planner: Planner, context: PlannerContext) => planner.next(structuredClone(context));
    const forward = await Promise.all(contexts.map(({ context }) => decide(shared, context)));
    const backward = (await Promise.all([...contexts].reverse().map(({ context }) => decide(shared, context)))).reverse();
    const fresh = await Promise.all(contexts.map(({ context }) => decide(new RulePlanner(), context)));
    assert.deepEqual(backward, forward);
    assert.deepEqual(fresh, forward);

    for (const [index, decision] of forward.entries()) {
      const recorded = contexts[index]?.next;
      assert.ok(recorded);
      const recordedType = { action_planned: 'act', hypotheses_updated: 'update_hypotheses', patch_proposed: 'propose_patch', investigation_completed: 'finish' }[recorded.type as string];
      assert.equal(decision.type, recordedType, `step ${index}`);
      if (decision.type === 'act' && recorded.type === 'action_planned') assert.deepEqual(decision.input, recorded.action.input);
      if (decision.type === 'update_hypotheses' && recorded.type === 'hypotheses_updated') assert.deepEqual(decision.hypotheses, recorded.hypotheses);
      if (decision.type === 'propose_patch' && recorded.type === 'patch_proposed') assert.deepEqual(decision.proposal, recorded.proposal);
    }
  });
});

describe('the planner is generic, not tuned to the checkout fixture', () => {
  let base: string;
  const repository = async (name: string, source: string, test: string) => {
    const root = path.join(base, name);
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'test'));
    await writeFile(path.join(root, 'package.json'), PAYROLL_PACKAGE);
    await writeFile(path.join(root, 'src/payroll.ts'), source);
    await writeFile(path.join(root, 'test/payroll.test.ts'), test);
    return root;
  };
  before(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'devpilot-planner-'));
  });
  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('Q: no fixture vocabulary appears in planner, review, repair, or report code', async () => {
    const packages = fileURLToPath(new URL('../packages/', import.meta.url));
    for (const name of ['core', 'tools', 'planners', 'engine']) {
      const directory = path.join(packages, name, 'src');
      for (const file of (await readdir(directory, { recursive: true })).filter((entry) => entry.endsWith('.ts'))) {
        const source = await readFile(path.join(directory, file), 'utf8');
        assert.doesNotMatch(source, /checkout\.ts|checkout\(|\btax\b|tax_rate|discount|subtotal|payroll|pension|\bgross\b|INC-001|traceroot/i, `${name}/src/${file}`);
      }
    }
  });

  it('reasons the same way about an unrelated domain and proposes the analogous substitution', async () => {
    const root = await repository('payroll', payrollSource('0.05', 'base'), payrollTest(true));
    const { state } = await investigate(root, PAYROLL_SIGNAL);
    assert.deepEqual(
      state.hypotheses.map((item) => [item.id, item.status]),
      [
        ['hyp-input-pension-base-gross', 'selected'],
        ['hyp-value-base', 'weakened'],
        ['hyp-value-gross', 'weakened'],
        ['hyp-constant-pension-rate', 'weakened'],
      ],
    );
    const proposal = state.patchProposals[0]?.proposal;
    assert.equal(state.patchProposals[0]?.status, 'awaiting_verification');
    assert.deepEqual(proposal?.affectedPaths, ['src/payroll.ts']);
    assert.match(proposal?.patch ?? '', /^\+  const pension = Math\.floor\(gross \* PENSION_RATE\);$/m);
  });

  it('D: selects nothing and proposes nothing when no hypothesis has enough supporting evidence', async () => {
    const root = await repository('payroll-rate', payrollSource('0.04', 'gross'), payrollTest(false));
    const { state, events } = await investigate(root, PAYROLL_SIGNAL);
    assert.ok(state.hypotheses.length >= 2);
    assert.ok(!state.hypotheses.some((item) => item.status === 'selected' || item.status === 'supported'));
    assert.deepEqual(byId(state, 'hyp-constant-pension-rate')?.status, 'proposed');
    assert.deepEqual(state.patchProposals, []);
    assert.ok(!events.some((event) => event.type === 'patch_proposed'));
    assert.match(state.terminalReason ?? '', /No hypothesis is sufficiently supported/);
  });
});

describe('the planner proposes; it cannot act, write, select without evidence, or claim success', () => {
  it('C: a hypothesis cannot be selected without enough supporting evidence', async () => {
    const unsupported = {
      id: 'hyp-guess',
      statement: 'A guess',
      status: 'selected',
      confidence: 0,
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      nextActionReason: 'Selected',
    };
    assert.equal(HypothesisSchema.safeParse(unsupported).success, false);
    const { state } = await investigate(
      CHECKOUT_ROOT,
      CHECKOUT_SIGNAL,
      overriding((decision, context) =>
        context.hypotheses.length === 0 && decision.type === 'update_hypotheses'
          ? { type: 'update_hypotheses', hypotheses: [unsupported] }
          : decision,
      ),
    );
    assert.equal(state.status, 'failed');
    assert.ok(!state.hypotheses.some((item) => item.status === 'selected'));
  });

  it('C: selection must be exclusive; a rival as confident blocks it', async () => {
    const { state } = await investigate(
      CHECKOUT_ROOT,
      CHECKOUT_SIGNAL,
      overriding((decision, context) => {
        const supported = context.hypotheses.find((item) => item.status === 'supported');
        if (decision.type !== 'update_hypotheses' || !supported || !decision.hypotheses.some((item) => item.status === 'selected')) {
          return decision;
        }
        const rival = { ...supported, id: 'hyp-rival', statement: 'A rival with the same evidence' };
        return { type: 'update_hypotheses', hypotheses: [rival, ...decision.hypotheses] };
      }),
    );
    assert.equal(state.status, 'failed');
    assert.match(state.terminalReason ?? '', /not more confident than hyp-rival/);
    assert.deepEqual(state.patchProposals, []);
  });

  it('N: the planner cannot run a command itself, and engine-run commands stay behind the command policy', async () => {
    const { state } = await investigate(
      CHECKOUT_ROOT,
      CHECKOUT_SIGNAL,
      overriding((_decision, context) =>
        context.actions.length === 0
          ? { type: 'act', tool: 'run_command', input: { command: 'sh', args: ['-c', 'touch pwned'] }, rationale: 'x', expectedEvidence: 'x' }
          : { type: 'finish', reason: 'done' },
      ),
    );
    assert.equal(state.actions[0]?.status, 'failed');
    assert.match(state.actions[0]?.error ?? '', /not allowed|refused|policy/i);
    assert.ok(!(await readdir(CHECKOUT_ROOT)).includes('pwned'));

    for (const tool of ['apply_patch', 'shell', 'write_file', 'git']) {
      const decision = { type: 'act', tool, input: {}, rationale: 'x', expectedEvidence: 'x' };
      assert.equal(PlannerDecisionSchema.safeParse(decision).success, false, tool);
    }
    const refused = await investigate(
      CHECKOUT_ROOT,
      CHECKOUT_SIGNAL,
      overriding(() => ({ type: 'act', tool: 'apply_patch', input: { patch: 'x' }, rationale: 'x', expectedEvidence: 'x' })),
    );
    assert.equal(refused.state.status, 'failed');
    assert.deepEqual(refused.state.actions, []);
  });

  it('N, O: planner code has no process, file-system, or network access, and its context is inert data', async () => {
    const files = (await readdir(PLANNER_SOURCE, { recursive: true })).filter((file) => file.endsWith('.ts'));
    for (const file of files) {
      const source = await readFile(path.join(PLANNER_SOURCE, file), 'utf8');
      const imports = [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gms)].map((match) => [match[2], match[1] !== undefined]);
      for (const [specifier, typeOnly] of imports) {
        const allowed =
          specifier === 'zod' ||
          specifier === '@devpilot/core' ||
          specifier === 'node:path/posix' ||
          String(specifier).startsWith('./') ||
          (specifier === '@devpilot/tools' && typeOnly === true);
        assert.ok(allowed, `${file} imports ${specifier}`);
      }
      assert.doesNotMatch(source, /\b(child_process|spawn|execFile|writeFile|fetch|process\.)\b|\beval\(|new Function/, file);
      assert.doesNotMatch(source, /\bDate\b|Math\.random|performance\.now|crypto|globalThis|\brequire\(|\bimport\(|setTimeout|setInterval/, file);
    }

    let seen: PlannerContext | undefined;
    const { state } = await investigate(CHECKOUT_ROOT, CHECKOUT_SIGNAL, {
      name: 'mutating',
      next: async (context) => {
        seen ??= context;
        assert.throws(() => {
          (context.actions as unknown[]).push({ id: 'forged' });
        }, TypeError);
        assert.throws(() => {
          (context.signal as { command?: string }).command = 'rm -rf /';
        }, TypeError);
        return { type: 'finish', reason: 'done' };
      },
    });
    assert.equal(state.status, 'completed', state.terminalReason);
    assert.equal(state.terminalReason, 'done');
    assert.equal(state.signal.command, 'npm test');
    const functions: string[] = [];
    const walk = (value: unknown, at: string) => {
      if (typeof value === 'function') functions.push(at);
      else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) walk(child, `${at}.${key}`);
    };
    walk(seen, 'context');
    assert.deepEqual(functions, []);
  });

  it('P: the planner cannot report a repair outcome; extra status fields are refused', async () => {
    const outcomes = [
      { type: 'finish', reason: 'done', status: 'repaired' },
      { type: 'repaired', reason: 'fixed' },
      { type: 'verified' },
    ];
    for (const decision of outcomes) assert.equal(PlannerDecisionSchema.safeParse(decision).success, false, JSON.stringify(decision));

    const { state, events } = await investigate(
      CHECKOUT_ROOT,
      CHECKOUT_SIGNAL,
      overriding((decision) =>
        decision.type === 'propose_patch' ? { ...decision, proposal: { ...decision.proposal, status: 'repaired' } } : decision,
      ),
    );
    assert.equal(state.status, 'failed');
    assert.deepEqual(state.patchProposals, []);
    assert.ok(!JSON.stringify(events).includes('"repaired"'));
  });

  it('H: tool fields the planner may not set (shell, env, executable path) fail the action instead of being dropped', async () => {
    const smuggled = [{ shell: true }, { env: { NODE_OPTIONS: '--require ./evil.js' } }, { executable: '/bin/sh' }];
    for (const extra of smuggled) {
      let first = true;
      const { state } = await investigate(
        CHECKOUT_ROOT,
        CHECKOUT_SIGNAL,
        overriding((decision) => {
          if (!first || decision.type !== 'act') return decision;
          first = false;
          return { ...decision, input: { ...decision.input, ...extra } };
        }),
      );
      const [action] = state.actions;
      assert.equal(action?.status, 'failed', JSON.stringify(extra));
      assert.match(action?.error ?? '', /unknown field\(s\)/);
      assert.deepEqual(action?.resultingEvidenceIds, []);
    }
  });

  it('L: after its proposal passes review, a planner can only finish; acting again fails the investigation', async () => {
    const { state } = await investigate(
      CHECKOUT_ROOT,
      CHECKOUT_SIGNAL,
      overriding((decision, context) =>
        decision.type === 'finish' && context.patchProposals.some((record) => record.status === 'awaiting_verification')
          ? { type: 'act', tool: 'read_file', input: { path: 'src/cart.ts' }, rationale: 'Look again', expectedEvidence: 'More source' }
          : decision,
      ),
    );
    assert.equal(state.status, 'failed');
    assert.match(state.terminalReason ?? '', /chose act after proposal proposal-1 passed review/);
    assert.equal(state.actions.length, 4, 'no action was recorded after the proposal');
  });

  it('a proposal that violates policy is recorded as rejected, exactly as proposed', async () => {
    const extra = ['--- a/test/checkout.test.ts', '+++ b/test/checkout.test.ts', '@@ -1,1 +1,1 @@', "-import assert from 'node:assert/strict';", "+import assert from 'node:assert';", ''].join('\n');
    let proposed: string | undefined;
    const { state } = await investigate(
      CHECKOUT_ROOT,
      CHECKOUT_SIGNAL,
      overriding((decision) => {
        if (decision.type !== 'propose_patch') return decision;
        proposed = decision.proposal.patch + extra;
        return { ...decision, proposal: { ...decision.proposal, patch: proposed, affectedPaths: ['src/checkout.ts', 'test/checkout.test.ts'] } };
      }),
    );
    const [record] = state.patchProposals;
    assert.equal(record?.status, 'patch_rejected');
    assert.equal(record?.proposal.patch, proposed);
    assert.deepEqual(record?.violations.map((item) => item.code), ['test_file', 'too_many_files']);
    assert.equal(state.status, 'completed');
    assert.match(state.terminalReason ?? '', /rejected by review \(test_file, too_many_files\)/);
  });
});
