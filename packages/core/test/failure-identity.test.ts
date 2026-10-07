import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkFailureResolution,
  FailureIdentitySchema,
  FailureVerificationSchema,
  identifyFailures,
  isFailureResolved,
  parseTestOutput,
  sameFailingTests,
  verifyCommandResult,
  type CommandExecutionResult,
  type FailureIdentity,
} from '../src/index.js';

const BASELINE_ID = 'ev-0000000000000001';
const FINAL_ID = 'ev-0000000000000002';

/** Shaped like `node --test` output, with the repository root redacted as the sandbox does. */
const failing = (number: number, name: string, line: number, comparison: string, indent = '') =>
  [
    `# Subtest: ${name}`,
    `not ok ${number} - ${name}`,
    '  ---',
    '  duration_ms: 0.59',
    "  type: 'test'",
    `  location: '<repo>/test/math.test.ts:${line}:1'`,
    "  failureType: 'testCodeFailure'",
    '  error: |-',
    '    Expected values to be strictly equal:',
    '    ',
    `    ${comparison}`,
    '    ',
    "  code: 'ERR_ASSERTION'",
    `  expected: ${comparison.split(' !== ')[1]}`,
    `  actual: ${comparison.split(' !== ')[0]}`,
    '  stack: |-',
    `    TestContext.<anonymous> (file://<repo>/test/math.test.ts:${line + 2}:10)`,
    '    async Test.run (node:internal/test_runner/test:1054:7)',
    '  ...',
  ].map((text) => indent + text);
const passing = (number: number, name: string, suffix = '') => [`# Subtest: ${name}`, `ok ${number} - ${name}${suffix}`, '  ---', '  duration_ms: 0.2', "  type: 'test'", '  ...'];
const run = (...lines: string[]) => ['TAP version 13', ...lines, '# tests 3', '# pass 2', '# fail 1'].join('\n');

const BASELINE = run(...passing(1, 'adds numbers'), ...failing(2, 'multiplies numbers', 9, '7 !== 12'), ...passing(3, 'divides numbers'), '1..3');
const FIXED = run(...passing(1, 'adds numbers'), ...passing(2, 'multiplies numbers'), ...passing(3, 'divides numbers'), '1..3');

const identities = (content: string, evidenceId = BASELINE_ID): readonly FailureIdentity[] => {
  const identified = identifyFailures(content, evidenceId);
  assert.ok(identified.ok, identified.ok ? '' : identified.reason);
  return identified.failures;
};
const resolve = (final: string, baseline = BASELINE) =>
  checkFailureResolution({ failures: identities(baseline), baselineContent: baseline, finalContent: final, finalEvidenceId: FINAL_ID });

