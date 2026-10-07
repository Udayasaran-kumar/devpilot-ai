import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { RepairReportSchema, type GroundedClaim, type RepairReport, type Signal } from '@devpilot/core';
import {
  GroundedRepairPipeline,
  replayInvestigation,
  validateRepairReport,
  type GroundedRepairRun,
  type ReportSources,
} from '@devpilot/engine';
import { RulePlanner, type Planner } from '@devpilot/planners';
import { resolveGitExecutable, type GitExecutable } from '@devpilot/tools';
import {
  createGitRepositoryFixture,
  listWorktrees,
  snapshotRepository,
  type GitRepositoryFixture,
  type RepositorySnapshot,
} from '../packages/tools/test/support/git-repository.js';

const SIGNAL: Signal = {
  id: 'sig-checkout-tax',
  kind: 'failing_test',
  title: 'Checkout total is too high when a discount code is used',
  content: [
    'not ok 2 - applies tax to the discounted amount',
    '  error: |-',
    '    Expected values to be strictly equal:',
    '    200 !== 180',
  ].join('\n'),
  command: 'npm test',
  receivedAt: '2026-01-01T00:00:00.000Z',
};

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('incident -> evidence -> hypotheses -> proposal -> review -> RED/PATCH/GREEN -> grounded report', () => {
  let realGit: GitExecutable;
  let fixture: GitRepositoryFixture;
  let original: RepositorySnapshot;
  let run: GroundedRepairRun;

  const pipeline = (allowedRoot: string) => {
    let tick = Date.parse(SIGNAL.receivedAt);
    return new GroundedRepairPipeline({
      allowedRoot,
      git: realGit,
      clock: () => (tick += 1000),
      generateId: (purpose) => `${purpose}-checkout`,
    });
  };

  before(async () => {
    realGit = await resolveGitExecutable();
    fixture = await createGitRepositoryFixture(realGit);
    original = await snapshotRepository(realGit, fixture.root);
    run = await pipeline(fixture.allowedRoot).run({ repositoryRoot: fixture.root, signal: SIGNAL });
  });

  after(async () => {
    await run?.repair?.workspace?.remove();
    await fixture?.cleanup();
  });

  it('V: the planner proposes, review accepts, and only the repair workflow proves RED -> GREEN', () => {
    const investigation = run.investigation.state;
    assert.ok(investigation);
    const types = run.investigation.events.map((event) => event.type);
    assert.ok(types.indexOf('patch_proposed') < types.indexOf('patch_reviewed'));
    assert.ok(!types.some((type) => type.startsWith('repair_') || type === 'patch_applied' || type === 'baseline_verified'));
    assert.equal(run.proposal?.status, 'awaiting_verification');

    const repair = run.repair;
    assert.ok(repair);
    assert.equal(repair.result.status, 'repaired', repair.result.reason ?? undefined);
    assert.equal(repair.result.hypothesisId, run.proposal?.proposal.hypothesisId);
    assert.equal(repair.state.repair?.patchSha256, sha256(run.proposal?.proposal.patch ?? ''), 'the proposal reached the workflow unmodified');
    assert.equal(repair.state.repair?.phase, 'verified');
    assert.deepEqual(repair.result.changedFiles, ['src/checkout.ts']);
    assert.deepEqual(repair.state.repair?.expectedFailure, ['applies tax to the discounted amount', '200 !== 180']);
  });

  it('W: the original repository is unchanged; the patch exists only in the retained worktree', async () => {
    assert.deepEqual(await snapshotRepository(realGit, fixture.root), original);
    assert.equal(run.repair?.result.originalUnchanged, true);
    const workspace = run.repair?.workspace;
    assert.ok(workspace);
    assert.match(await readFile(path.join(workspace.getSandbox().root, 'src/checkout.ts'), 'utf8'), /Math\.round\(discounted \* TAX_RATE\)/);
    assert.match(await readFile(path.join(fixture.root, 'src/checkout.ts'), 'utf8'), /Math\.round\(subtotal \* TAX_RATE\)/);
    assert.equal(listWorktrees(realGit, fixture.root).length, 2);
  });

  it('builds a schema-valid report whose every claim is grounded', () => {
    const { report, grounding } = run;
    assert.deepEqual(grounding.issues, []);
    assert.equal(grounding.valid, true);
    RepairReportSchema.parse(report);
    assert.equal(report.repairStatus, 'repaired');
    assert.equal(report.verification.status, 'repaired');
    assert.equal(report.verification.finalEvidenceId, run.repair?.result.finalEvidenceId);
    assert.equal(report.selectedHypothesis?.id, 'hyp-input-tax-subtotal-discounted');
    assert.equal(report.confidence, report.selectedHypothesis?.confidence);
    assert.deepEqual(report.affectedFiles, ['src/checkout.ts']);
    assert.equal(report.investigationActions.length, 4);
    assert.ok(report.contradictingEvidenceIds.length > 0);
    assert.deepEqual(
      [...new Set(report.claims.map((claim) => claim.kind))].sort(),
      ['finding', 'observation', 'proposal', 'verification'],
    );
    for (const claim of report.claims) assert.ok(claim.evidenceIds.length > 0, claim.id);
    const verification = report.claims.filter((claim) => claim.kind === 'verification');
    assert.equal(verification.length, 1);
    assert.match(verification[0]?.statement ?? '', /^Repair verified against the configured verification command/);
    assert.ok(report.limitations.some((note) => /Verification covers only `npm test`/.test(note)));
    assert.ok(!JSON.stringify(report).includes(fixture.root), 'no host paths in the report');
  });

  it('U: the whole pipeline is deterministic for the same incident and repository', async () => {
    const second = await createGitRepositoryFixture(realGit);
    try {
      const again = await pipeline(second.allowedRoot).run({ repositoryRoot: second.root, signal: SIGNAL });
      await again.repair?.workspace?.remove();
      const shape = (result: GroundedRepairRun) => ({
        actions: result.investigation.state?.actions.map(({ tool, input, rationale, expectedEvidence }) => ({ tool, input, rationale, expectedEvidence })),
        hypotheses: result.investigation.state?.hypotheses.map(({ id, status, confidence, statement }) => ({ id, status, confidence, statement })),
        proposal: result.proposal?.proposal.patch,
        status: result.report.repairStatus,
        claims: result.report.claims.map(({ kind, statement }) => ({ kind, statement })),
      });
      assert.deepEqual(shape(again), shape(run));
    } finally {
      await second.cleanup();
    }
  });

  describe('grounding validator', () => {
    const sources = (): ReportSources => ({
      investigation: run.investigation.state ?? assert.fail('no investigation'),
      ...(run.repair ? { repair: { result: run.repair.result, state: run.repair.state } } : {}),
    });
    const sourceEvidence = () => {
      const item = run.investigation.state?.evidence.find((e) => e.location.type === 'file' && e.location.path === 'src/checkout.ts' && e.kind === 'source_code');
      assert.ok(item);
      return item;
    };
    const withClaim = (claim: Omit<GroundedClaim, 'id'>, report: RepairReport = run.report): RepairReport => ({
      ...report,
      claims: [...report.claims, { id: 'claim-extra', ...claim }],
    });
    const issues = (report: RepairReport, from: ReportSources = sources()) =>
      validateRepairReport(report, from).issues.filter((issue) => issue.claimId === 'claim-extra' || issue.claimId === undefined).map((issue) => issue.code);

    const TAX_CLAIM = 'Tax is calculated from the pre-discount subtotal.';

    it('Q: rejects claims that cite no matching evidence text, unknown evidence, or unknown actions', () => {
      const id = sourceEvidence().id;
      assert.deepEqual(
        issues(withClaim({ kind: 'finding', statement: TAX_CLAIM, evidenceIds: [id], actionIds: [], quote: 'Math.round(discounted * TAX_RATE)' })),
        ['quote_not_in_evidence', 'underived_claim'],
      );
      assert.deepEqual(issues(withClaim({ kind: 'finding', statement: TAX_CLAIM, evidenceIds: [id], actionIds: [] })), ['missing_quote', 'underived_claim']);
      assert.deepEqual(
        issues(withClaim({ kind: 'finding', statement: TAX_CLAIM, evidenceIds: ['ev-0123456789abcdef'], actionIds: [], quote: 'subtotal * TAX_RATE' })),
        ['unknown_evidence', 'quote_not_in_evidence', 'underived_claim'],
      );
      assert.deepEqual(
        issues(withClaim({ kind: 'finding', statement: TAX_CLAIM, evidenceIds: [id], actionIds: ['action-99'], quote: 'subtotal * TAX_RATE' })),
        ['unknown_action', 'underived_claim'],
      );
      assert.equal(RepairReportSchema.safeParse(withClaim({ kind: 'finding', statement: TAX_CLAIM, evidenceIds: [], actionIds: [] })).success, false);
    });

    it('R: a correctly quoted claim passes the quote checks, but only claims derived from the logs are accepted', () => {
      const evidence = sourceEvidence();
      const action = run.investigation.state?.actions.find((item) => item.resultingEvidenceIds.includes(evidence.id));
      const quoted = { kind: 'finding' as const, evidenceIds: [evidence.id], actionIds: action ? [action.id] : [], quote: 'const tax = Math.round(subtotal * TAX_RATE);' };
      assert.deepEqual(issues(withClaim({ statement: TAX_CLAIM, ...quoted })), ['underived_claim']);

      const derived = run.report.claims.find((claim) => claim.kind === 'finding' && claim.quote === quoted.quote);
      assert.ok(derived, 'the builder derives this finding from the same evidence');
      assert.deepEqual(validateRepairReport(run.report, sources()), { valid: true, issues: [] });
    });

    it('K: a genuine quote cannot carry a statement that inverts or overstates it', () => {
      const green = run.repair?.result.finalEvidenceId;
      const red = run.repair?.result.baselineEvidenceId;
      assert.ok(green && red);
      const source = sourceEvidence().id;
      const forged: Omit<GroundedClaim, 'id'>[] = [
        { kind: 'finding', statement: '`tax` should NOT use `discounted`.', evidenceIds: [source], actionIds: [], quote: 'const tax = Math.round(subtotal * TAX_RATE);' },
        { kind: 'finding', statement: 'The tax calculation is wrong.', evidenceIds: [source], actionIds: [], quote: 'const tax = Math.round(subtotal * TAX_RATE);' },
        { kind: 'observation', statement: 'The baseline run exited 0 and nothing failed.', evidenceIds: [red], actionIds: [], quote: 'applies tax to the discounted amount' },
        { kind: 'finding', statement: 'Four pieces of evidence support this conclusion.', evidenceIds: [source], actionIds: [], quote: 'TAX_RATE' },
        { kind: 'verification', statement: 'Repair was not verified.', evidenceIds: [green], actionIds: [] },
        { kind: 'verification', statement: 'The selected hypothesis was established by the GREEN run.', evidenceIds: [green], actionIds: [] },
      ];
      for (const claim of forged) {
        const codes = issues(withClaim(claim));
        assert.ok(codes.includes('underived_claim'), `${claim.statement}: ${codes.join(',')}`);
      }

      const [first, ...rest] = run.report.claims;
      assert.ok(first);
      const reworded = { ...run.report, claims: [{ ...first, statement: first.statement.replace('exited with code 1', 'exited with code 0') }, ...rest] };
      assert.ok(validateRepairReport(reworded, sources()).issues.some((issue) => issue.code === 'underived_claim'));
      const omitted = { ...run.report, claims: run.report.claims.filter((claim) => !claim.statement.startsWith('Contradicts')) };
      assert.ok(validateRepairReport(omitted, sources()).issues.some((issue) => /omits a claim/.test(issue.message)), 'contradicting findings cannot be dropped');
    });

    it('S: "tests passed" is accepted only as a verification claim citing the confirmed GREEN evidence', () => {
      const green = run.repair?.result.finalEvidenceId;
      const baseline = run.repair?.result.baselineEvidenceId;
      assert.ok(green && baseline);
      const passed = { statement: 'Tests passed after the patch.', actionIds: [] };
      assert.deepEqual(issues(withClaim({ kind: 'verification', evidenceIds: [green], ...passed })), ['underived_claim']);
      assert.deepEqual(issues(withClaim({ kind: 'verification', evidenceIds: [baseline], ...passed })), ['unverified_success_claim', 'underived_claim']);
      assert.deepEqual(
        issues(withClaim({ kind: 'observation', evidenceIds: [green], quote: 'exit code: 0', ...passed })),
        ['unverified_success_claim', 'underived_claim'],
      );

      const repair = run.repair;
      assert.ok(repair);
      const failedRun: ReportSources = {
        ...sources(),
        repair: { result: { ...repair.result, status: 'verification_failed', reason: 'still RED' }, state: repair.state },
      };
      const codes = issues(withClaim({ kind: 'verification', evidenceIds: [green], ...passed }), failedRun);
      assert.ok(codes.includes('unverified_success_claim'), codes.join(','));
      assert.ok(codes.includes('inconsistent_report'), 'the report status must match the workflow result');
    });

    it('T: "the repair is correct" is rejected even when the repair was verified', () => {
      const green = run.repair?.result.finalEvidenceId;
      assert.ok(green);
      for (const statement of ['The repair is correct.', 'This is the correct fix.', 'The patch is proven and bug-free.', 'Root cause is confirmed.']) {
        assert.ok(
          issues(withClaim({ kind: 'verification', statement, evidenceIds: [green], actionIds: [] })).includes('correctness_claim'),
          statement,
        );
      }
      assert.deepEqual(
        issues(withClaim({ kind: 'verification', statement: 'Repair verified against the configured verification command.', evidenceIds: [green], actionIds: [] })),
        ['underived_claim'],
        'the preferred wording passes the language checks; only derived claims are accepted',
      );
    });

    it('rejects structured fields that disagree with the logs', () => {
      const tampered: RepairReport = { ...run.report, confidence: 0.99 };
      assert.ok(issues(tampered).includes('inconsistent_report'));
      const noRepair: ReportSources = { investigation: sources().investigation };
      assert.ok(issues(run.report, noRepair).includes('inconsistent_report'));
    });

    const messages = (report: RepairReport, from: ReportSources = sources()) => validateRepairReport(report, from).issues.map((issue) => issue.message);
    const includesMessage = (report: RepairReport, pattern: RegExp, from: ReportSources = sources()) =>
      assert.ok(messages(report, from).some((message) => pattern.test(message)), `${pattern}: ${messages(report, from).join(' | ')}`);

    it('F: a report cannot restate the selected hypothesis, patch, files, limitations, or verification differently from the logs', () => {
      const investigation = sources().investigation;
      const record = investigation.patchProposals.at(-1);
      const rival = investigation.hypotheses.find((item) => item.status !== 'selected');
      assert.ok(record && rival);
      includesMessage({ ...run.report, selectedHypothesis: rival }, /selectedHypothesis does not match/);
      includesMessage({ ...run.report, patchProposal: { ...record, proposal: { ...record.proposal, patch: record.proposal.patch.replace('discounted * TAX', 'subtotal * TAX') } } }, /patchProposal does not match/);
      includesMessage({ ...run.report, affectedFiles: ['src/cart.ts'] }, /affectedFiles does not match/);
      includesMessage({ ...run.report, limitations: [...run.report.limitations, 'The fix is proven correct.'] }, /limitations does not match/);
      includesMessage({ ...run.report, limitations: run.report.limitations.slice(1) }, /limitations does not match/);
      includesMessage({ ...run.report, hypotheses: run.report.hypotheses.map((item) => (item.id === rival.id ? { ...item, statement: 'Ruled out.' } : item)) }, /hypotheses does not match/);
      includesMessage({ ...run.report, verification: { ...run.report.verification, finalEvidenceId: run.report.verification.baselineEvidenceId } }, /verification does not match/);
      includesMessage({ ...run.report, contradictingEvidenceIds: [] }, /contradictingEvidenceIds does not match/);
    });

    it('F/J/M: the repair log counts only for the reviewed proposal byte-for-byte, its hypothesis, the incident, and its own result', () => {
      const repair = run.repair;
      const investigation = sources().investigation;
      const record = investigation.patchProposals.at(-1);
      const logged = repair?.state.repair;
      assert.ok(repair && record && logged);
      const withProposalPatch = (patch: string): ReportSources => ({
        ...sources(),
        investigation: { ...investigation, patchProposals: [{ ...record, proposal: { ...record.proposal, patch } }] },
      });
      const original = record.proposal.patch;
      const mutations = [
        original.replace('discounted * TAX_RATE', 'discounted  * TAX_RATE'),
        `${original}\n`,
        original.replace(/\n$/, ''),
        original.replaceAll('\n', '\r\n'),
        `diff --git a/src/checkout.ts b/src/checkout.ts\n${original}`,
        original.replace(/^@@ (.*) @@$/m, '@@ $1 @@ checkout'),
      ];
      for (const patch of mutations) {
        assert.notEqual(patch, original);
        includesMessage(run.report, /applied a patch other than proposal proposal-1/, withProposalPatch(patch));
      }

      const withLog = (state: typeof repair.state, result = repair.result): ReportSources => ({ ...sources(), repair: { result, state } });
      includesMessage(run.report, /hypothesis other than/, withLog({ ...repair.state, repair: { ...logged, hypothesisId: 'hyp-value-subtotal' } }));
      includesMessage(run.report, /different incident/, withLog({ ...repair.state, signal: { ...repair.state.signal, id: 'sig-other' } }));
      includesMessage(run.report, /different repair log/, withLog(repair.state, { ...repair.result, investigationId: 'repair-other' }));
      includesMessage(run.report, /final evidence differs/, withLog(repair.state, { ...repair.result, finalEvidenceId: repair.result.baselineEvidenceId }));
      includesMessage(run.report, /changed files other than its log/, withLog(repair.state, { ...repair.result, changedFiles: ['src/checkout.ts', 'src/cart.ts'] }));
      const stillRed = withLog({ ...repair.state, repair: { ...logged, phase: 'failed', failure: { status: 'verification_failed', reason: 'still RED', worktreeRemoved: false } } });
      includesMessage(run.report, /result says repaired, but its log says verification_failed/, stillRed);
      assert.ok(
        validateRepairReport(run.report, stillRed).issues.some((issue) => issue.code === 'unverified_success_claim'),
        'GREEN needs the log, not just the result',
      );
      includesMessage(run.report, /no proposal that passed review/, { ...sources(), investigation: { ...investigation, patchProposals: [] } });
      includesMessage(run.report, /is the investigation log/, { investigation: repair.state, repair: { result: repair.result, state: repair.state } });
    });

    it('F: "GREEN" needs the final verification and its evidence in the log to be confirmed GREEN, not just a repaired result', () => {
      const repair = run.repair;
      const logged = repair?.state.repair;
      assert.ok(repair && logged?.finalEvidenceId && logged.finalVerificationId);
      const unverified = (state: typeof repair.state): ReportSources => ({ ...sources(), repair: { result: repair.result, state } });
      const flagged = (from: ReportSources) => validateRepairReport(run.report, from).issues.some((issue) => issue.code === 'unverified_success_claim');
      assert.equal(flagged(sources()), false);

      const failingOutput = repair.state.evidence.map((item) =>
        item.id === logged.finalEvidenceId && item.location.type === 'command' ? { ...item, location: { ...item.location, exitCode: 1 } } : item,
      );
      assert.ok(flagged(unverified({ ...repair.state, evidence: failingOutput })), 'final output exited non-zero');
      const inconclusive = repair.state.verifications.map((item) =>
        item.id === logged.finalVerificationId ? { ...item, status: 'inconclusive' as const } : item,
      );
      assert.ok(flagged(unverified({ ...repair.state, verifications: inconclusive })), 'final verification inconclusive');
      const uncited = repair.state.verifications.map((item) => (item.id === logged.finalVerificationId ? { ...item, evidenceIds: [] } : item));
      assert.ok(flagged(unverified({ ...repair.state, verifications: uncited })), 'final verification cites no evidence');
    });

    it('N: both logs replay from JSON to the same states, and the report validates only against the replayed logs', () => {
      const repair = run.repair;
      assert.ok(repair);
      const investigation = replayInvestigation(JSON.parse(JSON.stringify(run.investigation.events)));
      const repairState = replayInvestigation(JSON.parse(JSON.stringify(repair.events)));
      assert.deepEqual(investigation, run.investigation.state);
      assert.deepEqual(repairState, repair.state);
      const replayed: ReportSources = { investigation, repair: { result: repair.result, state: repairState } };
      assert.deepEqual(validateRepairReport(JSON.parse(JSON.stringify(run.report)), replayed), { valid: true, issues: [] });

      const forged = structuredClone(run.investigation.events).map((event) =>
        event.type === 'patch_proposed'
          ? { ...event, proposal: { ...event.proposal, patch: event.proposal.patch.replaceAll('src/checkout.ts', 'test/checkout.test.ts'), affectedPaths: ['test/checkout.test.ts'] } }
          : event,
      );
      assert.throws(() => replayInvestigation(forged), /does not match its review/);
    });
  });

  it('J: logs from two investigations of different incidents cannot be mixed', async () => {
    const second = await createGitRepositoryFixture(realGit);
    const otherSignal: Signal = { ...SIGNAL, id: 'sig-checkout-tax-again' };
    let tick = Date.parse(SIGNAL.receivedAt);
    const other = await new GroundedRepairPipeline({
      allowedRoot: second.allowedRoot,
      git: realGit,
      clock: () => (tick += 1000),
      generateId: (purpose) => `${purpose}-other`,
    }).run({ repositoryRoot: second.root, signal: otherSignal });
    try {
      assert.equal(other.grounding.valid, true, JSON.stringify(other.grounding.issues));
      const a = run.investigation.state;
      const b = other.investigation.state;
      assert.ok(a && b && run.repair && other.repair);
      const mixed: [string, RepairReport, ReportSources][] = [
        ['A report + B repair', run.report, { investigation: a, repair: { result: other.repair.result, state: other.repair.state } }],
        ['B report + A repair', other.report, { investigation: b, repair: { result: run.repair.result, state: run.repair.state } }],
        ['A report + B investigation', run.report, { investigation: b, repair: { result: run.repair.result, state: run.repair.state } }],
        ['A result + B repair log', run.report, { investigation: a, repair: { result: run.repair.result, state: other.repair.state } }],
      ];
      for (const [label, report, from] of mixed) {
        assert.equal(validateRepairReport(report, from).valid, false, label);
      }
    } finally {
      await other.repair?.workspace?.remove();
      await second.cleanup();
    }
  });

  const runWith = async (planner: Planner, label: string) => {
    const fixture = await createGitRepositoryFixture(realGit);
    const before = await snapshotRepository(realGit, fixture.root);
    let tick = Date.parse(SIGNAL.receivedAt);
    const result = await new GroundedRepairPipeline({
      allowedRoot: fixture.allowedRoot,
      git: realGit,
      planner,
      clock: () => (tick += 1000),
      generateId: (purpose) => `${purpose}-${label}`,
    }).run({ repositoryRoot: fixture.root, signal: SIGNAL });
    const after = await snapshotRepository(realGit, fixture.root);
    await result.repair?.workspace?.remove();
    await fixture.cleanup();
    return { result, unchanged: JSON.stringify(after) === JSON.stringify(before) };
  };

  it('D: a proposal rejected by review never reaches RepairWorkflow', async () => {
    const inner = new RulePlanner();
    const touchesTest: Planner = {
      name: 'touches-test',
      async next(context) {
        const decision = await inner.next(context);
        if (decision.type !== 'propose_patch') return decision;
        const extra = ['--- a/test/checkout.test.ts', '+++ b/test/checkout.test.ts', '@@ -1 +1 @@', "-import assert from 'node:assert/strict';", "+import assert from 'node:assert';", ''].join('\n');
        return { ...decision, proposal: { ...decision.proposal, patch: decision.proposal.patch + extra, affectedPaths: ['src/checkout.ts', 'test/checkout.test.ts'] } };
      },
    };
    const { result, unchanged } = await runWith(touchesTest, 'rejected');
    assert.equal(result.investigation.state?.patchProposals.at(-1)?.status, 'patch_rejected');
    assert.equal(result.proposal, undefined);
    assert.equal(result.repair, undefined, 'the workflow never ran');
    assert.equal(result.report.repairStatus, 'not_attempted');
    assert.equal(result.report.verification.reason, 'no patch proposal passed review');
    assert.deepEqual(result.grounding.issues, []);
    assert.ok(unchanged);
  });

  it('D/L: a planner that keeps acting after its proposal passed review fails the investigation, and nothing is repaired', async () => {
    const inner = new RulePlanner();
    const keepsActing: Planner = {
      name: 'keeps-acting',
      async next(context) {
        const decision = await inner.next(context);
        const accepted = context.patchProposals.some((record) => record.status === 'awaiting_verification');
        return accepted && decision.type === 'finish'
          ? { type: 'act', tool: 'read_file', input: { path: 'src/cart.ts' }, rationale: 'One more look', expectedEvidence: 'More source' }
          : decision;
      },
    };
    const { result, unchanged } = await runWith(keepsActing, 'acting');
    assert.equal(result.investigation.state?.status, 'failed');
    assert.equal(result.repair, undefined, 'the workflow never ran');
    assert.equal(result.report.repairStatus, 'not_attempted');
    assert.match(result.report.verification.reason ?? '', /investigation failed after proposal proposal-1 passed review/);
    assert.deepEqual(result.grounding.issues, []);
    assert.ok(unchanged);
  });

  it('I (documented limit): a source patch that stops the tests from running passes the path policy; the report says only the exit code was verified', async () => {
    const second = await createGitRepositoryFixture(realGit);
    const inner = new RulePlanner();
    const disablesTests: Planner = {
      name: 'disables-tests',
      async next(context) {
        const decision = await inner.next(context);
        if (decision.type !== 'propose_patch') return decision;
        const patch = ['--- a/src/checkout.ts', '+++ b/src/checkout.ts', '@@ -1 +1,2 @@', '+process.exit(0);', " import type { Cart } from './cart.ts';", ''].join('\n');
        return { ...decision, proposal: { ...decision.proposal, patch } };
      },
    };
    let tick = Date.parse(SIGNAL.receivedAt);
    const result = await new GroundedRepairPipeline({
      allowedRoot: second.allowedRoot,
      git: realGit,
      planner: disablesTests,
      clock: () => (tick += 1000),
      generateId: (purpose) => `${purpose}-exit`,
    }).run({ repositoryRoot: second.root, signal: SIGNAL });
    try {
      assert.equal(result.proposal?.status, 'awaiting_verification', 'a path policy cannot see what a source line does');
      assert.equal(result.repair?.result.status, 'repaired', 'the configured command exits 0');
      assert.equal(result.grounding.valid, true);
      const note = /GREEN output does not report the previously failing test "applies tax to the discounted amount" as passing/;
      assert.ok(result.report.limitations.some((item) => note.test(item)), result.report.limitations.join('\n'));
      assert.ok(!run.report.limitations.some((item) => note.test(item)), 'the genuine fix shows the failing test passing');
    } finally {
      await result.repair?.workspace?.remove();
      await second.cleanup();
    }
  });
});
