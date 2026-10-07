import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  checkFailureResolution,
  identifyFailures,
  type Evidence,
  type InvestigationEvent,
  type JsonObject,
  type VerificationResult,
} from '@devpilot/core';
import { InvestigationStateError, replayInvestigation } from '../src/index.js';

const NOW = '2026-01-01T00:00:00.000Z';
const COMMAND = 'npm test';
const COMMAND_INPUT = { command: 'npm', args: ['test'], timeoutMs: 10_000 };
const PATCH_TEXT = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n';
const PATCH_SHA = createHash('sha256').update(PATCH_TEXT).digest('hex');

type Payload = InvestigationEvent extends infer E
  ? E extends unknown
    ? Omit<E, 'investigationId' | 'sequence' | 'timestamp'>
    : never
  : never;

const evidence = (id: string, actionId: string, kind: Evidence['kind'], location: Evidence['location'], content?: string): Evidence => ({
  id,
  kind,
  summary: id,
  ...(content !== undefined ? { content } : {}),
  location,
  source: { tool: 'test', actionId },
  collectedAt: NOW,
});
const tap = (exitCode: number, ...lines: string[]) => [`$ ${COMMAND}`, `exit code: ${exitCode}`, '--- stdout ---', 'TAP version 13', ...lines].join('\n');
const FAILING_TAP = [
  '# Subtest: boom',
  'not ok 1 - boom',
  '  ---',
  "  location: '<repo>/test/a.test.ts:3:1'",
  '  error: |-',
  '    boom',
  '  ...',
  '# Subtest: other',
  'ok 2 - other',
  '1..2',
];
const output = (actionId: string, exitCode: number, id: string) =>
  evidence(id, actionId, 'command_output', { type: 'command', command: COMMAND, exitCode }, tap(exitCode, ...FAILING_TAP));
const RED = output('action-1', 1, 'ev-red');
const WORKTREE_RED = output('action-2', 1, 'ev-red-worktree');
const PATCH = evidence('ev-patch', 'action-3', 'patch_application', {
  type: 'patch',
  workspace: 'repair-1',
  paths: ['src/a.ts'],
  status: 'applied',
});
const GREEN = evidence('ev-green', 'action-4', 'command_output', { type: 'command', command: COMMAND, exitCode: 0 }, tap(0, 'ok 1 - boom', 'ok 2 - other', '1..2'));

const verification = (
  id: string,
  expectation: 'fails' | 'passes',
  commandOutcome: 'red' | 'green' | 'timed_out',
  status: VerificationResult['status'],
  evidenceId: string,
  command = COMMAND,
): VerificationResult => ({ id, status, summary: id, command, expectation, commandOutcome, evidenceIds: [evidenceId] });
const failuresIn = (item: Evidence) => {
  const identified = identifyFailures(item.content ?? '', item.id);
  assert.ok(identified.ok);
  return [...identified.failures];
};
/** A confirmed RED that records the failing tests its evidence shows. */
const confirmedRed = (id: string, item: Evidence): VerificationResult => ({
  ...verification(id, 'fails', 'red', 'confirmed', item.id),
  failures: failuresIn(item),
});
/** A confirmed GREEN that records how its evidence reports the baseline failures. */
const confirmedGreen = (id: string, item: Evidence, baseline: Evidence = RED): VerificationResult => ({
  ...verification(id, 'passes', 'green', 'confirmed', item.id),
  failureVerification: checkFailureResolution({
    failures: failuresIn(baseline),
    baselineContent: baseline.content ?? '',
    finalContent: item.content ?? '',
    finalEvidenceId: item.id,
  }),
});

const planned = (id: string, tool: string, input: JsonObject): Payload => ({
  type: 'action_planned',
  action: { id, tool, input, rationale: tool, expectedEvidence: tool, hypothesisIds: [] },
});
const completed = (actionId: string, item: Evidence): Payload => ({ type: 'action_completed', actionId, output: {}, evidence: [item] });