describe('TAP parsing', () => {
  it('distinguishes passed, failed, skipped, and todo results', () => {
    const observed = parseTestOutput(
      run('ok 1 - runs', 'not ok 2 - breaks', 'ok 3 - is skipped # SKIP not today', 'not ok 4 - is pending # TODO later', 'ok 5 - lower case # skip', '1..5'),
    );
    assert.deepEqual(
      observed.results.map((result) => [result.name, result.outcome]),
      [
        ['runs', 'passed'],
        ['breaks', 'failed'],
        ['is skipped', 'skipped'],
        ['is pending', 'todo'],
        ['lower case', 'skipped'],
      ],
    );
    assert.deepEqual(observed.passed.map((test) => test.name), ['runs'], 'a skipped test is not a pass');
    assert.deepEqual(observed.failed.map((test) => test.name), ['breaks'], 'a todo failure does not fail the run');
    assert.equal(observed.plan, 5);
  });

  it('reads nesting from indentation and # Subtest headers', () => {
    const observed = parseTestOutput(
      [
        '# Subtest: outer',
        '    # Subtest: inner',
        '        # Subtest: deep',
        '        ok 1 - deep',
        '        1..1',
        '    ok 1 - inner',
        '    1..1',
        'ok 1 - outer',
        '1..1',
      ].join('\n'),
    );
    assert.deepEqual(
      observed.results.map((result) => [result.ancestors, result.name]),
      [
        [['outer', 'inner'], 'deep'],
        [['outer'], 'inner'],
        [[], 'outer'],
      ],
    );
    assert.equal(observed.plan, 1, 'nested plans are not the run plan');
    assert.deepEqual(observed.unfinished, []);
  });

  it('reports tests that started without a result, and a missing plan', () => {
    const observed = parseTestOutput(['# Subtest: first', 'ok 1 - first', '# Subtest: second', '# Subtest: third', 'ok 2 - third'].join('\n'));
    assert.deepEqual(observed.unfinished, [{ name: 'second', ancestors: [] }]);
    assert.equal(observed.plan, null);
  });

  it('never reads text inside a YAML block, or printed output, as a result', () => {
    const observed = parseTestOutput(
      [
        '# ok 7 - printed by the code under test',
        'not ok 1 - compares strings',
        '  ---',
        '  error: |-',
        '    ok 2 - this line is part of an assertion message',
        '    1..9',
        '  ...',
        '1..1',
      ].join('\n'),
    );
    assert.deepEqual(observed.results.map((result) => result.name), ['compares strings']);
    assert.equal(observed.failed[0]?.error, 'ok 2 - this line is part of an assertion message\n1..9');
    assert.equal(observed.plan, 1);
  });

  it('treats an unclosed YAML block (truncated output) as the end of the results', () => {
    const observed = parseTestOutput(['not ok 1 - compares strings', '  ---', '  error: |-', '    ok 2 - inside the message'].join('\n'));
    assert.deepEqual(observed.results.map((result) => result.name), ['compares strings']);
    assert.equal(observed.plan, null);
  });

  it('unescapes TAP descriptions so a "#" in a test name is not a directive', () => {
    const observed = parseTestOutput(['ok 1 - handles \\# SKIP in names', 'ok 2 - back\\\\slash', '1..2'].join('\n'));
    assert.deepEqual(
      observed.results.map((result) => [result.name, result.outcome]),
      [
        ['handles # SKIP in names', 'passed'],
        ['back\\slash', 'passed'],
      ],
    );
  });
});

describe('failure identity', () => {
  it('G: is derived from the RED output: file, declaration line, name, result line, error, values, and where it was raised', () => {
    const [identity] = identities(BASELINE);
    assert.deepEqual(identity, {
      testFile: 'test/math.test.ts',
      line: 9,
      suite: [],
      testName: 'multiplies numbers',
      resultLine: 'not ok 2 - multiplies numbers',
      error: 'Expected values to be strictly equal:\n\n7 !== 12',
      expected: '12',
      actual: '7',
      comparison: '7 !== 12',
      occurrence: { path: 'test/math.test.ts', line: 11 },
      evidenceId: BASELINE_ID,
    });
    FailureIdentitySchema.parse(identity);
    assert.ok(identity && BASELINE.includes(identity.resultLine) && BASELINE.includes('7 !== 12'));
    assert.throws(() => FailureIdentitySchema.parse({ ...identity, verifiedBy: 'caller' }), 'the identity schema is strict');
  });

  it('N: represents every failing test of a run, including nested ones, and not their failing parents', () => {
    const content = run(
      ...failing(1, 'multiplies numbers', 9, '7 !== 12'),
      '# Subtest: division',
      ...failing(1, 'divides by two', 20, '3 !== 2', '    '),
      '    1..1',
      'not ok 2 - division',
      '  ---',
      "  location: '<repo>/test/math.test.ts:18:1'",
      "  failureType: 'subtestsFailed'",
      "  error: '1 subtest failed'",
      '  ...',
      '1..2',
    );
    const failures = identities(content);
    assert.deepEqual(
      failures.map((failure) => [failure.suite, failure.testName, failure.line]),
      [
        [[], 'multiplies numbers', 9],
        [['division'], 'divides by two', 20],
      ],
    );

    const final = (first: string, second: string) =>
      run(...passing(1, 'multiplies numbers', first), '# Subtest: division', ...passing(1, 'divides by two', second).map((line) => `    ${line}`), '    1..1', 'ok 2 - division', '1..2');
    assert.equal(isFailureResolved(resolve(final('', ''), content)), true, 'all baseline failures pass');
    const partly = resolve(final('', ' # SKIP'), content);
    assert.equal(isFailureResolved(partly), false, 'every baseline failure must pass, not just one');
    assert.deepEqual(partly.checks.map((check) => check.outcome), ['passed', 'skipped']);
  });

  it('refuses output in which the failing test cannot be attributed', () => {
    const cases: Array<[string, RegExp]> = [
      [run('ok 1 - adds numbers', '1..1'), /reports no failing test/],
      ['FAIL src/math.test.js\n  Expected: 12', /reports no failing test/],
      [run('not ok 1 - multiplies numbers', '1..1'), /has no reported location inside the repository/],
      [run('not ok 1 - test/math.test.ts', '  ---', "  location: '<repo>/test/math.test.ts:1:1'", '  ...', '1..1'), /failed as a whole/],
      [run(...failing(1, 'multiplies numbers', 9, '7 !== 12'), ...passing(2, 'multiplies numbers'), '1..2'), /reported 2 times/],
      [run(...failing(1, 'multiplies numbers', 9, '7 !== 12').map((line) => line.replace('<repo>/', '/elsewhere/')), '1..1'), /no reported location inside/],
    ];
    for (const [content, reason] of cases) {
      const identified = identifyFailures(content, BASELINE_ID);
      assert.equal(identified.ok, false, content);
      assert.match(identified.ok ? '' : identified.reason, reason);
    }
  });

  it('compares failing tests by file, suites, and name, not by evidence or message', () => {
    const [identity] = identities(BASELINE);
    assert.ok(identity);
    assert.equal(sameFailingTests([identity], [{ ...identity, evidenceId: FINAL_ID, error: 'other text' }]), true);
    assert.equal(sameFailingTests([identity], [{ ...identity, testName: 'adds numbers' }]), false);
    assert.equal(sameFailingTests([identity], [{ ...identity, suite: ['math'] }]), false);
    assert.equal(sameFailingTests([identity], [{ ...identity, testFile: 'test/other.test.ts' }]), false);
    assert.equal(sameFailingTests([identity], [identity, identity]), false);
  });
});

