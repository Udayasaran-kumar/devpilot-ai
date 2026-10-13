import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { RepairReportSchema, type Signal } from '@devpilot/core';
import { GroundedRepairPipeline, replayInvestigation, type GroundedRepairRun } from '@devpilot/engine';
import { RulePlanner, type Planner } from '@devpilot/planners';
import { resolveGitExecutable } from '@devpilot/tools';
import { createGitRepositoryFixture, snapshotRepository } from '../packages/tools/test/support/git-repository.js';

const SHIPPING_ROOT = fileURLToPath(new URL('../fixtures/shipping-repository/', import.meta.url));
const BUGGY = '  const shipping = subtotal > freeThreshold ? 0 : flatRate;';
const FIXED = '  const shipping = subtotal >= freeThreshold ? 0 : flatRate;';
const AT_THRESHOLD = 'ships free exactly at the threshold';

const SIGNAL: Signal = {
  id: 'sig-shipping-threshold',
  kind: 'failing_test',
  title: 'Orders exactly at the free-shipping threshold are charged shipping',
  content: `not ok 3 - ${AT_THRESHOLD}\n    500 !== 0`,
  command: 'npm test',
  receivedAt: '2026-01-01T00:00:00.000Z',
};

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

interface Edit {
  readonly path: string;
  readonly from: string;
  readonly to: string;
}

/**
 * Runs the grounded repair pipeline on a git copy of the shipping fixture,
 * with `edits` applied to the copy only. The fixture itself is never written.
 */
async function repairCopy(planner: Planner, edits: readonly Edit[], check: (run: GroundedRepairRun, root: string) => Promise<void>) {
  const realGit = await resolveGitExecutable();
  const source = await mkdtemp(path.join(tmpdir(), 'devpilot-shipping-copy-'));
  await cp(SHIPPING_ROOT, source, { recursive: true });
  for (const edit of edits) {
    const file = path.join(source, edit.path);
    const text = await readFile(file, 'utf8');
    assert.ok(text.includes(edit.from), `${edit.path} contains ${JSON.stringify(edit.from)}`);
    await writeFile(file, text.replace(edit.from, edit.to));
  }
  const fixture = await createGitRepositoryFixture(realGit, source);
  const original = await snapshotRepository(realGit, fixture.root);
  let tick = Date.parse(SIGNAL.receivedAt);
  const run = await new GroundedRepairPipeline({
    allowedRoot: fixture.allowedRoot,
    git: realGit,
    planner,
    clock: () => (tick += 1000),
    generateId: (purpose) => `${purpose}-boundary`,
  }).run({ repositoryRoot: fixture.root, signal: SIGNAL });
  try {
    const state = run.investigation.state;
    assert.ok(state);
    assert.deepEqual(replayInvestigation(run.investigation.events), state, 'state is exactly the replayed event log');
    await check(run, fixture.root);
    assert.deepEqual(await snapshotRepository(realGit, fixture.root), original, 'the repository copy is unchanged');
  } finally {
    await run.repair?.workspace?.remove();
    await fixture.cleanup();
    await rm(source, { recursive: true, force: true });
  }
  assert.ok((await readFile(path.join(SHIPPING_ROOT, 'src/shipping.ts'), 'utf8')).includes(BUGGY), 'the shipping fixture is untouched');
}