/** A complete, valid repair log; tests replace single entries to break one invariant at a time. */
const SUCCESS: readonly Payload[] = [
  {
    type: 'investigation_started',
    signal: { id: 'sig-1', kind: 'failing_test', title: 'Failing test', content: 'not ok - boom', receivedAt: NOW },
    budget: { maxSteps: 4, maxDurationMs: 60_000 },
  },
  {
    type: 'repair_started',
    verificationCommand: COMMAND,
    command: 'npm',
    args: ['test'],
    timeoutMs: 10_000,
    expectedFailure: ['boom'],
    patchSha256: PATCH_SHA,
  },
  planned('action-1', 'run_command', COMMAND_INPUT),
  completed('action-1', RED),
  { type: 'verification_recorded', verification: confirmedRed('ver-baseline', RED) },
  { type: 'baseline_verified', verificationId: 'ver-baseline', evidenceId: 'ev-red' },
  planned('action-2', 'run_command', COMMAND_INPUT),
  completed('action-2', WORKTREE_RED),
  { type: 'verification_recorded', verification: confirmedRed('ver-worktree', WORKTREE_RED) },
  {
    type: 'worktree_created',
    workspace: 'repair-1',
    baseCommit: 'c'.repeat(40),
    verificationId: 'ver-worktree',
    evidenceId: 'ev-red-worktree',
  },
  planned('action-3', 'apply_patch', { patch: PATCH_TEXT }),
  completed('action-3', PATCH),
  {
    type: 'patch_applied',
    evidenceId: 'ev-patch',
    files: [{ path: 'src/a.ts', operation: 'modify', additions: 1, deletions: 1 }],
  },
  planned('action-4', 'run_command', COMMAND_INPUT),
  completed('action-4', GREEN),
  { type: 'verification_recorded', verification: confirmedGreen('ver-repair', GREEN) },
  { type: 'repair_verified', verificationId: 'ver-repair', evidenceId: 'ev-green', changedFiles: ['src/a.ts'], originalUnchanged: true },
  { type: 'investigation_completed', status: 'completed', reason: 'verified' },
];
const position = (type: string, nth = 0): number => {
  const found = SUCCESS.map((payload, index) => [payload.type, index] as const).filter(([t]) => t === type)[nth];
  assert.ok(found, `${type} #${nth}`);
  return found[1];
};
const BASELINE_RUN = 3;
const WORKTREE_RUN = 7;
const PATCH_RUN = 11;
const FINAL_RUN = 14;

const replay = (payloads: readonly Payload[]) =>
  replayInvestigation(
    payloads.map((payload, sequence) => ({ ...payload, investigationId: 'inv-1', sequence, timestamp: NOW }) as InvestigationEvent),
  );
const replacing = (index: number, payload: Payload, log: readonly Payload[] = SUCCESS) =>
  log.map((existing, i) => (i === index ? payload : existing));
const without = (index: number) => SUCCESS.filter((_, i) => i !== index);