describe('failure resolution', () => {
  it('A: the baseline failure reported passing, once, in a complete run, is resolved', () => {
    const verification = resolve(FIXED);
    FailureVerificationSchema.parse(verification);
    assert.deepEqual(verification.checks.map((check) => [check.failure.testName, check.outcome, check.resultLine]), [
      ['multiplies numbers', 'passed', 'ok 2 - multiplies numbers'],
    ]);
    assert.deepEqual(verification.problems, []);
    assert.equal(verification.evidenceId, FINAL_ID);
    assert.equal(isFailureResolved(verification), true);
  });

  const unresolved: Array<[string, string, string, string[]]> = [
    ['B: the test file exited before reporting any test', run('# Subtest: test/math.test.ts', 'ok 1 - test/math.test.ts', '1..1'), 'not_reported', ['test_file_exited_early', 'tests_missing']],
    ['C: the failing test was skipped', run(...passing(1, 'adds numbers'), ...passing(2, 'multiplies numbers', ' # SKIP'), ...passing(3, 'divides numbers'), '1..3'), 'skipped', []],
    [
      'C: the failing test was marked TODO and still failed',
      run(...passing(1, 'adds numbers'), ...failing(2, 'multiplies numbers', 9, '7 !== 12').map((line) => (line.startsWith('not ok') ? `${line} # TODO` : line)), ...passing(3, 'divides numbers'), '1..3'),
      'todo',
      [],
    ],
    ['D: the failing test never ran', run(...passing(1, 'adds numbers'), ...passing(2, 'divides numbers'), '1..2'), 'not_reported', ['tests_missing']],
    ['E: another test passed, the failing test still failed', run(...passing(1, 'adds numbers'), ...failing(2, 'multiplies numbers', 9, '7 !== 12'), ...passing(3, 'divides numbers'), ...passing(4, 'multiplies numbers again'), '1..4'), 'failed', []],
    ['F: the failing test was renamed', run(...passing(1, 'adds numbers'), ...passing(2, 'multiplies numbers correctly'), ...passing(3, 'divides numbers'), '1..3'), 'not_reported', ['tests_missing']],
    ['F: a same-named test was added next to the failing one', run(...passing(1, 'adds numbers'), ...passing(2, 'multiplies numbers', ' # SKIP'), ...passing(3, 'divides numbers'), ...passing(4, 'multiplies numbers'), '1..4'), 'reported_more_than_once', []],
    ['a same-named test failed in another file', run(...passing(1, 'adds numbers'), ...failing(2, 'multiplies numbers', 9, '7 !== 12').map((line) => line.replace('test/math', 'test/other')), ...passing(3, 'divides numbers'), '1..3'), 'in_other_file', []],
    ['the output stopped before its plan', run(...passing(1, 'adds numbers'), ...passing(2, 'multiplies numbers')), 'passed', ['no_test_plan', 'tests_missing']],
    ['the plan announces more tests than were reported', run(...passing(1, 'adds numbers'), ...passing(2, 'multiplies numbers'), ...passing(3, 'divides numbers'), '1..4'), 'passed', ['plan_mismatch']],
    ['a test started without finishing', run(...passing(1, 'adds numbers'), ...passing(2, 'multiplies numbers'), ...passing(3, 'divides numbers'), '# Subtest: later', '1..3'), 'passed', ['tests_unfinished']],
  ];
  for (const [label, final, outcome, problems] of unresolved) {
    it(`${label}: not resolved`, () => {
      const verification = resolve(final);
      assert.deepEqual(verification.checks.map((check) => check.outcome), [outcome]);
      assert.deepEqual(verification.problems.map((problem) => problem.code), problems);
      assert.equal(isFailureResolved(verification), false);
    });
  }
});

