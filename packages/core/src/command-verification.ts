import { formatCommandLine, type CommandExecutionResult } from './command.js';
import type { EvidenceId } from './evidence.js';
import {
  checkFailureResolution,
  describeUnresolved,
  failureLabel,
  identifyFailures,
  isFailureResolved,
  type FailureIdentity,
  type FailureVerification,
} from './failure-identity.js';
import {
  VerificationResultSchema,
  type CommandOutcome,
  type VerificationExpectation,
  type VerificationResult,
  type VerificationStatus,
} from './verification.js';

export function classifyCommandOutcome(
  result: Pick<CommandExecutionResult, 'startError' | 'timedOut' | 'exitCode'>,
): CommandOutcome {
  if (result.startError !== null) return 'not_started';
  if (result.timedOut) return 'timed_out';
  if (result.exitCode === null) return 'terminated';
  return result.exitCode === 0 ? 'green' : 'red';
}

export interface CommandVerificationInput {
  readonly id: string;
  readonly result: CommandExecutionResult;
  /** Evidence item that records `result`, such as the one produced by the run_command tool. */
  readonly evidenceId: EvidenceId;
  readonly expectation: VerificationExpectation;
  /**
   * Text taken from the signal, such as the failing test name or assertion
   * message. A RED run only confirms a `fails` expectation when every entry
   * appears in the command output; otherwise the failure cannot be attributed
   * to the signal.
   */
  readonly expectedOutput?: readonly string[];
  /**
   * Content of the evidence item `evidenceId`. With it, a RED run confirms a
   * `fails` expectation only if the failing tests can be identified in it
   * (`failures`).
   */
  readonly evidenceContent?: string;
  /**
   * For a `passes` expectation: the failures a baseline run identified and the
   * content of that run's evidence. A GREEN run then confirms the expectation
   * only if every one of those tests is reported passing (`failureVerification`);
   * an exit code of 0 alone is not enough.
   */
  readonly baseline?: { readonly failures: readonly FailureIdentity[]; readonly content: string };
  readonly completedAt?: string;
}

/**
 * Interprets one verification command run. The status says whether the
 * expectation held, never whether a hypothesis is true: a non-zero exit only
 * means the command failed.
 */
export function verifyCommandResult(input: CommandVerificationInput): VerificationResult {
  const expectedOutput = input.expectedOutput ?? [];
  if (expectedOutput.some((text) => text.length === 0)) {
    throw new RangeError('expectedOutput entries must be non-empty strings');
  }
  if (input.baseline !== undefined && (input.expectation !== 'passes' || input.evidenceContent === undefined)) {
    throw new RangeError('baseline failures apply to a "passes" expectation with evidenceContent');
  }

  const { result } = input;
  const commandOutcome = classifyCommandOutcome(result);
  const commandLine = formatCommandLine(result.command, result.args);
  let [status, summary] = assess(input.expectation, commandOutcome, commandLine, result, expectedOutput);

  let failures: readonly FailureIdentity[] | undefined;
  if (input.expectation === 'fails' && status === 'confirmed' && input.evidenceContent !== undefined) {
    const identified = identifyFailures(input.evidenceContent, input.evidenceId);
    if (identified.ok) {
      failures = identified.failures;
      summary = `${summary}; failing test(s): ${identified.failures.map(failureLabel).join(', ')}`;
    } else {
      status = 'inconclusive';
      summary = `${summary}, but ${identified.reason}`;
    }
  }

  let failureVerification: FailureVerification | undefined;
  if (input.baseline !== undefined && (commandOutcome === 'green' || commandOutcome === 'red')) {
    failureVerification = checkFailureResolution({
      failures: input.baseline.failures,
      baselineContent: input.baseline.content,
      finalContent: input.evidenceContent ?? '',
      finalEvidenceId: input.evidenceId,
    });
    if (commandOutcome === 'green') {
      [status, summary] = assessResolution(`"${commandLine}" exited with code 0 (GREEN)`, failureVerification);
    }
  }

  return VerificationResultSchema.parse({
    id: input.id,
    status,
    summary,
    command: commandLine,
    ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
    expectation: input.expectation,
    commandOutcome,
    evidenceIds: [input.evidenceId],
    ...(failures !== undefined ? { failures } : {}),
    ...(failureVerification !== undefined ? { failureVerification } : {}),
    ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
  });
}

/** A GREEN run against baseline failures: confirmed only when each of them is reported passing. */
function assessResolution(green: string, verification: FailureVerification): [VerificationStatus, string] {
  if (isFailureResolved(verification)) {
    const passed = verification.checks.map((check) => failureLabel(check.failure)).join(', ');
    return ['confirmed', `${green}, and the previously failing test(s) ${passed} passed`];
  }
  const stillFailing = verification.checks.some((check) => check.outcome === 'failed');
  return [stillFailing ? 'rejected' : 'inconclusive', `${green}, but ${describeUnresolved(verification)}`];
}

function assess(
  expectation: VerificationExpectation,
  outcome: CommandOutcome,
  commandLine: string,
  result: CommandExecutionResult,
  expectedOutput: readonly string[],
): [VerificationStatus, string] {
  const subject = `"${commandLine}"`;
  switch (outcome) {
    case 'not_started':
      return ['not_run', `${subject} could not be started: ${result.startError}`];
    case 'timed_out':
      return ['inconclusive', `${subject} timed out before producing a pass/fail result`];
    case 'terminated':
      return ['inconclusive', `${subject} was terminated by ${result.signal ?? 'a signal'} before exiting`];
    case 'green':
      return expectation === 'passes'
        ? ['confirmed', `${subject} exited with code 0 (GREEN), as expected`]
        : ['rejected', `${subject} exited with code 0 (GREEN); the expected failure did not reproduce`];
    case 'red': {
      const red = `${subject} exited with code ${result.exitCode} (RED)`;
      if (expectation === 'passes') {
        return ['rejected', `${red}; expected it to pass`];
      }
      if (expectedOutput.length === 0) {
        return ['inconclusive', `${red}, but no expected failure output was given to attribute it to the signal`];
      }
      const output = `${result.stdout}\n${result.stderr}`;
      const missing = expectedOutput.filter((text) => !output.includes(text));
      if (missing.length > 0) {
        const truncated = result.stdoutTruncated || result.stderrTruncated ? ' (output was truncated)' : '';
        return ['inconclusive', `${red}, but its output does not contain ${quoteAll(missing)}${truncated}`];
      }
      return ['confirmed', `${red} and its output contains ${quoteAll(expectedOutput)}`];
    }
  }
}

function quoteAll(texts: readonly string[]): string {
  return texts.map((text) => JSON.stringify(text)).join(', ');
}
