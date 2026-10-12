import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  identifyFailures,
  RepairResultSchema,
  type FailureIdentity,
  type RepairRequest,
  type RepairStatus,
  type Signal,
} from '@devpilot/core';
import {
  BASELINE_VERIFICATION_ID,
  PATCH_PATH_RULES,
  REPAIR_VERIFICATION_ID,
  RepairRequestError,
  RepairWorkflow,
  replayInvestigation,
  type RepairRun,
} from '@devpilot/engine';
import { GitWorktreeWorkspace, resolveGitExecutable, type GitExecutable } from '@devpilot/tools';
import {
  createGitRepositoryFixture,
  git,
  listWorktrees,
  snapshotRepository,
  type GitRepositoryFixture,
  type RepositorySnapshot,
} from '../packages/tools/test/support/git-repository.js';

const SIGNAL: Signal = {
  id: 'sig-checkout-tax',
  kind: 'failing_test',
  title: 'Checkout charges tax on the pre-discount subtotal',
  content: [
    'not ok 2 - applies tax to the discounted amount',
    '  error: |-',
    '    Expected values to be strictly equal:',
    '    200 !== 180',
    'ok 3 - reports declined payments',
  ].join('\n'),
  command: 'npm test',
  receivedAt: '2026-01-01T00:00:00.000Z',
};
const EXPECTED_FAILURE = ['applies tax to the discounted amount', '200 !== 180'];
const TARGET = 'applies tax to the discounted amount';

const patch = (...lines: string[]): string => `${lines.join('\n')}\n`;
const BUGGY_TAX = '  const tax = Math.round(subtotal * TAX_RATE);';
const FIXED_TAX = '  const tax = Math.round(discounted * TAX_RATE);';
const FIX_TAX = patch(
  '--- a/src/checkout.ts',
  '+++ b/src/checkout.ts',
  '@@ -31,5 +31,5 @@ export async function checkout(',
  '   const subtotal = cart.subtotal();',
  '   const discounted = applyDiscount(subtotal, options.discountCode);',
  `-${BUGGY_TAX}`,
  `+${FIXED_TAX}`,
  '   const total = discounted + tax;',
  ' ',
);
/** Source-only: the module that the test file imports exits the process as it loads. */
const EXIT_ON_IMPORT = patch('--- a/src/checkout.ts', '+++ b/src/checkout.ts', '@@ -1 +1,2 @@', '+process.exit(0);', " import type { Cart } from './cart.ts';");
/** Source-only: exits from inside the failing test, after the first test has passed. */
const EXIT_DURING_TEST = patch(
  '--- a/src/checkout.ts',
  '+++ b/src/checkout.ts',
  '@@ -31,2 +31,3 @@ export async function checkout(',
  '   const subtotal = cart.subtotal();',
  '+  if (options.discountCode !== undefined) process.exit(0);',
  '   const discounted = applyDiscount(subtotal, options.discountCode);',
);
const TARGET_DECLARATION = `test('${TARGET}', async () => {`;
const testPatch = (...hunks: string[][]) => patch('--- a/test/checkout.test.ts', '+++ b/test/checkout.test.ts', ...hunks.flat());
const replaceDeclaration = (replacement: string) => ['@@ -20 +20 @@', `-${TARGET_DECLARATION}`, `+${replacement}`];
const appendTest = (...lines: string[]) => [
  `@@ -33,3 +33,${3 + lines.length + 1} @@`,
  '     /Payment declined for order-3/,',
  '   );',
  ' });',
  '+',
  ...lines.map((line) => `+${line}`),
];
const SKIP_TARGET = testPatch(replaceDeclaration(`test.skip('${TARGET}', async () => {`));
const TODO_TARGET = testPatch(replaceDeclaration(`test('${TARGET}', { todo: true }, async () => {`));
const DELETE_TARGET = testPatch([
  '@@ -20,10 +19,0 @@',
  `-${TARGET_DECLARATION}`,
  '-  const receipt = await checkout(cartWithTwoMugs(), new FakePaymentGateway(), {',
  "-    orderId: 'order-2',",
  "-    discountCode: 'WELCOME10',",
  '-  });',
  '-  assert.equal(receipt.discounted, 2250);',
  '-  assert.equal(receipt.tax, 180);',
  '-  assert.equal(receipt.total, 2430);',
  '-});',
  '-',
]);
const RENAME_TARGET = FIX_TAX + testPatch(replaceDeclaration("test('applies tax after the discount', async () => {"));
const ADD_SIMILAR_PASSING_TEST = testPatch(appendTest(`test('${TARGET} quickly', () => {`, '  assert.ok(true);', '});'));
const REPLACE_WITH_SAME_NAME = testPatch(
  replaceDeclaration(`test.skip('${TARGET}', async () => {`),
  appendTest(`test('${TARGET}', () => {`, '  assert.ok(true);', '});'),
);
/** Rewrites the failing assertions to expect what the buggy code computes; src/checkout.ts is untouched. */
const ACCEPT_BUGGY_TAX = testPatch([
  '@@ -26,2 +26,2 @@',
  '-  assert.equal(receipt.tax, 180);',
  '-  assert.equal(receipt.total, 2430);',
  '+  assert.equal(receipt.tax, 200);',
  '+  assert.equal(receipt.total, 2450);',
]);