describe('verifyCommandResult with failure identity', () => {
  const result = (exitCode: number, stdout: string): CommandExecutionResult => ({
    command: 'npm',
    args: ['test'],
    cwd: '.',
    exitCode,
    signal: null,
    timedOut: false,
    startError: null,
    durationMs: 100,
    stdout,
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
  });
  const baseline = { failures: identities(BASELINE), content: BASELINE };
  const final = (stdout: string, exitCode = 0) =>
    verifyCommandResult({ id: 'ver-final', result: result(exitCode, stdout), evidenceId: FINAL_ID, expectation: 'passes', evidenceContent: stdout, baseline });

  it('a RED run confirms a "fails" expectation only with identified failing tests', () => {
    const red = verifyCommandResult({
      id: 'ver-red',
      result: result(1, BASELINE),
      evidenceId: BASELINE_ID,
      expectation: 'fails',
      expectedOutput: ['7 !== 12'],
      evidenceContent: BASELINE,
    });
    assert.equal(red.status, 'confirmed');
    assert.deepEqual(red.failures, identities(BASELINE));
    const unattributed = run('not ok 1 - multiplies numbers', '  7 !== 12', '1..1');
    const vague = verifyCommandResult({
      id: 'ver-red',
      result: result(1, unattributed),
      evidenceId: BASELINE_ID,
      expectation: 'fails',
      expectedOutput: ['7 !== 12'],
      evidenceContent: unattributed,
    });
    assert.equal(vague.status, 'inconclusive');
    assert.equal(vague.failures, undefined);
    assert.match(vague.summary, /has no reported location/);
  });

  it('B: exit code 0 alone does not confirm a "passes" expectation against a baseline', () => {
    const exited = final(run('# Subtest: test/math.test.ts', 'ok 1 - test/math.test.ts', '1..1'));
    assert.equal(exited.commandOutcome, 'green');
    assert.equal(exited.status, 'inconclusive');
    assert.match(exited.summary, /exited with code 0 \(GREEN\), but the previously failing test "multiplies numbers" \(test\/math\.test\.ts\) was not reported/);
    assert.equal(exited.failureVerification?.checks[0]?.outcome, 'not_reported');

    const confirmed = final(FIXED);
    assert.equal(confirmed.status, 'confirmed');
    assert.match(confirmed.summary, /and the previously failing test\(s\) "multiplies numbers" \(test\/math\.test\.ts\) passed/);
    assert.equal(final(run(...failing(2, 'multiplies numbers', 9, '7 !== 12'), '1..1'), 1).status, 'rejected');
  });

  it('refuses a baseline without evidence content or for a "fails" expectation', () => {
    assert.throws(() => verifyCommandResult({ id: 'v', result: result(0, FIXED), evidenceId: FINAL_ID, expectation: 'passes', baseline }), RangeError);
    assert.throws(
      () => verifyCommandResult({ id: 'v', result: result(1, FIXED), evidenceId: FINAL_ID, expectation: 'fails', evidenceContent: FIXED, baseline }),
      RangeError,
    );
  });
});