describe('repair events', () => {
  it('replays a complete RED -> RED in worktree -> PATCH -> GREEN log', () => {
    const state = replay(SUCCESS);
    assert.equal(state.status, 'completed');
    assert.deepEqual(
      [
        state.repair?.phase,
        state.repair?.baselineEvidenceId,
        state.repair?.worktreeEvidenceId,
        state.repair?.patchEvidenceId,
        state.repair?.finalEvidenceId,
      ],
      ['verified', 'ev-red', 'ev-red-worktree', 'ev-patch', 'ev-green'],
    );
    assert.deepEqual(state.repair?.changedFiles, ['src/a.ts']);
    assert.deepEqual(
      state.actions.map((action) => [action.id, action.status]),
      [
        ['action-1', 'completed'],
        ['action-2', 'completed'],
        ['action-3', 'completed'],
        ['action-4', 'completed'],
      ],
    );
  });

  it('records a failed repair and its reason', () => {
    const state = replay([
      ...SUCCESS.slice(0, position('baseline_verified')),
      { type: 'repair_failed', status: 'baseline_inconclusive', reason: 'timed out', worktreeRemoved: false },
      { type: 'investigation_completed', status: 'completed', reason: 'not verified' },
    ]);
    assert.equal(state.repair?.phase, 'failed');
    assert.deepEqual(state.repair?.failure, { status: 'baseline_inconclusive', reason: 'timed out', worktreeRemoved: false });
  });

  it('refuses a repair_started whose command line disagrees with its argv', () => {
    const started = SUCCESS[1];
    assert.ok(started?.type === 'repair_started');
    assert.throws(() => replay(replacing(1, { ...started, verificationCommand: 'npm run lint' })), /does not match its command/);
  });

  describe('actions', () => {
    it('refuses duplicate, unplanned, repeated, and misattributed completions', () => {
      assert.throws(() => replay(replacing(6, planned('action-1', 'run_command', COMMAND_INPUT))), /already been planned/);
      assert.throws(() => replay(replacing(BASELINE_RUN, completed('action-9', { ...RED, source: { tool: 't', actionId: 'action-9' } }))), /never planned/);
      const twice = [...SUCCESS.slice(0, 4), completed('action-1', RED), ...SUCCESS.slice(5)];
      assert.throws(() => replay(twice), /action-1 has already finished/);
      assert.throws(() => replay(replacing(BASELINE_RUN, completed('action-1', { ...RED, source: { tool: 't', actionId: 'action-4' } }))), /names action action-4, not action-1/);
    });
  });

  describe('baseline_verified', () => {
    const baseline = position('verification_recorded', 0);
    const cases: Array<[string, VerificationResult, RegExp]> = [
      ['an inconclusive RED', verification('ver-baseline', 'fails', 'red', 'inconclusive', 'ev-red'), /confirmed RED/],
      ['a timeout', verification('ver-baseline', 'fails', 'timed_out', 'inconclusive', 'ev-red'), /confirmed RED/],
      ['a GREEN', verification('ver-baseline', 'fails', 'green', 'rejected', 'ev-red'), /confirmed RED/],
      ['a "passes" expectation', verification('ver-baseline', 'passes', 'red', 'confirmed', 'ev-red'), /confirmed RED/],
      ['another command', verification('ver-baseline', 'fails', 'red', 'confirmed', 'ev-red', 'npm run lint'), /not the repair command/],
    ];
    for (const [label, recorded, message] of cases) {
      it(`refuses ${label}`, () => {
        assert.throws(() => replay(replacing(baseline, { type: 'verification_recorded', verification: recorded })), message);
      });
    }

    it('refuses evidence that is not output of the repair command', () => {
      const other = { ...RED, location: { type: 'command' as const, command: 'npm run lint', exitCode: 1 } };
      assert.throws(() => replay(replacing(BASELINE_RUN, completed('action-1', other))), /not output of the repair command/);
    });

    it('refuses a confirmed RED claim whose evidence shows exit code 0 or lacks the expected failure', () => {
      const passing = { ...RED, location: { type: 'command' as const, command: COMMAND, exitCode: 0 } };
      assert.throws(() => replay(replacing(BASELINE_RUN, completed('action-1', passing))), /does not show the RED/);
      const unrelated = { ...RED, content: 'exit code: 1\nnot ok - something else' };
      assert.throws(() => replay(replacing(BASELINE_RUN, completed('action-1', unrelated))), /does not show the RED/);
    });

    it('refuses a run with a different timeout, extra input, or another tool', () => {
      for (const input of [
        { ...COMMAND_INPUT, timeoutMs: 30_000 },
        { ...COMMAND_INPUT, cwd: 'test' },
        { ...COMMAND_INPUT, args: ['test', '--', 'x'] },
      ]) {
        assert.throws(() => replay(replacing(2, planned('action-1', 'run_command', input))), /exact arguments and timeout/);
      }
      assert.throws(() => replay(replacing(2, planned('action-1', 'read_file', COMMAND_INPUT))), /no run_command action of this repair step/);
    });

    it('refuses RED evidence recorded before repair_started', () => {
      const stale = [SUCCESS[0]!, SUCCESS[2]!, SUCCESS[3]!, SUCCESS[4]!, SUCCESS[1]!, ...SUCCESS.slice(5)];
      assert.throws(() => replay(stale), /no run_command action of this repair step produced/);
    });

    it('refuses an unknown verification', () => {
      const log = replacing(position('baseline_verified'), { type: 'baseline_verified', verificationId: 'ver-other', evidenceId: 'ev-red' });
      assert.throws(() => replay(log), /Unknown verification ver-other/);
    });
  });

  describe('worktree_created', () => {
    const created = position('worktree_created');
    const event = SUCCESS[created];
    assert.ok(event?.type === 'worktree_created');

    it('requires its own confirmed RED, not the baseline run', () => {
      assert.throws(() => replay(replacing(created, { ...event, verificationId: 'ver-baseline', evidenceId: 'ev-red' })), /must cite a new verification/);
      const reused = replacing(position('verification_recorded', 1), {
        type: 'verification_recorded',
        verification: verification('ver-worktree', 'fails', 'red', 'confirmed', 'ev-red'),
      });
      assert.throws(() => replay(replacing(created, { ...event, evidenceId: 'ev-red' }, reused)), /no run_command action of this repair step/);
    });

    it('refuses a worktree run that was GREEN before the patch', () => {
      const passing = output('action-2', 0, 'ev-red-worktree');
      const log = replacing(position('verification_recorded', 1), {
        type: 'verification_recorded',
        verification: verification('ver-worktree', 'fails', 'green', 'rejected', 'ev-red-worktree'),
      }, replacing(WORKTREE_RUN, completed('action-2', passing)));
      assert.throws(() => replay(log), /confirmed RED/);
    });
  });

  it('enforces phase order', () => {
    assert.throws(() => replay(without(position('baseline_verified'))), /worktree_created requires repair phase baseline_verified, not started/);
    assert.throws(() => replay(without(position('worktree_created'))), /patch_applied requires repair phase worktree_created/);
    assert.throws(() => replay(without(position('patch_applied'))), /repair_verified requires repair phase patch_applied/);
    assert.throws(() => replay(without(1)), /baseline_verified requires repair_started/);
    const twice = [...SUCCESS.slice(0, 2), SUCCESS[1]!, ...SUCCESS.slice(2)];
    assert.throws(() => replay(twice), /Repair has already started/);
  });

  describe('patch_applied', () => {
    const applied = position('patch_applied');
    it('requires patch evidence', () => {
      const log = replacing(applied, { type: 'patch_applied', evidenceId: 'ev-red', files: [{ path: 'src/a.ts', operation: 'modify', additions: 1, deletions: 1 }] });
      assert.throws(() => replay(log), /unknown patch evidence ev-red/);
    });

    it('refuses evidence of a refused patch or of another worktree', () => {
      const refused = { ...PATCH, location: { ...PATCH.location, status: 'rejected' as const } };
      assert.throws(() => replay(replacing(PATCH_RUN, completed('action-3', refused))), /is rejected in worktree repair-1, not applied/);
      const sibling = { ...PATCH, location: { ...PATCH.location, workspace: 'sibling' } };
      assert.throws(() => replay(replacing(PATCH_RUN, completed('action-3', sibling))), /in worktree sibling, not applied in repair-1/);
    });

    it('refuses evidence for a different patch or different files', () => {
      assert.throws(() => replay(replacing(PATCH_RUN - 1, planned('action-3', 'apply_patch', { patch: `${PATCH_TEXT} ` }))), /different patch/);
      const files = replacing(applied, { type: 'patch_applied', evidenceId: 'ev-patch', files: [{ path: 'src/b.ts', operation: 'modify', additions: 1, deletions: 1 }] });
      assert.throws(() => replay(files), /files differ from the patch evidence/);
    });
  });

  describe('repair_verified', () => {
    const final = position('verification_recorded', 2);
    it('refuses a RED or inconclusive final run', () => {
      const red = replacing(final, { type: 'verification_recorded', verification: verification('ver-repair', 'passes', 'red', 'rejected', 'ev-green') });
      assert.throws(() => replay(red), /confirmed GREEN/);
      const timeout = replacing(final, { type: 'verification_recorded', verification: verification('ver-repair', 'passes', 'timed_out', 'inconclusive', 'ev-green') });
      assert.throws(() => replay(timeout), /confirmed GREEN/);
    });

    it('refuses a GREEN claim whose evidence shows a failing exit code', () => {
      const failing = { ...GREEN, location: { type: 'command' as const, command: COMMAND, exitCode: 1 } };
      assert.throws(() => replay(replacing(FINAL_RUN, completed('action-4', failing))), /does not show the GREEN/);
    });

    it('refuses to reuse an earlier verification or evidence', () => {
      const event = SUCCESS[position('repair_verified')];
      assert.ok(event?.type === 'repair_verified');
      assert.throws(() => replay(replacing(position('repair_verified'), { ...event, verificationId: 'ver-baseline' })), /must cite a new verification/);
      const relabeled = replacing(final, { type: 'verification_recorded', verification: verification('ver-repair', 'passes', 'green', 'confirmed', 'ev-red') });
      assert.throws(() => replay(replacing(position('repair_verified'), { ...event, evidenceId: 'ev-red' }, relabeled)), /confirmed GREEN|does not show the GREEN/);
    });

    it('refuses GREEN output produced before the patch', () => {
      const early = [
        ...SUCCESS.slice(0, PATCH_RUN - 1),
        planned('action-3', 'run_command', COMMAND_INPUT),
        completed('action-3', { ...GREEN, source: { tool: 't', actionId: 'action-3' } }),
        planned('action-4', 'apply_patch', { patch: PATCH_TEXT }),
        completed('action-4', { ...PATCH, source: { tool: 't', actionId: 'action-4' } }),
        SUCCESS[position('patch_applied')]!,
        SUCCESS[final]!,
        SUCCESS[position('repair_verified')]!,
      ];
      assert.throws(() => replay(early), /no run_command action of this repair step produced/);
    });

    it('refuses changed files that differ from the patch', () => {
      for (const changedFiles of [['src/a.ts', 'stray.txt'], ['src/b.ts'], ['src/a.ts', 'src/a.ts']]) {
        const log = replacing(position('repair_verified'), {
          type: 'repair_verified',
          verificationId: 'ver-repair',
          evidenceId: 'ev-green',
          changedFiles,
          originalUnchanged: true,
        });
        assert.throws(() => replay(log), /exactly the patched files/);
      }
    });
  });

  describe('failure identity', () => {
    const baselineRecorded = position('verification_recorded', 0);
    const worktreeRecorded = position('verification_recorded', 1);
    const finalRecorded = position('verification_recorded', 2);
    const command = (id: string, actionId: string, exitCode: number, ...lines: string[]) =>
      evidence(id, actionId, 'command_output', { type: 'command', command: COMMAND, exitCode }, tap(exitCode, ...lines));
    const greenWith = (...lines: string[]) => command('ev-green', 'action-4', 0, ...lines);
    /** The log with `item` as the final output, recorded honestly unless `recorded` is given. */
    const finalRun = (item: Evidence, recorded: VerificationResult = confirmedGreen('ver-repair', item)) =>
      replacing(finalRecorded, { type: 'verification_recorded', verification: recorded }, replacing(FINAL_RUN, completed('action-4', item)));
    /** Checks rewritten to claim the baseline failure passed, whatever the evidence says. */
    const forgedPass = (item: Evidence): VerificationResult => {
      const honest = confirmedGreen('ver-repair', item);
      assert.ok(honest.failureVerification);
      return {
        ...honest,
        failureVerification: {
          ...honest.failureVerification,
          checks: honest.failureVerification.checks.map((check) => ({ ...check, outcome: 'passed' as const, resultLine: 'ok 1 - boom' })),
          problems: [],
        },
      };
    };

    it('G: records the failing test read from the baseline evidence, and its PASS in the final evidence', () => {
      const state = replay(SUCCESS);
      const identity = { testFile: 'test/a.test.ts', line: 3, suite: [], testName: 'boom', resultLine: 'not ok 1 - boom', error: 'boom', evidenceId: 'ev-red' };
      assert.deepEqual(state.repair?.baselineFailures, [identity]);
      assert.deepEqual(state.repair?.failureVerification, {
        evidenceId: 'ev-green',
        checks: [{ failure: identity, outcome: 'passed', resultLine: 'ok 1 - boom' }],
        problems: [],
      });
    });

    it('H/K: refuses a baseline verification that records failing tests its evidence does not show', () => {
      const [real] = failuresIn(RED);
      assert.ok(real);
      const recordedAs = (failures?: VerificationResult['failures']) =>
        replay(replacing(baselineRecorded, { type: 'verification_recorded', verification: { ...verification('ver-baseline', 'fails', 'red', 'confirmed', 'ev-red'), ...(failures ? { failures } : {}) } }));
      assert.throws(() => recordedAs(), /does not record the failing tests its evidence ev-red shows/);
      assert.throws(() => recordedAs([{ ...real, testName: 'other', resultLine: 'not ok 2 - other' }]), /does not record the failing tests/);
      assert.throws(() => recordedAs([real, { ...real, testName: 'other' }]), /does not record the failing tests/);
      assert.throws(() => recordedAs([{ ...real, testFile: 'test/b.test.ts' }]), /does not record the failing tests/);
    });

    it('refuses a RED baseline whose output names no individually attributable failing test', () => {
      const cases: Array<[string[], RegExp]> = [
        [['not ok 1 - boom', '1..1'], /failing test "boom" has no reported location/],
        [['not ok 1 - test/a.test.ts', '  ---', "  location: '<repo>/test/a.test.ts:1:1'", '  error: boom', '  ...', '1..1'], /failed as a whole/],
        [[...FAILING_TAP.slice(0, 7), ...FAILING_TAP.slice(0, 7).map((line) => line.replace('1 - boom', '2 - boom')), '1..2'], /reported 2 times/],
        [['boom', 'Bail out!'], /reports no failing test/],
      ];
      for (const [lines, message] of cases) {
        const red = command('ev-red', 'action-1', 1, ...lines);
        const log = replacing(baselineRecorded, { type: 'verification_recorded', verification: verification('ver-baseline', 'fails', 'red', 'confirmed', 'ev-red') }, replacing(BASELINE_RUN, completed('action-1', red)));
        assert.throws(() => replay(log), message);
      }
    });

    it('refuses an unpatched worktree run that fails a different test than the baseline', () => {
      const different = command('ev-red-worktree', 'action-2', 1, 'ok 1 - boom', 'not ok 2 - other', '  ---', "  location: '<repo>/test/a.test.ts:9:1'", '  error: boom', '  ...', '1..2');
      const log = replacing(worktreeRecorded, { type: 'verification_recorded', verification: confirmedRed('ver-worktree', different) }, replacing(WORKTREE_RUN, completed('action-2', different)));
      assert.throws(() => replay(log), /fail the same tests as the baseline/);
    });

    it('K: refuses repair_verified when the final verification records no failure checks, or forged ones', () => {
      assert.throws(() => replay(finalRun(GREEN, verification('ver-repair', 'passes', 'green', 'confirmed', 'ev-green'))), /does not record the failure checks its evidence ev-green shows/);
      const honest = confirmedGreen('ver-repair', GREEN);
      assert.ok(honest.failureVerification);
      const otherIdentity = { ...honest, failureVerification: { ...honest.failureVerification, checks: honest.failureVerification.checks.map((check) => ({ ...check, failure: { ...check.failure, testName: 'other' } })) } };
      assert.throws(() => replay(finalRun(GREEN, otherIdentity)), /does not record the failure checks/);
    });

    it('L: refuses GREEN output in which a different test passed and the baseline failure is absent', () => {
      const other = greenWith('ok 1 - other', '1..1');
      assert.throws(() => replay(finalRun(other)), /every baseline failure to be reported passing: the previously failing test "boom" \(test\/a\.test\.ts\) was not reported/);
      assert.throws(() => replay(finalRun(other, forgedPass(other))), /does not record the failure checks/);
      const renamed = greenWith('ok 1 - boom (renamed)', 'ok 2 - other', '1..2');
      assert.throws(() => replay(finalRun(renamed)), /"boom" \(test\/a\.test\.ts\) was not reported/);
      const nested = greenWith('# Subtest: suite', '    ok 1 - boom', '    1..1', 'ok 1 - suite', 'ok 2 - other', '1..2');
      assert.throws(() => replay(finalRun(nested)), /"boom" \(test\/a\.test\.ts\) was not reported/, 'a same-named test in another suite is a different test');
    });

    it('M: refuses GREEN output in which the baseline failure was skipped or marked TODO', () => {
      const skipped = greenWith('ok 1 - boom # SKIP', 'ok 2 - other', '1..2');
      assert.throws(() => replay(finalRun(skipped)), /"boom" \(test\/a\.test\.ts\) was skipped/);
      assert.throws(() => replay(finalRun(skipped, forgedPass(skipped))), /does not record the failure checks/);
      const todo = greenWith('not ok 1 - boom # TODO', 'ok 2 - other', '1..2');
      assert.throws(() => replay(finalRun(todo)), /was marked TODO/);
    });

    it('refuses repair_verified when the patch changed the file that declares a baseline failure', () => {
      const started = SUCCESS[1];
      assert.ok(started?.type === 'repair_started');
      const patchingFiles = (paths: string[]) => {
        const text = paths.map((file) => `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-a\n+b\n`).join('');
        return SUCCESS.map((payload, index): Payload => {
          if (index === 1) return { ...started, patchSha256: createHash('sha256').update(text).digest('hex') };
          if (index === PATCH_RUN - 1) return planned('action-3', 'apply_patch', { patch: text });
          if (index === PATCH_RUN) return completed('action-3', evidence('ev-patch', 'action-3', 'patch_application', { type: 'patch', workspace: 'repair-1', paths, status: 'applied' }));
          if (payload.type === 'patch_applied') return { ...payload, files: paths.map((file) => ({ path: file, operation: 'modify', additions: 1, deletions: 1 })) };
          if (payload.type === 'repair_verified') return { ...payload, changedFiles: paths };
          return payload;
        });
      };
      for (const paths of [['test/a.test.ts'], ['src/a.ts', 'test/a.test.ts']]) {
        assert.throws(() => replay(patchingFiles(paths)), /repair_verified cannot change test\/a\.test\.ts, which declares a baseline failing test/);
      }
      assert.equal(replay(patchingFiles(['test/b.test.ts'])).repair?.phase, 'verified', 'another file is not the baseline failure\'s');
    });

    it('refuses GREEN output from a run that stopped early or is ambiguous', () => {
      const cases: Array<[Evidence, RegExp]> = [
        [greenWith('# Subtest: test/a.test.ts', 'ok 1 - test/a.test.ts', '1..1'), /was not reported.*test\/a\.test\.ts is reported as a single result/],
        [greenWith('ok 1 - boom', 'ok 2 - other'), /no closing plan/],
        [greenWith('ok 1 - boom', 'ok 2 - other', '1..3'), /plan announces 3 top-level tests, but 2 were reported/],
        [greenWith('ok 1 - boom', '1..1'), /does not report 1 test\(s\) the baseline reported: "other"/],
        [greenWith('ok 1 - boom', 'ok 2 - boom', 'ok 3 - other', '1..3'), /was reported more than once/],
        [greenWith('ok 1 - boom', '# Subtest: other', '1..1'), /started without a result: "other"/],
      ];
      for (const [item, message] of cases) {
        assert.throws(() => replay(finalRun(item)), message);
        assert.throws(() => replay(finalRun(item, forgedPass(item))), /does not record the failure checks/);
      }
    });
  });

  it('cannot complete with a repair in progress, or fail after success', () => {
    assert.throws(() => replay(without(position('repair_verified'))), InvestigationStateError);
    const failedAfterSuccess = [
      ...SUCCESS.slice(0, -1),
      { type: 'repair_failed', status: 'error', reason: 'late', worktreeRemoved: true } as Payload,
    ];
    assert.throws(() => replay(failedAfterSuccess), /requires a repair in progress/);
  });
});