describe('failure-specific verification: the baseline failure itself must pass', () => {
  let realGit: GitExecutable;
  let fixture: GitRepositoryFixture;
  let original: RepositorySnapshot;
  const retained: GitWorktreeWorkspace[] = [];

  const request = (patchText: string, overrides: Partial<RepairRequest> = {}): RepairRequest => ({
    repositoryRoot: fixture.root,
    signal: SIGNAL,
    verification: { command: 'npm', args: ['test'], expectedFailure: EXPECTED_FAILURE },
    patch: patchText,
    description: 'Candidate repair',
    ...overrides,
  });
  const repair = async (patchText: string, overrides: Partial<RepairRequest> = {}): Promise<RepairRun> => {
    let tick = Date.parse(SIGNAL.receivedAt);
    const run = await new RepairWorkflow({
      allowedRoot: fixture.allowedRoot,
      git: realGit,
      clock: () => (tick += 1000),
      generateId: () => 'repair-identity',
    }).repair(request(patchText, overrides));
    if (run.workspace) retained.push(run.workspace);
    assert.deepEqual(replayInvestigation(run.events), run.state, 'the log replays to the returned state');
    RepairResultSchema.parse(run.result);
    return run;
  };
  const evidenceContent = (run: RepairRun, id: string | null) => run.state.evidence.find((item) => item.id === id)?.content ?? '';
  /** P: whatever happened, the original checkout is byte-for-byte unchanged and no worktree is left behind. */
  const assertNotRepaired = async (run: RepairRun, status: RepairStatus, reason: RegExp) => {
    assert.equal(run.result.status, status, run.result.reason ?? undefined);
    assert.match(run.result.reason ?? '', reason);
    assert.notEqual(run.state.repair?.phase, 'verified');
    assert.ok(!run.events.some((event) => event.type === 'repair_verified'));
    assert.equal(run.result.originalUnchanged, true);
    assert.equal(run.workspace, undefined);
    assert.deepEqual(listWorktrees(realGit, fixture.root), [fixture.canonicalRoot]);
    assert.deepEqual(await snapshotRepository(realGit, fixture.root), original);
  };
  const outcomes = (run: RepairRun) => run.result.failureVerification?.checks.map((check) => [check.failure.testName, check.outcome]);
  const problems = (run: RepairRun) => run.result.failureVerification?.problems.map((problem) => problem.code);

  before(async () => {
    realGit = await resolveGitExecutable();
  });

  beforeEach(async () => {
    fixture = await createGitRepositoryFixture(realGit);
    original = await snapshotRepository(realGit, fixture.root);
  });

  afterEach(async () => {
    await Promise.allSettled(retained.splice(0).map((workspace) => workspace.remove()));
    await fixture.cleanup();
  });

  it('A, G: the canonical repair records the baseline failure from its RED output and proves that same test passed', async () => {
    const run = await repair(FIX_TAX);
    const { result } = run;
    assert.equal(result.status, 'repaired', result.reason ?? undefined);

    const expected: FailureIdentity = {
      testFile: 'test/checkout.test.ts',
      line: 20,
      suite: [],
      testName: TARGET,
      resultLine: `not ok 2 - ${TARGET}`,
      error: 'Expected values to be strictly equal:\n\n200 !== 180',
      expected: '180',
      actual: '200',
      comparison: '200 !== 180',
      occurrence: { path: 'test/checkout.test.ts', line: 26 },
      evidenceId: result.baselineEvidenceId ?? assert.fail('no baseline evidence'),
    };
    assert.deepEqual(result.baselineFailures, [expected]);
    const baselineOutput = evidenceContent(run, result.baselineEvidenceId);
    assert.ok(baselineOutput.includes(expected.resultLine) && baselineOutput.includes("location: '<repo>/test/checkout.test.ts:20:1'"));
    const rederived = identifyFailures(baselineOutput, expected.evidenceId);
    assert.deepEqual(rederived.ok ? rederived.failures : [], [expected], 'G: the identity is exactly what the evidence shows');
    assert.deepEqual(run.state.repair?.baselineFailures, [expected]);
    assert.deepEqual(run.state.verifications.find((item) => item.id === BASELINE_VERIFICATION_ID)?.failures, [expected]);

    assert.deepEqual(result.failureVerification, {
      evidenceId: result.finalEvidenceId,
      checks: [{ failure: expected, outcome: 'passed', resultLine: `ok 2 - ${TARGET}` }],
      problems: [],
    });
    assert.ok(evidenceContent(run, result.finalEvidenceId).includes(`ok 2 - ${TARGET}\n`));
    assert.deepEqual(run.state.repair?.failureVerification, result.failureVerification);
    assert.match(run.state.verifications.find((item) => item.id === REPAIR_VERIFICATION_ID)?.summary ?? '', /previously failing test\(s\) "applies tax to the discounted amount" \(test\/checkout\.test\.ts\) passed/);
    assert.deepEqual(await snapshotRepository(realGit, fixture.root), original);
  });

  it('B, 9: process.exit(0) as an imported module loads exits 0 but is not a repair', async () => {
    const run = await repair(EXIT_ON_IMPORT);
    await assertNotRepaired(run, 'verification_inconclusive', /exited with code 0 \(GREEN\), but the previously failing test "applies tax to the discounted amount" \(test\/checkout\.test\.ts\) was not reported/);
    assert.match(run.result.reason ?? '', /test\/checkout\.test\.ts is reported as a single result/);
    const final = run.state.verifications.find((item) => item.id === REPAIR_VERIFICATION_ID);
    assert.deepEqual([final?.commandOutcome, final?.status], ['green', 'inconclusive'], 'the command did exit 0');
    assert.ok(evidenceContent(run, run.result.finalEvidenceId).includes('ok 1 - test/checkout.test.ts'));
    assert.deepEqual(outcomes(run), [[TARGET, 'not_reported']]);
    assert.deepEqual(problems(run), ['test_file_exited_early', 'tests_missing']);
    assert.deepEqual(run.result.baselineFailures.map((failure) => failure.testName), [TARGET], 'the result still names the baseline failure');
  });

  it('B, D: process.exit(0) inside the failing test exits 0 before it is reported, and is not a repair', async () => {
    const run = await repair(EXIT_DURING_TEST);
    await assertNotRepaired(run, 'verification_inconclusive', /was not reported/);
    assert.equal(run.state.verifications.find((item) => item.id === REPAIR_VERIFICATION_ID)?.commandOutcome, 'green');
    assert.deepEqual(outcomes(run), [[TARGET, 'not_reported']]);
  });

  it('C: skipping the failing test exits 0 and is not a repair', async () => {
    const run = await repair(SKIP_TARGET);
    await assertNotRepaired(run, 'verification_inconclusive', /"applies tax to the discounted amount" \(test\/checkout\.test\.ts\) was skipped, so it did not run/);
    assert.equal(run.state.verifications.find((item) => item.id === REPAIR_VERIFICATION_ID)?.commandOutcome, 'green');
    assert.ok(evidenceContent(run, run.result.finalEvidenceId).includes(`ok 2 - ${TARGET} # SKIP`));
    assert.deepEqual(outcomes(run), [[TARGET, 'skipped']]);
  });

  it('C: marking the failing test TODO exits 0 while it still fails, and is not a repair', async () => {
    const run = await repair(TODO_TARGET);
    await assertNotRepaired(run, 'verification_inconclusive', /was marked TODO/);
    assert.equal(run.state.verifications.find((item) => item.id === REPAIR_VERIFICATION_ID)?.commandOutcome, 'green');
    assert.ok(evidenceContent(run, run.result.finalEvidenceId).includes(`not ok 2 - ${TARGET} # TODO`));
    assert.deepEqual(outcomes(run), [[TARGET, 'todo']]);
  });

  it('D: deleting the failing test exits 0 and is not a repair', async () => {
    const run = await repair(DELETE_TARGET);
    await assertNotRepaired(run, 'verification_inconclusive', /was not reported, so there is no evidence it ran/);
    assert.deepEqual(outcomes(run), [[TARGET, 'not_reported']]);
    assert.deepEqual(problems(run), ['tests_missing']);
  });

  it('E: another test passing does not count while the failing test still fails', async () => {
    const run = await repair(ADD_SIMILAR_PASSING_TEST);
    await assertNotRepaired(run, 'verification_failed', /RED/);
    assert.ok(evidenceContent(run, run.result.finalEvidenceId).includes(`ok 4 - ${TARGET} quickly`));
    assert.deepEqual(outcomes(run), [[TARGET, 'failed']]);
  });

  it('F: renaming the failing test is not a repair, even when every reported test passes', async () => {
    const run = await repair(RENAME_TARGET);
    await assertNotRepaired(run, 'verification_inconclusive', /"applies tax to the discounted amount" \(test\/checkout\.test\.ts\) was not reported/);
    assert.ok(evidenceContent(run, run.result.finalEvidenceId).includes('ok 2 - applies tax after the discount'));
    assert.deepEqual(outcomes(run), [[TARGET, 'not_reported']]);
  });

  it('F: a same-named stand-in cannot replace the original failing test', async () => {
    const run = await repair(REPLACE_WITH_SAME_NAME);
    await assertNotRepaired(run, 'verification_inconclusive', /was reported more than once, so its result is ambiguous/);
    assert.deepEqual(outcomes(run), [[TARGET, 'reported_more_than_once']]);
  });

  it('a patch that rewrites the failing assertion to accept the bug is not a repair, although the test then passes', async () => {
    const run = await repair(ACCEPT_BUGGY_TAX);
    await assertNotRepaired(run, 'safety_check_failed', /The patch changes test\/checkout\.test\.ts, which declares a baseline failing test/);
    const final = run.state.verifications.find((item) => item.id === REPAIR_VERIFICATION_ID);
    assert.deepEqual([final?.commandOutcome, final?.status], ['green', 'confirmed'], 'only the test-file check stands between this patch and "repaired"');
    assert.deepEqual(outcomes(run), [[TARGET, 'passed']]);
    assert.deepEqual(run.result.changedFiles, ['test/checkout.test.ts']);
  });

  it('H: a caller cannot supply a failure identity; the one in the log comes from the output', async () => {
    const [identity] = (await repair(FIX_TAX)).result.baselineFailures;
    assert.ok(identity);
    for (const smuggled of [
      { ...request(FIX_TAX), failures: [{ ...identity, testName: 'reports declined payments' }] },
      { ...request(FIX_TAX), baselineFailures: [identity] },
      { ...request(FIX_TAX), verification: { command: 'npm', args: ['test'], expectedFailure: EXPECTED_FAILURE, failingTest: TARGET } },
    ]) {
      await assert.rejects(new RepairWorkflow({ allowedRoot: fixture.allowedRoot, git: realGit }).repair(smuggled as RepairRequest), RepairRequestError);
    }

    // Expected-failure text naming a passing test only attributes the RED; the identity is still the failing test.
    const run = await repair(FIX_TAX, { verification: { command: 'npm', args: ['test'], expectedFailure: ['reports declined payments', '200 !== 180'] } });
    assert.equal(run.result.status, 'repaired', run.result.reason ?? undefined);
    assert.deepEqual(run.result.baselineFailures.map((failure) => failure.testName), [TARGET]);
    assert.deepEqual(outcomes(run), [[TARGET, 'passed']]);
  });

  describe('N: multiple baseline failures', () => {
    const SECOND = 'applies tax to a discounted single mug';
    beforeEach(async () => {
      const file = path.join(fixture.root, 'test', 'checkout.test.ts');
      const source = await readFile(file, 'utf8');
      await writeFile(
        file,
        [
          source,
          `test('${SECOND}', async () => {`,
          '  const cart = new Cart();',
          "  cart.addItem({ sku: 'MUG-01', unitPrice: 1250, quantity: 1 });",
          "  const receipt = await checkout(cart, new FakePaymentGateway(), { orderId: 'order-4', discountCode: 'WELCOME10' });",
          '  assert.equal(receipt.tax, 90);',
          '});',
          '',
        ].join('\n'),
      );
      git(realGit, fixture.root, 'commit', '-q', '-am', 'Add a second failing test');
      original = await snapshotRepository(realGit, fixture.root);
    });

    it('records every failing test and is repaired only when all of them pass', async () => {
      const run = await repair(FIX_TAX);
      assert.equal(run.result.status, 'repaired', run.result.reason ?? undefined);
      assert.deepEqual(
        run.result.baselineFailures.map((failure) => [failure.testName, failure.line, failure.comparison]),
        [
          [TARGET, 20, '200 !== 180'],
          [SECOND, 37, '100 !== 90'],
        ],
      );
      assert.deepEqual(outcomes(run), [
        [TARGET, 'passed'],
        [SECOND, 'passed'],
      ]);
    });

    it('is not repaired when one of them is skipped instead of fixed', async () => {
      const run = await repair(FIX_TAX + testPatch(['@@ -37 +37 @@', `-test('${SECOND}', async () => {`, `+test.skip('${SECOND}', async () => {`]));
      await assertNotRepaired(run, 'verification_inconclusive', /"applies tax to a discounted single mug" \(test\/checkout\.test\.ts\) was skipped/);
      assert.deepEqual(outcomes(run), [
        [TARGET, 'passed'],
        [SECOND, 'skipped'],
      ]);
    });
  });
});

