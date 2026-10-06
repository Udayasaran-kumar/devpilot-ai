import { formatCommandLine, type CommandExecutionResult } from './command.js';
import type { EvidenceId } from './evidence.js';
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

  const { result } = input;
  const commandOutcome = classifyCommandOutcome(result);
  const commandLine = formatCommandLine(result.command, result.args);
  const [status, summary] = assess(input.expectation, commandOutcome, commandLine, result, expectedOutput);

  return VerificationResultSchema.parse({
    id: input.id,
    status,
    summary,
    command: commandLine,
    ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
    expectation: input.expectation,
    commandOutcome,
    evidenceIds: [input.evidenceId],
    ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
  });
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