describe('opt-in operator-boundary repair on a copy of the shipping fixture', () => {
  it('is off by default: the rule planner forms no hypothesis and proposes nothing', async () => {
    for (const planner of [new RulePlanner(), new RulePlanner({ operatorBoundaries: false })]) {
      await repairCopy(planner, [], async (run) => {
        const state = run.investigation.state;
        assert.deepEqual(state?.hypotheses, []);
        assert.equal(run.proposal, undefined);
        assert.equal(run.repair, undefined);
        assert.equal(state?.terminalReason, `No competing hypotheses could be formed from \`${BUGGY.trim()}\`.`);
      });
    }
  });

  it('proposes `>` -> `>=` from evidence, and the repair workflow verifies it RED -> PATCH -> GREEN in a worktree', async () => {
    await repairCopy(new RulePlanner({ operatorBoundaries: true }), [], async (run, root) => {
      const state = run.investigation.state;
      assert.deepEqual(
        state?.actions.map(({ tool, input }) => [tool, input]),
        [
          ['run_command', { command: 'npm', args: ['test'] }],
          ['read_file', { path: 'test/shipping.test.ts' }],
          ['search_code', { query: 'shipping =' }],
          ['read_file', { path: 'src/shipping.ts' }],
        ],
      );
      assert.deepEqual(
        state?.hypotheses.map(({ id, status, confidence }) => [id, status, confidence]),
        [['hyp-boundary-shipping', 'selected', 0.8]],
      );

      const proposal = run.proposal;
      assert.equal(proposal?.status, 'awaiting_verification');
      assert.equal(proposal?.proposal.hypothesisId, 'hyp-boundary-shipping');
      assert.deepEqual(proposal?.proposal.affectedPaths, ['src/shipping.ts']);
      assert.ok(proposal?.proposal.patch.includes(`\n-${BUGGY}\n+${FIXED}\n`), proposal?.proposal.patch);
      assert.equal(state?.terminalReason, `Proposal ${proposal?.id} for hyp-boundary-shipping passed review and is awaiting verification by the repair workflow.`);

      const repair = run.repair;
      assert.ok(repair);
      assert.equal(repair.result.status, 'repaired', repair.result.reason ?? undefined);
      assert.equal(repair.result.hypothesisId, 'hyp-boundary-shipping');
      assert.equal(repair.state.repair?.phase, 'verified');
      assert.equal(repair.state.repair?.patchSha256, sha256(proposal?.proposal.patch ?? ''), 'the proposal reached the workflow unmodified');
      assert.deepEqual(repair.state.repair?.expectedFailure, [AT_THRESHOLD, '500 !== 0']);
      assert.deepEqual(repair.result.changedFiles, ['src/shipping.ts']);
      assert.equal(repair.result.originalUnchanged, true);
      assert.ok((await readFile(path.join(root, 'src/shipping.ts'), 'utf8')).includes(BUGGY), 'the copy keeps the original line');
      assert.ok((await readFile(path.join(repair.workspace?.getSandbox().root ?? '', 'src/shipping.ts'), 'utf8')).includes(FIXED), 'the worktree has the fix');

      const { report, grounding } = run;
      assert.deepEqual(grounding.issues, []);
      assert.equal(grounding.valid, true);
      RepairReportSchema.parse(report);
      assert.equal(report.repairStatus, 'repaired');
      assert.equal(report.selectedHypothesis?.id, 'hyp-boundary-shipping');
      assert.equal(report.verification.finalEvidenceId, repair.result.finalEvidenceId);
      const verified = report.claims.find((claim) => claim.kind === 'verification');
      assert.equal(verified?.statement, `Verified: the previously failing test "${AT_THRESHOLD}" (test/shipping.test.ts) passed after the repair.`);
      assert.equal(verified?.quote, `ok 3 - ${AT_THRESHOLD}`);
      assert.deepEqual(
        report.claims.filter((claim) => claim.kind === 'finding').map((claim) => claim.quote),
        [BUGGY.trim(), 'const quote = quoteShipping(5000, 5000, 500);', '500 !== 0'],
      );
    });
  });

  it('rejects the hypothesis and proposes nothing when a passing test calls the function on the same boundary', async () => {
    const passingAtBoundary = "\ntest('charges a small order exactly at its threshold', () => {\n  const quote = quoteShipping(3000, 3000, 250);\n  assert.equal(quote.total, 3250);\n});\n";
    const testFile = await readFile(path.join(SHIPPING_ROOT, 'test/shipping.test.ts'), 'utf8');
    await repairCopy(
      new RulePlanner({ operatorBoundaries: true }),
      [{ path: 'test/shipping.test.ts', from: testFile.trimEnd(), to: `${testFile.trimEnd()}\n${passingAtBoundary}` }],
      async (run) => {
        const state = run.investigation.state;
        assert.deepEqual(
          state?.hypotheses.map(({ id, status, confidence }) => [id, status, confidence]),
          [['hyp-boundary-shipping', 'rejected', 0]],
        );
        assert.equal(run.proposal, undefined);
        assert.equal(run.repair, undefined);
        assert.equal(state?.terminalReason, 'No hypothesis is sufficiently supported to select (best: hyp-boundary-shipping, rejected, confidence 0).');
        assert.equal(run.grounding.valid, true);
        assert.ok(
          run.report.claims.some((claim) => claim.kind === 'finding' && claim.quote === 'const quote = quoteShipping(3000, 3000, 250);' && claim.statement.startsWith('Contradicts hyp-boundary-shipping: ')),
        );
      },
    );
  });

  it('forms no hypothesis from a comparison it cannot read exactly', async () => {
    const compound = '  const shipping = subtotal > freeThreshold && flatRate > 0 ? 0 : flatRate;';
    await repairCopy(new RulePlanner({ operatorBoundaries: true }), [{ path: 'src/shipping.ts', from: BUGGY, to: compound }], async (run) => {
      const state = run.investigation.state;
      assert.deepEqual(state?.hypotheses, []);
      assert.equal(run.proposal, undefined);
      assert.equal(run.repair, undefined);
      assert.equal(state?.terminalReason, `No competing hypotheses could be formed from \`${compound.trim()}\`.`);
    });
  });

  it('forms no hypothesis when the failing call is off the boundary, whatever the test is called', async () => {
    await repairCopy(
      new RulePlanner({ operatorBoundaries: true }),
      [
        { path: 'test/shipping.test.ts', from: 'quoteShipping(5000, 5000, 500)', to: 'quoteShipping(4999, 5000, 500)' },
      ],
      async (run) => {
        const state = run.investigation.state;
        assert.deepEqual(state?.hypotheses, []);
        assert.equal(run.proposal, undefined);
        assert.equal(state?.terminalReason, `No competing hypotheses could be formed from \`${BUGGY.trim()}\`.`);
      },
    );
  });
});
