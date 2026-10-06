import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyCommandOutcome,
  CommandExecutionResultSchema,
  formatCommandLine,
  VerificationResultSchema,
  verifyCommandResult,
  type CommandExecutionResult,
  type VerificationExpectation,
} from '../src/index.js';

const EVIDENCE_ID = 'ev-0123456789abcdef';

function commandResult(overrides: Partial<CommandExecutionResult> = {}): CommandExecutionResult {
  return {
    command: 'npm',
    args: ['test'],
    cwd: '.',
    exitCode: 1,
    signal: null,
    timedOut: false,
    startError: null,
    durationMs: 120,
    stdout: 'not ok 2 - applies tax to the discounted amount\n  200 !== 180\n# fail 1\n',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}

const RED = commandResult();
const GREEN = commandResult({ exitCode: 0, stdout: '# pass 3\n# fail 0\n' });
const TIMED_OUT = commandResult({ exitCode: null, signal: 'SIGKILL', timedOut: true, stdout: '' });
const TERMINATED = commandResult({ exitCode: null, signal: 'SIGTERM', stdout: '' });
const NOT_STARTED = commandResult({ exitCode: null, startError: 'spawn npm ENOENT', stdout: '' });

function verify(result: CommandExecutionResult, expectation: VerificationExpectation, expectedOutput?: string[]) {
  return verifyCommandResult({
    id: 'ver-1',
    result,
    evidenceId: EVIDENCE_ID,
    expectation,
    ...(expectedOutput ? { expectedOutput } : {}),
  });
}

describe('classifyCommandOutcome', () => {
  it('distinguishes RED, GREEN, timeouts, terminations, and failures to start', () => {
    assert.equal(classifyCommandOutcome(RED), 'red');
    assert.equal(classifyCommandOutcome(commandResult({ exitCode: 2 })), 'red');
    assert.equal(classifyCommandOutcome(GREEN), 'green');
    assert.equal(classifyCommandOutcome(TIMED_OUT), 'timed_out');
    assert.equal(classifyCommandOutcome(TERMINATED), 'terminated');
    assert.equal(classifyCommandOutcome(NOT_STARTED), 'not_started');
  });

  it('never treats a timed-out run as GREEN, even with exit code 0', () => {
    assert.equal(classifyCommandOutcome(commandResult({ exitCode: 0, timedOut: true })), 'timed_out');
  });
});

describe('verifyCommandResult', () => {
  it('confirms a reproduced failure only when the output matches the signal', () => {
    const result = verify(RED, 'fails', ['applies tax to the discounted amount', '200 !== 180']);
    assert.equal(result.status, 'confirmed');
    assert.equal(result.commandOutcome, 'red');
    assert.equal(result.expectation, 'fails');
    assert.equal(result.exitCode, 1);
    assert.equal(result.command, 'npm test');
    assert.match(result.summary, /RED/);
  });

  it('does not treat a non-zero exit alone as confirmation', () => {
    const unattributed = verify(RED, 'fails');
    assert.equal(unattributed.status, 'inconclusive');
    assert.equal(unattributed.commandOutcome, 'red');

    const mismatched = verify(RED, 'fails', ['some other test name']);
    assert.equal(mismatched.status, 'inconclusive');
    assert.match(mismatched.summary, /does not contain "some other test name"/);

    const truncated = verify(commandResult({ stdoutTruncated: true }), 'fails', ['missing text']);
    assert.match(truncated.summary, /output was truncated/);
  });

  it('confirms GREEN when the command is expected to pass', () => {
    const result = verify(GREEN, 'passes');
    assert.equal(result.status, 'confirmed');
    assert.equal(result.commandOutcome, 'green');
    assert.equal(result.exitCode, 0);
  });

  it('rejects the expectation when the outcome is the opposite color', () => {
    assert.equal(verify(GREEN, 'fails', ['anything']).status, 'rejected');
    assert.equal(verify(RED, 'passes').status, 'rejected');
  });

  it('never reports a timeout as GREEN or as a confirmed failure', () => {
    for (const expectation of ['fails', 'passes'] as const) {
      const result = verify(TIMED_OUT, expectation, expectation === 'fails' ? ['anything'] : undefined);
      assert.equal(result.status, 'inconclusive');
      assert.equal(result.commandOutcome, 'timed_out');
      assert.equal(result.exitCode, undefined);
    }
  });

  it('reports commands that could not start as not_run and terminations as inconclusive', () => {
    for (const expectation of ['fails', 'passes'] as const) {
      const notRun = verify(NOT_STARTED, expectation);
      assert.equal(notRun.status, 'not_run');
      assert.match(notRun.summary, /could not be started: spawn npm ENOENT/);
      assert.equal(verify(TERMINATED, expectation).status, 'inconclusive');
    }
  });

  it('references the command evidence and never claims a hypothesis', () => {
    for (const result of [RED, GREEN, TIMED_OUT, TERMINATED, NOT_STARTED]) {
      for (const expectation of ['fails', 'passes'] as const) {
        const verification = verify(result, expectation, ['200 !== 180']);
        assert.deepEqual(verification.evidenceIds, [EVIDENCE_ID]);
        assert.equal(verification.hypothesisId, undefined);
        assert.deepEqual(VerificationResultSchema.parse(JSON.parse(JSON.stringify(verification))), verification);
      }
    }
  });

  it('rejects empty expected output entries', () => {
    assert.throws(() => verify(RED, 'fails', ['']), RangeError);
  });
});

describe('command schemas and formatting', () => {
  it('accepts serializable command results and rejects incomplete ones', () => {
    assert.deepEqual(CommandExecutionResultSchema.parse(RED), RED);
    const { stdout: _stdout, ...missingStdout } = RED;
    assert.equal(CommandExecutionResultSchema.safeParse(missingStdout).success, false);
  });

  it('formats argv for display without implying shell execution', () => {
    assert.equal(formatCommandLine('npm', ['test']), 'npm test');
    assert.equal(formatCommandLine('npm', ['test', '--', 'a b']), 'npm test -- "a b"');
    assert.equal(formatCommandLine('node', ['-e', "console.log('x')"]), `node -e "console.log('x')"`);
  });
});