describe('failure-specific verification: test files outside the patch policy\'s naming conventions', () => {
  /** `add` multiplies; "adds numbers" expects 5 and gets 6. */
  const BUGGY_ADD = 'export const add = (a, b) => a * b;\n';
  const mathTest = (sourceImport: string) =>
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      `import { add } from '${sourceImport}';`,
      '',
      "test('keeps other behaviour', () => {",
      "  assert.equal(typeof add, 'function');",
      '});',
      '',
      "test('adds numbers', () => {",
      '  assert.equal(add(2, 3), 5);',
      '});',
      '',
    ].join('\n');
  const MATH_SIGNAL: Signal = {
    id: 'sig-math',
    kind: 'failing_test',
    title: 'add returns the wrong sum',
    content: 'not ok 2 - adds numbers\n  6 !== 5',
    command: 'npm test',
    receivedAt: '2026-01-01T00:00:00.000Z',
  };

  let realGit: GitExecutable;
  let base: string;
  const retained: GitWorktreeWorkspace[] = [];

  /** A committed repository at `<base>/allowed/repo` with `files` and `npm test` running `testScript`. */
  const createRepository = async (testScript: string, files: Record<string, string>) => {
    const root = path.join(base, 'allowed', 'repo');
    for (const [file, content] of Object.entries({
      'package.json': `${JSON.stringify({ name: 'math', private: true, type: 'module', scripts: { test: testScript } }, null, 2)}\n`,
      ...files,
    })) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), content);
    }
    git(realGit, root, 'init', '-q', '-b', 'main');
    git(realGit, root, 'add', '-A');
    git(realGit, root, 'commit', '-q', '-m', 'Initial commit');
    return root;
  };
  const repairMath = async (root: string, patchText: string): Promise<RepairRun> => {
    let tick = Date.parse(MATH_SIGNAL.receivedAt);
    const run = await new RepairWorkflow({
      allowedRoot: path.join(base, 'allowed'),
      git: realGit,
      clock: () => (tick += 1000),
      generateId: () => 'repair-math',
    }).repair({
      repositoryRoot: root,
      signal: MATH_SIGNAL,
      verification: { command: 'npm', args: ['test'], expectedFailure: ['adds numbers', '6 !== 5'] },
      patch: patchText,
    });
    if (run.workspace) retained.push(run.workspace);
    assert.deepEqual(replayInvestigation(run.events), run.state, 'the log replays to the returned state');
    RepairResultSchema.parse(run.result);
    return run;
  };
  const assertMathNotRepaired = async (run: RepairRun, root: string, unchanged: RepositorySnapshot, status: RepairStatus, reason: RegExp) => {
    assert.equal(run.result.status, status, run.result.reason ?? undefined);
    assert.match(run.result.reason ?? '', reason);
    assert.ok(!run.events.some((event) => event.type === 'repair_verified'));
    assert.equal(run.workspace, undefined);
    assert.deepEqual(listWorktrees(realGit, root), [await realpath(root)]);
    assert.deepEqual(await snapshotRepository(realGit, root), unchanged);
  };

  before(async () => {
    realGit = await resolveGitExecutable();
  });

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'devpilot-math-'));
  });

  afterEach(async () => {
    await Promise.allSettled(retained.splice(0).map((workspace) => workspace.remove()));
    await rm(base, { recursive: true, force: true });
  });

  it('a patch that only rewrites the assertion in a node-discovered src/math-test.mjs is not a repair', async () => {
    assert.deepEqual(
      PATCH_PATH_RULES.filter((rule) => rule.matches('src/math-test.mjs')).map((rule) => rule.code),
      [],
      'the path policy does not recognise this file as a test; the baseline failure identity does',
    );
    const root = await createRepository('node --test --test-reporter=tap', { 'src/math.mjs': BUGGY_ADD, 'src/math-test.mjs': mathTest('./math.mjs') });
    const unchanged = await snapshotRepository(realGit, root);
    const acceptBug = patch('--- a/src/math-test.mjs', '+++ b/src/math-test.mjs', '@@ -10 +10 @@', '-  assert.equal(add(2, 3), 5);', '+  assert.equal(add(2, 3), 6);');

    const run = await repairMath(root, acceptBug);
    await assertMathNotRepaired(run, root, unchanged, 'safety_check_failed', /The patch changes src\/math-test\.mjs, which declares a baseline failing test/);
    assert.deepEqual(run.result.baselineFailures.map((failure) => [failure.testFile, failure.testName, failure.comparison]), [['src/math-test.mjs', 'adds numbers', '6 !== 5']]);
    const final = run.state.verifications.find((item) => item.id === REPAIR_VERIFICATION_ID);
    assert.deepEqual([final?.commandOutcome, final?.status], ['green', 'confirmed'], 'the rewritten test passes');
    assert.deepEqual(run.result.failureVerification?.checks.map((check) => check.outcome), ['passed']);
    assert.equal(await readFile(path.join(root, 'src/math.mjs'), 'utf8'), BUGGY_ADD, 'the bug is still there');
  });

  it('a source patch that exits early stays inconclusive when the test file is run by absolute path', async () => {
    const root = await createRepository('node --test --test-reporter=tap "$PWD/test/math.test.mjs"', { 'src/math.mjs': BUGGY_ADD, 'test/math.test.mjs': mathTest('../src/math.mjs') });
    const unchanged = await snapshotRepository(realGit, root);
    const exitOnImport = patch('--- a/src/math.mjs', '+++ b/src/math.mjs', '@@ -1 +1,2 @@', '+process.exit(0);', ' export const add = (a, b) => a * b;');

    const run = await repairMath(root, exitOnImport);
    await assertMathNotRepaired(run, root, unchanged, 'verification_inconclusive', /exited with code 0 \(GREEN\), but the previously failing test "adds numbers" \(test\/math\.test\.mjs\) was not reported/);
    assert.deepEqual(run.result.baselineFailures.map((failure) => failure.testFile), ['test/math.test.mjs']);
    const finalOutput = run.state.evidence.find((item) => item.id === run.result.finalEvidenceId)?.content ?? '';
    assert.match(finalOutput, /^ok 1 - \S+\/test\/math\.test\.mjs$/m, 'the file-level result carries the absolute path');
    assert.ok(!finalOutput.includes('ok 1 - test/math.test.mjs\n'));
    assert.deepEqual(run.result.failureVerification?.checks.map((check) => check.outcome), ['not_reported']);
  });
});
