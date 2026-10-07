import assert from 'node:assert/strict';
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  classifyCommandOutcome,
  InvestigationEventSchema,
  RepairResultSchema,
  type InvestigationEvent,
  type RepairRequest,
  type RepairStatus,
  type Signal,
} from '@devpilot/core';
import {
  BASELINE_VERIFICATION_ID,
  InvestigationStateError,
  RepairRequestError,
  RepairWorkflow,
  REPAIR_VERIFICATION_ID,
  WORKTREE_BASELINE_VERIFICATION_ID,
  replayInvestigation,
  type RepairRun,
  type RepairWorkflowOptions,
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
  ].join('\n'),
  command: 'npm test',
  receivedAt: '2026-01-01T00:00:00.000Z',
};
const EXPECTED_FAILURE = ['applies tax to the discounted amount', '200 !== 180'];

const patch = (...lines: string[]): string => `${lines.join('\n')}\n`;
const BUGGY_TAX = '  const tax = Math.round(subtotal * TAX_RATE);';
const FIXED_TAX = '  const tax = Math.round(discounted * TAX_RATE);';
const taxPatch = (...replacement: string[]): string =>
  patch(
    'diff --git a/src/checkout.ts b/src/checkout.ts',
    '--- a/src/checkout.ts',
    '+++ b/src/checkout.ts',
    `@@ -31,5 +31,${4 + replacement.length} @@ export async function checkout(`,
    '   const subtotal = cart.subtotal();',
    '   const discounted = applyDiscount(subtotal, options.discountCode);',
    `-${BUGGY_TAX}`,
    ...replacement.map((line) => `+${line}`),
    '   const total = discounted + tax;',
    ' ',
  );
const FIX_TAX = taxPatch(FIXED_TAX);
const STILL_WRONG = taxPatch('  const tax = Math.round(discounted * TAX_RATE) + 1;');
const HANGS = taxPatch('  for (;;) {}', FIXED_TAX);
/** FIX_TAX plus statements inserted at the top of the test file, which run only in the patched worktree. */
const fixWithTestSideEffect = (...lines: string[]): string =>
  FIX_TAX +
  patch(
    '--- a/test/checkout.test.ts',
    '+++ b/test/checkout.test.ts',
    `@@ -1,2 +1,${2 + lines.length} @@`,
    " import assert from 'node:assert/strict';",
    " import { test } from 'node:test';",
    ...lines.map((line) => `+${line}`),
  );
const STRAY_OUTPUT = fixWithTestSideEffect(
  "import { writeFileSync } from 'node:fs';",
  "writeFileSync('stray-output.txt', 'written during verification\\n');",
);
const ADDS_ENV = FIX_TAX + patch('--- /dev/null', '+++ b/.env', '@@ -0,0 +1 @@', '+API_KEY=placeholder');

const SUCCESS_SEQUENCE = [
  'investigation_started',
  'repair_started',
  'action_planned',
  'action_completed',
  'verification_recorded',
  'baseline_verified',
  'action_planned',
  'action_completed',
  'verification_recorded',
  'worktree_created',
  'action_planned',
  'action_completed',
  'patch_applied',
  'action_planned',
  'action_completed',
  'verification_recorded',
  'repair_verified',
  'investigation_completed',
];
const SOURCE_DIRECTORY = fileURLToPath(new URL('../packages/engine/src/', import.meta.url));

