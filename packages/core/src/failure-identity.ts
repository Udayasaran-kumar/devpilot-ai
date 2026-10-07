import { z } from 'zod';
import { EvidenceIdSchema, type EvidenceId } from './evidence.js';
import {
  parseTestOutput,
  type SourcePosition,
  type TestFailure,
  type TestResult,
  type TestRunObservation,
} from './test-output.js';

const MAX_TEXT_LENGTH = 2000;

export const SourcePositionSchema = z.strictObject({
  path: z.string().min(1),
  line: z.number().int().positive(),
});

/**
 * One failing test, as the RED command output reported it. Every field is
 * read from that output (`evidenceId`); nothing here comes from a caller,
 * a planner, or a proposal.
 */
export const FailureIdentitySchema = z.strictObject({
  /** Repository-relative test file, from the failure's reported location. */
  testFile: z.string().min(1),
  /** Line of the test's declaration in `testFile`. */
  line: z.number().int().positive(),
  /** Enclosing suites and parent tests, outermost first. */
  suite: z.array(z.string()),
  testName: z.string().min(1),
  /** The TAP result line, verbatim: `not ok 2 - adds numbers`. */
  resultLine: z.string().min(1),
  error: z.string().min(1).max(MAX_TEXT_LENGTH).optional(),
  expected: z.string().max(MAX_TEXT_LENGTH).optional(),
  actual: z.string().max(MAX_TEXT_LENGTH).optional(),
  comparison: z.string().min(1).max(MAX_TEXT_LENGTH).optional(),
  /** Where the failure occurred: the first stack frame inside the repository. */
  occurrence: SourcePositionSchema.optional(),
  /** The command output the failure was read from. */
  evidenceId: EvidenceIdSchema,
});
export type FailureIdentity = z.infer<typeof FailureIdentitySchema>;

/**
 * How the final run reported a baseline failure. Only `passed` counts:
 * `skipped` and `todo` did not run or do not fail the run, `not_reported`
 * means there is no evidence the test ran, `reported_more_than_once` is
 * ambiguous, and `in_other_file` is a same-named test declared elsewhere.
 */
export const FailureCheckOutcomeSchema = z.enum([
  'passed',
  'failed',
  'skipped',
  'todo',
  'not_reported',
  'reported_more_than_once',
  'in_other_file',
]);
export type FailureCheckOutcome = z.infer<typeof FailureCheckOutcomeSchema>;

export const FailureCheckSchema = z.strictObject({
  /** The baseline identity, unchanged. */
  failure: FailureIdentitySchema,
  outcome: FailureCheckOutcomeSchema,
  /** The final run's result line for the test, when it reported it exactly once. */
  resultLine: z.string().min(1).optional(),
});
export type FailureCheck = z.infer<typeof FailureCheckSchema>;

/** Signs that the final run stopped or changed before every test was reported. */
export const TestRunProblemCodeSchema = z.enum([
  'no_test_plan',
  'plan_mismatch',
  'test_file_exited_early',
  'tests_missing',
  'tests_unfinished',
]);
export type TestRunProblemCode = z.infer<typeof TestRunProblemCodeSchema>;

export const TestRunProblemSchema = z.strictObject({
  code: TestRunProblemCodeSchema,
  message: z.string().min(1),
});
export type TestRunProblem = z.infer<typeof TestRunProblemSchema>;

export const FailureVerificationSchema = z.strictObject({
  /** The final command output the checks were read from. */
  evidenceId: EvidenceIdSchema,
  checks: z.array(FailureCheckSchema).min(1),
  problems: z.array(TestRunProblemSchema),
});
export type FailureVerification = z.infer<typeof FailureVerificationSchema>;