describe('RED -> PATCH -> GREEN repair workflow', () => {
  let realGit: GitExecutable;
  let fixture: GitRepositoryFixture;
  let original: RepositorySnapshot;
  const retained: GitWorktreeWorkspace[] = [];

  const workflow = (options: Partial<RepairWorkflowOptions> = {}) => {
    let tick = Date.parse(SIGNAL.receivedAt);
    return new RepairWorkflow({
      allowedRoot: fixture.allowedRoot,
      git: realGit,
      clock: () => (tick += 1000),
      generateId: () => 'repair-test',
      ...options,
    });
  };
  const request = (patchText: string, overrides: Partial<RepairRequest> = {}): RepairRequest => ({
    repositoryRoot: fixture.root,
    signal: SIGNAL,
    verification: { command: 'npm', args: ['test'], expectedFailure: EXPECTED_FAILURE },
    patch: patchText,
    description: 'Calculate tax from the discounted subtotal',
    hypothesisId: 'hyp-tax-base',
    ...overrides,
  });
  const repair = async (patchText: string, options: Partial<RepairWorkflowOptions> = {}): Promise<RepairRun> => {
    const observed: InvestigationEvent[] = [];
    const run = await workflow(options).repair(request(patchText), (event) => observed.push(event));
    if (run.workspace) retained.push(run.workspace);
    assert.deepEqual(observed, run.events, 'listeners see exactly the logged events');
    assertConsistentLog(run);
    return run;
  };
  const commitToFixture = async (file: string, transform: (source: string) => string) => {
    const target = path.join(fixture.root, file);
    await writeFile(target, transform(await readFile(target, 'utf8').catch(() => '')));
    git(realGit, fixture.root, 'add', '--', file);
    git(realGit, fixture.root, 'commit', '-q', '-m', `Change ${file}`);
    original = await snapshotRepository(realGit, fixture.root);
  };
  /** J: after any outcome the original checkout is byte-for-byte what it was. */
  const assertOriginalUntouched = async () => {
    assert.deepEqual(await snapshotRepository(realGit, fixture.root), original);
  };
  const assertNoWorktreesLeft = async () => {
    assert.deepEqual(listWorktrees(realGit, fixture.root), [fixture.canonicalRoot]);
    const directory = path.join(fixture.root, '.devpilot', 'worktrees');
    assert.deepEqual(await readdir(directory).catch(() => []), []);
  };
  const assertFailure = async (run: RepairRun, status: RepairStatus, reason: RegExp) => {
    assert.equal(run.result.status, status, run.result.reason ?? undefined);
    assert.match(run.result.reason ?? '', reason);
    assert.notEqual(run.state.repair?.phase, 'verified');
    assert.equal(run.workspace, undefined);
    assert.equal(run.result.worktreeRetained, false);
    assert.equal(run.result.originalUnchanged, true);
    await assertNoWorktreesLeft();
    await assertOriginalUntouched();
  };
  const tools = (run: RepairRun) => run.state.actions.map((action) => action.tool);

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

  describe('successful repair', () => {
    it('B, I, N, P: reproduces RED, patches the worktree, confirms GREEN, and leaves the original untouched', async () => {
      const run = await repair(FIX_TAX);
      const { result, state } = run;

      assert.equal(result.status, 'repaired', result.reason ?? undefined);
      assert.equal(result.reason, null);
      assert.equal(result.verificationCommand, 'npm test');
      assert.equal(result.hypothesisId, 'hyp-tax-base');
      assert.equal(result.patchStatus, 'applied');
      assert.deepEqual(result.changedFiles, ['src/checkout.ts']);
      assert.equal(result.originalUnchanged, true);
      assert.equal(result.worktreeRetained, true);
      assert.ok(run.workspace);
      assert.equal(result.worktree, run.workspace.name);
      assert.equal(result.baseCommit, git(realGit, fixture.root, 'rev-parse', 'HEAD').trim());

      // N: the event log tells the whole story, in order.
      assert.deepEqual(run.events.map((event) => event.type), SUCCESS_SEQUENCE);
      assert.equal(state.status, 'completed');
      assert.equal(state.repair?.phase, 'verified');

      // P: every reference in the result points at evidence and verifications in the log.
      const evidence = new Map(state.evidence.map((item) => [item.id, item]));
      assert.equal(evidence.get(result.baselineEvidenceId ?? '')?.kind, 'command_output');
      assert.equal(evidence.get(result.worktreeBaselineEvidenceId ?? '')?.kind, 'command_output');
      assert.equal(evidence.get(result.patchEvidenceId ?? '')?.kind, 'patch_application');
      assert.deepEqual(evidence.get(result.patchEvidenceId ?? '')?.location, {
        type: 'patch',
        workspace: run.workspace.name,
        paths: ['src/checkout.ts'],
        status: 'applied',
      });
      assert.equal(evidence.get(result.finalEvidenceId ?? '')?.kind, 'command_output');
      assert.notEqual(result.baselineEvidenceId, result.finalEvidenceId);
      const verifications = new Map(state.verifications.map((item) => [item.id, item]));
      const red = verifications.get(result.baselineVerificationId ?? '');
      const green = verifications.get(result.finalVerificationId ?? '');
      assert.deepEqual(
        [red?.expectation, red?.commandOutcome, red?.status, red?.evidenceIds],
        ['fails', 'red', 'confirmed', [result.baselineEvidenceId]],
      );
      assert.deepEqual(
        [green?.expectation, green?.commandOutcome, green?.status, green?.evidenceIds],
        ['passes', 'green', 'confirmed', [result.finalEvidenceId]],
      );
      assert.equal(red?.hypothesisId, 'hyp-tax-base');
      const control = state.verifications.find((item) => item.id === WORKTREE_BASELINE_VERIFICATION_ID);
      assert.deepEqual(
        [control?.expectation, control?.commandOutcome, control?.status, control?.evidenceIds],
        ['fails', 'red', 'confirmed', [result.worktreeBaselineEvidenceId]],
      );

      // The patched worktree really is fixed; the original really is not.
      assert.ok((await readFile(path.join(run.workspace.getRoot(), 'src', 'checkout.ts'), 'utf8')).includes(FIXED_TAX));
      assert.ok((await readFile(path.join(fixture.root, 'src', 'checkout.ts'), 'utf8')).includes(BUGGY_TAX));
      // I: byte-for-byte unchanged (every file hash, HEAD, branches, status).
      await assertOriginalUntouched();
    });

    it('L: runs the identical command before and after the patch', async () => {
      const { state, events } = await repair(FIX_TAX, { commandTimeoutMs: 7000 });
      assert.deepEqual(tools({ state } as RepairRun), ['run_command', 'run_command', 'apply_patch', 'run_command']);
      const runs = state.actions.filter((action) => action.tool === 'run_command');
      for (const run of runs) {
        assert.deepEqual(run.input, { command: 'npm', args: ['test'], timeoutMs: 7000 });
      }
      assert.deepEqual(
        state.verifications.map((verification) => [verification.id, verification.command]),
        [
          [BASELINE_VERIFICATION_ID, 'npm test'],
          [WORKTREE_BASELINE_VERIFICATION_ID, 'npm test'],
          [REPAIR_VERIFICATION_ID, 'npm test'],
        ],
      );
      const started = events.find((event) => event.type === 'repair_started');
      assert.equal(started?.type === 'repair_started' ? started.verificationCommand : undefined, 'npm test');
    });

    it('K: the repaired worktree is GREEN while a sibling worktree stays RED', async () => {
      const sibling = await GitWorktreeWorkspace.create(fixture.root, { git: realGit });
      retained.push(sibling);
      const run = await repair(FIX_TAX);
      assert.equal(run.result.status, 'repaired');
      assert.ok(run.workspace);

      const repaired = await run.workspace.getSandbox().runCommand({ command: 'npm', args: ['test'] });
      const untouched = await sibling.getSandbox().runCommand({ command: 'npm', args: ['test'] });
      assert.equal(classifyCommandOutcome(repaired), 'green');
      assert.equal(classifyCommandOutcome(untouched), 'red');
      assert.deepEqual(await sibling.status(), { clean: true, changedPaths: [] });
    });

    it('replays to the same state, also after a JSON round trip', async () => {
      const run = await repair(FIX_TAX);
      for (const event of run.events) InvestigationEventSchema.parse(event);
      assert.deepEqual(replayInvestigation(run.events), run.state);
      assert.deepEqual(replayInvestigation(JSON.parse(JSON.stringify(run.events))), run.state);
      const serialized = JSON.stringify(run.events);
      assert.ok(!serialized.includes(fixture.base), 'events contain no host paths');
    });
  });

  describe('baseline', () => {
    it('A: a healthy repository is baseline_not_red and nothing is patched', async () => {
      await commitToFixture('src/checkout.ts', (source) => source.replace(BUGGY_TAX, FIXED_TAX));
      const run = await repair(FIX_TAX);
      await assertFailure(run, 'baseline_not_red', /GREEN.*expected failure did not reproduce/);
      assert.deepEqual(tools(run), ['run_command']);
      assert.equal(run.result.worktree, null);
      assert.equal(run.result.patchStatus, null);
      assert.ok(run.result.baselineEvidenceId);
      assert.deepEqual(run.events.map((event) => event.type), [
        'investigation_started',
        'repair_started',
        'action_planned',
        'action_completed',
        'verification_recorded',
        'repair_failed',
        'investigation_completed',
      ]);
    });

    it('H: a baseline timeout is baseline_inconclusive and creates no worktree', async () => {
      await commitToFixture('src/checkout.ts', (source) => source.replace(BUGGY_TAX, `  for (;;) {}\n${BUGGY_TAX}`));
      const run = await repair(FIX_TAX, { commandTimeoutMs: 3000 });
      await assertFailure(run, 'baseline_inconclusive', /timed out/);
      assert.deepEqual(tools(run), ['run_command']);
      assert.equal(run.result.worktree, null);
      assert.ok(!run.events.some((event) => event.type === 'worktree_created'));
    });

    it('a baseline command that cannot start is baseline_inconclusive', async () => {
      const run = await repair(FIX_TAX, { hostEnvironment: { PATH: path.join(fixture.base, 'no-binaries-here') } });
      await assertFailure(run, 'baseline_inconclusive', /could not be started/);
      assert.equal(run.state.verifications[0]?.status, 'not_run');
      assert.deepEqual(tools(run), ['run_command']);
    });

    it('a RED baseline without the incident text is inconclusive, not a reproduction', async () => {
      const signal = { ...SIGNAL, content: `${SIGNAL.content}\n    999 !== 1` };
      const run = await workflow().repair(
        request(FIX_TAX, {
          signal,
          verification: { command: 'npm', args: ['test'], expectedFailure: ['999 !== 1'] },
        }),
      );
      await assertFailure(run, 'baseline_inconclusive', /RED.*does not contain "999 !== 1"/);
      assert.deepEqual(tools(run), ['run_command']);
    });
  });

  describe('worktree', () => {
    it('refuses a worktree that differs from the working tree the baseline ran on', async () => {
      await writeFile(path.join(fixture.root, 'README.md'), 'local, uncommitted edit\n');
      original = await snapshotRepository(realGit, fixture.root);
      const run = await repair(FIX_TAX);
      await assertFailure(run, 'worktree_failed', /differs from the working tree the baseline ran on: README\.md/);
      assert.deepEqual(tools(run), ['run_command']);
    });

    it('stops safely when the worktree cannot be created', { skip: process.platform === 'win32' }, async () => {
      await symlink(fixture.outside, path.join(fixture.root, '.devpilot'));
      original = await snapshotRepository(realGit, fixture.root);
      const run = await repair(FIX_TAX);
      assert.equal(run.result.status, 'worktree_failed');
      assert.match(run.result.reason ?? '', /must be a real directory/);
      assert.deepEqual(await readdir(fixture.outside), []);
      assert.ok((await lstat(path.join(fixture.root, '.devpilot'))).isSymbolicLink());
      await assertOriginalUntouched();
    });
  });

  describe('patch', () => {
    const cases: Array<[string, string, string, RegExp]> = [
      ['C: invalid patch', 'this is not a unified diff\n', 'invalid_patch', /apply_patch returned invalid_patch/],
      [
        'D: unsafe patch',
        patch('--- /dev/null', '+++ b/../outside.txt', '@@ -0,0 +1 @@', '+escaped'),
        'unsafe_path',
        /apply_patch returned unsafe_path/,
      ],
      [
        'E: patch that does not match the source',
        patch('--- a/src/checkout.ts', '+++ b/src/checkout.ts', '@@ -33 +33 @@', '-  const tax = 0;', `+${FIXED_TAX}`),
        'rejected',
        /does not match the current file contents/,
      ],
    ];
    for (const [label, patchText, patchStatus, reason] of cases) {
      it(`${label} stops before verification and changes nothing`, async () => {
        const run = await repair(patchText);
        await assertFailure(run, 'patch_failed', reason);
        assert.equal(run.result.patchStatus, patchStatus);
        assert.ok(run.result.patchEvidenceId);
        assert.equal(run.result.finalVerificationId, null);
        assert.equal(run.result.finalEvidenceId, null);
        assert.deepEqual(tools(run), ['run_command', 'run_command', 'apply_patch'], 'no verification after a failed patch');
        assert.ok(run.result.worktree);
        assert.deepEqual(run.result.changedFiles, []);
        for (const directory of [fixture.base, fixture.allowedRoot, fixture.root]) {
          assert.ok(!(await readdir(directory)).includes('outside.txt'));
        }
        // O: failed repair sequence.
        assert.deepEqual(run.events.map((event) => event.type), [
          ...SUCCESS_SEQUENCE.slice(0, 12),
          'repair_failed',
          'investigation_completed',
        ]);
        const failed = run.events.at(-2);
        assert.ok(failed?.type === 'repair_failed' && failed.status === 'patch_failed' && failed.worktreeRemoved);
      });
    }
  });

  describe('verification', () => {
    it('F, O: a patch that still fails is verification_failed, never repaired', async () => {
      const run = await repair(STILL_WRONG);
      await assertFailure(run, 'verification_failed', /exited with code 1 \(RED\); expected it to pass/);
      assert.equal(run.result.patchStatus, 'applied');
      assert.equal(run.result.finalVerificationId, REPAIR_VERIFICATION_ID);
      assert.deepEqual(run.result.changedFiles, ['src/checkout.ts']);
      const green = run.state.verifications.find((item) => item.id === REPAIR_VERIFICATION_ID);
      assert.deepEqual([green?.commandOutcome, green?.status], ['red', 'rejected']);
      assert.deepEqual(run.events.map((event) => event.type), [
        ...SUCCESS_SEQUENCE.slice(0, 16),
        'repair_failed',
        'investigation_completed',
      ]);
    });

    it('G: a verification timeout is verification_inconclusive', async () => {
      const run = await repair(HANGS, { commandTimeoutMs: 3000 });
      await assertFailure(run, 'verification_inconclusive', /timed out/);
      assert.equal(run.state.verifications.find((item) => item.id === REPAIR_VERIFICATION_ID)?.status, 'inconclusive');
    });

    it('GREEN with files written during verification fails the safety check', async () => {
      const run = await repair(STRAY_OUTPUT);
      await assertFailure(run, 'safety_check_failed', /outside the patch during verification: stray-output\.txt/);
      assert.equal(run.state.verifications.find((item) => item.id === REPAIR_VERIFICATION_ID)?.status, 'confirmed');
      assert.ok(run.result.changedFiles.includes('stray-output.txt'));
    });

    it('GREEN with a secret-like file in the patch fails the safety check', async () => {
      const run = await repair(ADDS_ENV);
      await assertFailure(run, 'safety_check_failed', /files named like secrets: \.env/);
      assert.ok(!(await readdir(fixture.root)).includes('.env'));
    });
  });

  describe('review regressions', () => {
    const gitInTest = (...args: string[]) => [
      "import { execFileSync } from 'node:child_process';",
      `execFileSync(${JSON.stringify(realGit.path)}, ${JSON.stringify(args)});`,
    ];

    it('a verification run that creates a branch in the shared repository is not "original unchanged"', async () => {
      const run = await repair(fixWithTestSideEffect(...gitInTest('branch', 'devpilot-stray')));
      assert.equal(run.result.status, 'safety_check_failed', run.result.reason ?? undefined);
      assert.match(run.result.reason ?? '', /original repository changed: \.git\/refs\/heads\/devpilot-stray/);
      assert.equal(run.result.originalUnchanged, false);
      assert.equal(run.workspace, undefined);
      await assertNoWorktreesLeft();
    });

    it('a verification run that commits in the worktree is not a clean repair', async () => {
      const commit = gitInTest('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'stray');
      const run = await repair(fixWithTestSideEffect(...commit));
      await assertFailure(run, 'safety_check_failed', /worktree HEAD moved/);
    });

    it('files written to gitignored paths during verification are detected', async () => {
      await commitToFixture('.gitignore', () => 'build/\n');
      const run = await repair(
        fixWithTestSideEffect(
          "import { mkdirSync, writeFileSync } from 'node:fs';",
          "mkdirSync('build', { recursive: true });",
          "writeFileSync('build/out.txt', 'artifact\\n');",
        ),
      );
      await assertFailure(run, 'safety_check_failed', /outside the patch during verification: .*build\/out\.txt/);
    });

    it('a RED caused by something outside the worktree is not repaired by an unrelated patch', async () => {
      // The original fails only because of an untracked file under node_modules, which the
      // worktree does not have; without the unpatched-worktree control run this was "repaired".
      await commitToFixture('src/checkout.ts', (source) => source.replace(BUGGY_TAX, FIXED_TAX));
      await commitToFixture('test/checkout.test.ts', (source) =>
        [
          source,
          "import { existsSync } from 'node:fs';",
          "test('dependency cache is current', () => {",
          "  assert.ok(!existsSync('node_modules/.stale-cache'), 'stale dependency cache found');",
          '});',
          '',
        ].join('\n'),
      );
      await mkdir(path.join(fixture.root, 'node_modules'));
      await writeFile(path.join(fixture.root, 'node_modules', '.stale-cache'), '');
      original = await snapshotRepository(realGit, fixture.root);
      const signal: Signal = {
        id: 'sig-stale-cache',
        kind: 'failing_test',
        title: 'Dependency cache test fails',
        content: 'not ok 5 - dependency cache is current\n  error: stale dependency cache found',
        command: 'npm test',
        receivedAt: SIGNAL.receivedAt,
      };
      const unrelated = patch('--- /dev/null', '+++ b/docs/notes.md', '@@ -0,0 +1 @@', '+Unrelated change');
      const run = await workflow().repair(
        request(unrelated, {
          signal,
          verification: { command: 'npm', args: ['test'], expectedFailure: ['stale dependency cache found'] },
        }),
      );
      assertConsistentLog(run);
      await assertFailure(run, 'worktree_failed', /unpatched worktree does not reproduce the baseline RED: .*GREEN/);
      assert.deepEqual(tools(run), ['run_command', 'run_command'], 'the patch is never applied');
    });

    it('an ignored file in the original stops the repair instead of being silently absent from the worktree', async () => {
      await commitToFixture('.gitignore', () => 'local-settings.json\n');
      await writeFile(path.join(fixture.root, 'local-settings.json'), '{}\n');
      original = await snapshotRepository(realGit, fixture.root);
      const run = await repair(FIX_TAX);
      await assertFailure(run, 'worktree_failed', /differs from the working tree the baseline ran on: local-settings\.json/);
    });

    it('a worktree that cannot be removed is reported as retained, not hidden', async (t) => {
      const remove = t.mock.method(GitWorktreeWorkspace.prototype, 'remove', async () => {
        throw new Error('simulated removal failure');
      });
      const run = await repair(STILL_WRONG);
      remove.mock.restore();
      assert.equal(run.result.status, 'verification_failed');
      assert.match(run.result.reason ?? '', /could not be removed and is still on disk: simulated removal failure/);
      assert.equal(run.result.worktreeRetained, true);
      assert.ok(run.workspace, 'the caller gets the workspace back to clean it up');
      assert.equal(run.result.worktree, run.workspace.name);
      const failed = run.events.at(-2);
      assert.ok(failed?.type === 'repair_failed' && !failed.worktreeRemoved);
      await run.workspace.remove();
      await assertNoWorktreesLeft();
    });

    it('two concurrent repairs of one repository stay separate', async () => {
      const [fixed, broken] = await Promise.all([repair(FIX_TAX), repair(STILL_WRONG)]);
      assert.equal(fixed.result.status, 'repaired', fixed.result.reason ?? undefined);
      assert.equal(broken.result.status, 'verification_failed', broken.result.reason ?? undefined);
      assert.ok(fixed.workspace);
      assert.notEqual(fixed.result.worktree, broken.result.worktree);
      for (const run of [fixed, broken]) {
        const patchEvidence = run.state.evidence.find((item) => item.id === run.result.patchEvidenceId);
        assert.equal(patchEvidence?.location.type === 'patch' ? patchEvidence.location.workspace : undefined, run.result.worktree);
        const created = run.events.find((event) => event.type === 'worktree_created');
        assert.equal(created?.type === 'worktree_created' ? created.workspace : undefined, run.result.worktree);
      }
      assert.ok((await readFile(path.join(fixed.workspace.getRoot(), 'src', 'checkout.ts'), 'utf8')).includes(FIXED_TAX));
      assert.deepEqual(listWorktrees(realGit, fixture.root), [fixture.canonicalRoot, fixed.workspace.getRoot()]);
      await assertOriginalUntouched();
    });
  });

  describe('no false confirmation', () => {
    it('M: the event log cannot be made to claim a repair after a RED verification', async () => {
      const run = await repair(STILL_WRONG);
      const finalEvidence = run.result.finalEvidenceId;
      assert.ok(finalEvidence);
      const prefix = run.events.slice(0, -2);
      const forge = (overrides: Record<string, unknown>) => [
        ...prefix,
        InvestigationEventSchema.parse({
          type: 'repair_verified',
          investigationId: 'repair-test',
          sequence: prefix.length,
          timestamp: SIGNAL.receivedAt,
          verificationId: REPAIR_VERIFICATION_ID,
          evidenceId: finalEvidence,
          changedFiles: ['src/checkout.ts'],
          originalUnchanged: true,
          ...overrides,
        }),
      ];
      assert.throws(() => replayInvestigation(forge({})), InvestigationStateError);
      assert.throws(() => replayInvestigation(forge({ verificationId: BASELINE_VERIFICATION_ID })), InvestigationStateError);
      assert.throws(
        () => replayInvestigation(forge({ evidenceId: run.result.baselineEvidenceId })),
        InvestigationStateError,
      );
      const early = forge({}).at(-1);
      assert.ok(early);
      assert.throws(
        () => replayInvestigation([...prefix.slice(0, 5), { ...early, sequence: 5 }]),
        /repair_verified requires repair phase patch_applied, not started/,
      );
    });

    it('M: a repaired result must carry the whole proof', async () => {
      const run = await repair(FIX_TAX);
      assert.equal(run.result.status, 'repaired');
      RepairResultSchema.parse(run.result);
      const tampered: Array<Record<string, unknown>> = [
        { finalVerificationId: null },
        { finalEvidenceId: null },
        { baselineEvidenceId: null },
        { worktreeBaselineEvidenceId: null },
        { patchEvidenceId: null },
        { worktree: null },
        { patchStatus: 'rejected' },
        { originalUnchanged: false },
        { originalUnchanged: null },
        { reason: 'still RED' },
        { changedFiles: [] },
        { worktreeRetained: false },
      ];
      for (const change of tampered) {
        assert.throws(() => RepairResultSchema.parse({ ...run.result, ...change }), JSON.stringify(change));
      }
    });

    it('M: a repair cannot complete without a verdict', async () => {
      const run = await repair(FIX_TAX);
      const withoutVerdict = run.events.filter((event) => event.type !== 'repair_verified');
      const renumbered = withoutVerdict.map((event, sequence) => ({ ...event, sequence }));
      assert.throws(() => replayInvestigation(renumbered), /must end with repair_verified or repair_failed/);
    });
  });

  describe('request safety', () => {
    it('Q: refuses arbitrary commands and extra fields before running anything', async () => {
      const marker = path.join(fixture.base, 'PWNED');
      const refused: unknown[] = [
        request(FIX_TAX, { verification: { command: 'sh', args: ['-c', `touch ${marker}`], expectedFailure: EXPECTED_FAILURE } }),
        request(FIX_TAX, { verification: { command: '/bin/sh', args: ['-c', 'true'], expectedFailure: EXPECTED_FAILURE } }),
        request(FIX_TAX, { verification: { command: 'node', args: ['-e', '1'], expectedFailure: EXPECTED_FAILURE } }),
        request(FIX_TAX, { verification: { command: 'npm', args: ['run', 'evil'], expectedFailure: EXPECTED_FAILURE } }),
        request(FIX_TAX, { verification: { command: 'npm', args: ['test', `; touch ${marker}`], expectedFailure: EXPECTED_FAILURE } }),
        { ...request(FIX_TAX), cwd: '/' },
        { ...request(FIX_TAX), env: { NODE_OPTIONS: '--require=evil' } },
        { ...request(FIX_TAX), shell: true },
        { ...request(FIX_TAX), gitArgs: ['--unsafe-paths'] },
        { ...request(FIX_TAX), verification: { command: 'npm', args: ['test'], expectedFailure: EXPECTED_FAILURE, cwd: '..' } },
        { ...request(FIX_TAX), verification: { command: 'npm', args: ['test'], expectedFailure: EXPECTED_FAILURE, executable: '/bin/sh' } },
        request(FIX_TAX, { verification: { command: 'npm', args: ['test'], expectedFailure: ['text that is not in the signal'] } }),
        request(FIX_TAX, { verification: { command: 'npm', args: ['test', '--', 'x'], expectedFailure: EXPECTED_FAILURE } }),
        request(FIX_TAX, { repositoryRoot: fixture.outside }),
        request(FIX_TAX, { repositoryRoot: path.join(fixture.root, '..', '..') }),
      ];
      for (const input of refused) {
        const events: InvestigationEvent[] = [];
        await assert.rejects(
          workflow().repair(input as RepairRequest, (event) => events.push(event)),
          RepairRequestError,
          JSON.stringify(input).slice(0, 200),
        );
        assert.deepEqual(events, [], 'nothing runs for a refused request');
      }
      assert.equal(await readdir(fixture.base).then((names) => names.includes('PWNED')), false);
      await assertNoWorktreesLeft();
      await assertOriginalUntouched();
    });

    it('R: the workflow has no process, shell, or exit-code shortcuts of its own', async () => {
      for (const file of ['repair.ts', 'tool-invocation.ts']) {
        const source = await readFile(path.join(SOURCE_DIRECTORY, file), 'utf8');
        assert.doesNotMatch(source, /child_process|process-runner|\bspawn\(|execFile|\bexec\(|shell:\s*true/, file);
        assert.doesNotMatch(source, /exitCode/, `${file} must use the verification semantics, not exit codes`);
        assert.doesNotMatch(source, /writeFile|rename\(|unlink\(/, `${file} must not write files itself`);
      }
    });
  });
});

/** Whatever happened, the log must replay to the returned state and agree with the result. */
function assertConsistentLog(run: RepairRun): void {
  assert.deepEqual(replayInvestigation(run.events), run.state);
  RepairResultSchema.parse(run.result);
  const { result, state } = run;
  const ids = new Set(state.evidence.map((item) => item.id));
  for (const id of [result.baselineEvidenceId, result.worktreeBaselineEvidenceId, result.patchEvidenceId, result.finalEvidenceId]) {
    if (id !== null) assert.ok(ids.has(id), `result cites ${id}, which is not in the log`);
  }
  const verificationIds = new Set(state.verifications.map((item) => item.id));
  for (const id of [result.baselineVerificationId, result.finalVerificationId]) {
    if (id !== null) assert.ok(verificationIds.has(id));
  }
  assert.equal(result.status === 'repaired', state.repair?.phase === 'verified');
  assert.equal(state.status === 'running', false);
  assert.equal(result.worktreeRetained, run.workspace !== undefined);
  // Every command run is exactly the requested argv and the configured timeout, with no cwd.
  const repair = state.repair;
  assert.ok(repair);
  for (const action of state.actions) {
    if (action.tool === 'run_command') {
      assert.deepEqual(action.input, { command: repair.command, args: [...repair.args], timeoutMs: repair.timeoutMs });
    }
  }
}