export type FailureIdentification =
  | { readonly ok: true; readonly failures: readonly FailureIdentity[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Reads the failing tests from RED command output. Each needs a reported
 * location in the repository and a name (with its suites) that the run reports
 * exactly once, because `node --test` does not print where a passing test is
 * declared: the final run can only match it by name. A test file that failed
 * as a whole is not an individual test, and a failure that is only "a subtest
 * failed" is represented by that subtest.
 */
export function identifyFailures(content: string, evidenceId: EvidenceId): FailureIdentification {
  const run = parseTestOutput(content);
  const failed = run.failed.filter((item) => item.failureType !== 'subtestsFailed');
  if (failed.length === 0) return { ok: false, reason: 'its output reports no failing test (TAP "not ok") to verify the repair against' };

  const failures: FailureIdentity[] = [];
  for (const failure of failed) {
    const label = testLabel(failure.ancestors, failure.name);
    if (failure.name.length === 0) return { ok: false, reason: `a failing test has no name (${failure.resultLine})` };
    if (!failure.location) return { ok: false, reason: `failing test ${label} has no reported location inside the repository` };
    if (failure.ancestors.length === 0 && failure.name === failure.location.path) {
      return { ok: false, reason: `test file ${failure.name} failed as a whole (for example while loading), so there is no individual failing test to verify` };
    }
    const reported = run.results.filter((item) => sameTest(item, failure)).length;
    if (reported !== 1) return { ok: false, reason: `test ${label} is reported ${reported} times; a failing test must be uniquely named to be verified` };
    failures.push(identityOf(failure, failure.location, evidenceId));
  }
  return { ok: true, failures };
}

function identityOf(failure: TestFailure, location: SourcePosition, evidenceId: EvidenceId): FailureIdentity {
  const clip = (text: string) => text.slice(0, MAX_TEXT_LENGTH);
  return {
    testFile: location.path,
    line: location.line,
    suite: [...failure.ancestors],
    testName: failure.name,
    resultLine: failure.resultLine,
    ...(failure.error !== undefined ? { error: clip(failure.error) } : {}),
    ...(failure.expected !== undefined ? { expected: clip(failure.expected) } : {}),
    ...(failure.actual !== undefined ? { actual: clip(failure.actual) } : {}),
    ...(failure.comparison !== undefined ? { comparison: clip(failure.comparison) } : {}),
    ...(failure.failurePosition ? { occurrence: { ...failure.failurePosition } } : {}),
    evidenceId,
  };
}

export interface FailureResolutionInput {
  readonly failures: readonly FailureIdentity[];
  /** Content of the evidence the failures were identified in. */
  readonly baselineContent: string;
  readonly finalContent: string;
  readonly finalEvidenceId: EvidenceId;
}

/**
 * How the final run reported each baseline failure, and whether the run
 * itself shows signs of stopping early: no closing plan, a plan that does not
 * match the results, a test file reported as a single result (what
 * `node --test` prints when a file exits before reporting its tests), tests
 * the baseline reported that are now absent, or tests that started without
 * finishing.
 */
export function checkFailureResolution(input: FailureResolutionInput): FailureVerification {
  const baseline = parseTestOutput(input.baselineContent);
  const final = parseTestOutput(input.finalContent);
  const checks = input.failures.map((failure): FailureCheck => {
    const matches = final.results.filter((item) => item.name === failure.testName && sameList(item.ancestors, failure.suite));
    const [match] = matches;
    if (!match) return { failure, outcome: 'not_reported' };
    if (matches.length > 1) return { failure, outcome: 'reported_more_than_once' };
    const outcome = match.location && match.location.path !== failure.testFile ? 'in_other_file' : match.outcome;
    return { failure, outcome, resultLine: match.resultLine };
  });
  return { evidenceId: input.finalEvidenceId, checks, problems: runProblems(baseline, final, input.failures) };
}

function runProblems(baseline: TestRunObservation, final: TestRunObservation, failures: readonly FailureIdentity[]): TestRunProblem[] {
  const problems: TestRunProblem[] = [];
  const topLevel = final.results.filter((item) => item.ancestors.length === 0).length;
  if (final.plan === null) {
    problems.push({ code: 'no_test_plan', message: 'the test output has no closing plan (1..N), so the runner did not finish reporting' });
  } else if (final.plan !== topLevel) {
    problems.push({ code: 'plan_mismatch', message: `the test plan announces ${final.plan} top-level tests, but ${topLevel} were reported` });
  }
  for (const file of [...new Set(failures.map((failure) => failure.testFile))]) {
    if (final.results.some((item) => item.ancestors.length === 0 && item.name === file)) {
      problems.push({
        code: 'test_file_exited_early',
        message: `${file} is reported as a single result, as node --test does when a test file exits or crashes before reporting its tests`,
      });
    }
  }
  const missing = uniqueTests(baseline.results).filter((test) => !final.results.some((item) => sameTest(item, test)));
  if (missing.length > 0) {
    problems.push({ code: 'tests_missing', message: `the run does not report ${missing.length} test(s) the baseline reported: ${listTests(missing)}` });
  }
  if (final.unfinished.length > 0) {
    problems.push({ code: 'tests_unfinished', message: `test(s) started without a result: ${listTests(final.unfinished)}` });
  }
  return problems;
}

/** Every baseline failure was reported passing, exactly once, by a run that shows no sign of stopping early. */
export function isFailureResolved(verification: FailureVerification): boolean {
  return verification.checks.length > 0 && verification.problems.length === 0 && verification.checks.every((check) => check.outcome === 'passed');
}

const OUTCOME_PHRASES: Record<FailureCheckOutcome, string> = {
  passed: 'passed',
  failed: 'still failed',
  skipped: 'was skipped, so it did not run',
  todo: 'was marked TODO, so its result does not count',
  not_reported: 'was not reported, so there is no evidence it ran',
  reported_more_than_once: 'was reported more than once, so its result is ambiguous',
  in_other_file: 'was reported from a different file',
};

/** Why `verification` does not show the baseline failures resolved; empty when it does. */
export function describeUnresolved(verification: FailureVerification): string {
  return [
    ...verification.checks
      .filter((check) => check.outcome !== 'passed')
      .map((check) => `the previously failing test ${failureLabel(check.failure)} ${OUTCOME_PHRASES[check.outcome]}`),
    ...verification.problems.map((problem) => problem.message),
  ].join('; ');
}

/** The same tests, by file, suites, and name; evidence and messages may differ between runs. */
export function sameFailingTests(left: readonly FailureIdentity[], right: readonly FailureIdentity[]): boolean {
  const keys = (failures: readonly FailureIdentity[]) => failures.map((item) => JSON.stringify([item.testFile, item.suite, item.testName])).sort();
  return sameList(keys(left), keys(right));
}

/** `"suite > name" (file)`, for messages and reports. */
export function failureLabel(failure: FailureIdentity): string {
  return `${testLabel(failure.suite, failure.testName)} (${failure.testFile})`;
}

function testLabel(ancestors: readonly string[], name: string): string {
  return JSON.stringify([...ancestors, name].join(' > '));
}

function sameTest(left: Pick<TestResult, 'name' | 'ancestors'>, right: Pick<TestResult, 'name' | 'ancestors'>): boolean {
  return left.name === right.name && sameList(left.ancestors, right.ancestors);
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function uniqueTests(results: readonly TestResult[]): Pick<TestResult, 'name' | 'ancestors'>[] {
  const seen = new Map<string, Pick<TestResult, 'name' | 'ancestors'>>();
  for (const item of results) seen.set(JSON.stringify([...item.ancestors, item.name]), item);
  return [...seen.values()];
}

function listTests(tests: readonly Pick<TestResult, 'name' | 'ancestors'>[]): string {
  const shown = tests.slice(0, 5).map((test) => testLabel(test.ancestors, test.name)).join(', ');
  return tests.length > 5 ? `${shown} (+${tests.length - 5} more)` : shown;
}
