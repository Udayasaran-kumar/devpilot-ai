import assert from 'node:assert/strict';
import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { formatCommandLine, verifyCommandResult } from '@devpilot/core';
import {
  createRunCommandTool,
  MAX_COMMAND_OUTPUT_BYTES,
  RepositorySandbox,
  RUN_COMMAND_TOOL_NAME,
  SandboxError,
  CommandPolicy,
  type RunCommandInput,
  type RunCommandOutput,
  type Tool,
} from '../src/index.js';
import {
  createSandboxFixture,
  expectError,
  expectSuccess,
  NOW,
  runTool,
  TEST_COMMAND_POLICY,
  toolContext,
  type SandboxFixture,
} from './support/sandbox-fixture.js';

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isAlive(pid);
}

const node = (code: string, ...rest: string[]): RunCommandInput => ({ command: 'node', args: ['-e', code, ...rest] });

describe('run_command', () => {
  let fixture: SandboxFixture;
  /** Default policy: npm test only. */
  let npmOnly: Tool<RunCommandInput, RunCommandOutput>;
  /** Test policy that additionally allows `node`, for fast process-control tests. */
  let withNode: Tool<RunCommandInput, RunCommandOutput>;
  let marker: string;

  before(async () => {
    fixture = await createSandboxFixture({ commandPolicy: TEST_COMMAND_POLICY });
    withNode = createRunCommandTool(fixture.sandbox);
    npmOnly = createRunCommandTool(await RepositorySandbox.create(fixture.root));
    marker = path.join(fixture.outside, 'executed.marker');
  });
  after(async () => {
    await fixture.cleanup();
  });

  describe('command security', () => {
    it('executes an allowed command', async () => {
      const npm = expectSuccess(await runTool(npmOnly, { command: 'npm', args: ['test'] })).output;
      assert.equal(npm.exitCode, 1);
      assert.equal(npm.cwd, '.');
      assert.equal(npm.timedOut, false);
      assert.match(npm.stdout, /not ok 2 - applies tax to the discounted amount/);

      const echo = expectSuccess(await runTool(withNode, node("console.log('hello')"))).output;
      assert.equal(echo.exitCode, 0);
      assert.equal(echo.stdout, 'hello\n');
    });

    it('rejects disallowed commands without executing them', async () => {
      const writeMarker = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`;
      const attempts: RunCommandInput[] = [
        node(writeMarker),
        { command: 'touch', args: [marker] },
        { command: 'sh', args: ['-c', `touch ${marker}`] },
        { command: 'bash', args: ['-c', `touch ${marker}`] },
        { command: '/usr/bin/touch', args: [marker] },
        { command: '/usr/bin/env', args: ['touch', marker] },
        { command: `npm test; touch ${marker}`, args: [] },
        { command: 'npm', args: ['exec', '--', 'touch', marker] },
        { command: 'npm', args: ['install'] },
        { command: 'npm', args: ['test', '--prefix', fixture.outside] },
        { command: 'npm', args: ['test', '--', `; touch ${marker}`] },
      ];
      for (const attempt of attempts) {
        expectError(await runTool(npmOnly, attempt), /is not allowed|Only "npm test" is allowed|npm options|shell/);
      }
      assert.equal(await exists(marker), false);
      await assert.rejects(
        RepositorySandbox.create(fixture.root).then((sandbox) => sandbox.runCommand({ command: 'touch', args: [marker] })),
        (error: unknown) => error instanceof SandboxError && error.code === 'command_not_allowed',
      );
      assert.equal(await exists(marker), false);
    });

    it('passes shell metacharacters through literally', async () => {
      const args = ['; touch pwned', '$(touch pwned)', '`touch pwned`', '&& touch pwned', '| cat', '> out.txt', '*', '$HOME'];
      const { output } = expectSuccess(
        await runTool(withNode, node('console.log(JSON.stringify(process.argv.slice(1)))', ...args)),
      );
      assert.deepEqual(JSON.parse(output.stdout), args);
      assert.equal(await exists(path.join(fixture.root, 'pwned')), false);
      assert.equal(await exists(path.join(fixture.root, 'out.txt')), false);
    });

    it('rejects working directories outside the root', async () => {
      for (const cwd of ['..', '../outside', '../../etc', '/etc', fixture.outside, fixture.prefixSibling]) {
        expectError(await runTool(withNode, { ...node(`require('node:fs').writeFileSync('x', 'x')`), cwd }), /outside the repository root/);
      }
      assert.equal(await exists(path.join(fixture.outside, 'x')), false);
    });

    it('rejects working directories that escape through a symlink', async () => {
      expectError(await runTool(withNode, { ...node('1'), cwd: 'src/outside-dir' }), /outside the repository root/);
    });

    it('rejects files and missing paths as working directories', async () => {
      expectError(await runTool(withNode, { ...node('1'), cwd: 'package.json' }), /not a directory/);
      expectError(await runTool(withNode, { ...node('1'), cwd: 'src/missing' }), /does not exist/);
    });

    it('runs in a safely resolved subdirectory and redacts the root from output', async () => {
      const { output } = expectSuccess(await runTool(withNode, { ...node('console.log(process.cwd())'), cwd: 'src' }));
      assert.equal(output.cwd, 'src');
      assert.equal(output.stdout, '<repo>/src\n');
      assert.ok(!output.stdout.includes(fixture.sandbox.root));
    });

    it('does not run executables planted in the repository via PATH', async () => {
      const planted = `#!/bin/sh\necho planted > "$0.ran"\n`;
      await mkdir(path.join(fixture.root, 'bin'), { recursive: true });
      for (const fake of [path.join(fixture.root, 'npm'), path.join(fixture.root, 'bin', 'npm')]) {
        await writeFile(fake, planted);
        await chmod(fake, 0o755);
      }
      const sandbox = await RepositorySandbox.create(fixture.root, {
        hostEnvironment: {
          ...process.env,
          PATH: ['.', path.join(fixture.root, 'bin'), process.env.PATH ?? ''].join(path.delimiter),
        },
      });
      const { output } = expectSuccess(await runTool(createRunCommandTool(sandbox), { command: 'npm', args: ['test'] }));
      assert.match(output.stdout, /TAP version 13/);
      assert.equal(await exists(path.join(fixture.root, 'npm.ran')), false);
      assert.equal(await exists(path.join(fixture.root, 'bin', 'npm.ran')), false);
    });
  });

  describe('environment', () => {
    it('does not expose host secrets or NODE_OPTIONS to the child', async () => {
      const sandbox = await RepositorySandbox.create(fixture.root, {
        commandPolicy: TEST_COMMAND_POLICY,
        hostEnvironment: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          AWS_ACCESS_KEY_ID: 'AKIA-LEAK',
          AWS_SECRET_ACCESS_KEY: 'leak-secret',
          AWS_SESSION_TOKEN: 'leak-token',
          AWS_PROFILE: 'leak-profile',
          BEDROCK_MODEL_ID: 'leak-model',
          MODEL_API_KEY: 'leak-key',
          OPENAI_API_KEY: 'leak-key',
          NODE_OPTIONS: '--require /nonexistent/devpilot-evil.js',
        },
      });
      const { output } = expectSuccess(
        await runTool(createRunCommandTool(sandbox), node('console.log(Object.keys(process.env).sort().join(","))')),
      );
      const keys = output.stdout.trim().split(',');
      assert.ok(keys.includes('PATH'));
      assert.ok(keys.includes('NO_COLOR'));
      for (const secret of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'BEDROCK_MODEL_ID', 'MODEL_API_KEY', 'OPENAI_API_KEY', 'NODE_OPTIONS']) {
        assert.ok(!keys.includes(secret), secret);
      }
      assert.ok(!output.stdout.includes('leak'));
    });
  });

  describe('process control', () => {
    it('enforces the timeout', async () => {
      const { output } = expectSuccess(await runTool(withNode, { ...node('setInterval(() => {}, 1000)'), timeoutMs: 300 }));
      assert.equal(output.timedOut, true);
      assert.equal(output.exitCode, null);
      assert.equal(output.signal, 'SIGKILL');
      assert.ok(output.durationMs < 5000, `took ${output.durationMs}ms`);
    });

    it('terminates the whole process tree after a timeout', async () => {
      const spawnGrandchild = [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        'console.log(child.pid);',
        'setInterval(() => {}, 1000);',
      ].join('\n');
      const { output } = expectSuccess(await runTool(withNode, { ...node(spawnGrandchild), timeoutMs: 500 }));
      assert.equal(output.timedOut, true);
      const grandchild = Number(output.stdout.trim());
      assert.ok(Number.isInteger(grandchild) && grandchild > 0, output.stdout);
      assert.equal(await waitUntilDead(grandchild), true, `grandchild ${grandchild} survived the timeout`);
    });

    it('rejects out-of-range timeouts at the boundary and clamps them in the sandbox', async () => {
      for (const timeoutMs of [0, -1, 1.5, 30_001]) {
        assert.equal(withNode.inputSchema.safeParse({ ...node('1'), timeoutMs }).success, false, String(timeoutMs));
      }
      await assert.rejects(
        fixture.sandbox.runCommand({ ...node('1'), timeoutMs: 0 }),
        (error: unknown) => error instanceof SandboxError && error.code === 'invalid_argument',
      );
      const clamped = await fixture.sandbox.runCommand({ ...node('1'), timeoutMs: 10_000_000 });
      assert.equal(clamped.exitCode, 0);
    });

    it('captures stdout', async () => {
      const { output } = expectSuccess(await runTool(withNode, node("process.stdout.write('out-line\\n')")));
      assert.equal(output.stdout, 'out-line\n');
      assert.equal(output.stderr, '');
      assert.equal(output.exitCode, 0);
    });

    it('captures stderr and non-zero exit codes', async () => {
      const { output } = expectSuccess(
        await runTool(withNode, node("process.stderr.write('err-line\\n'); process.exitCode = 3")),
      );
      assert.equal(output.stderr, 'err-line\n');
      assert.equal(output.stdout, '');
      assert.equal(output.exitCode, 3);
    });

    it('truncates stdout at the per-stream limit', async () => {
      const { output } = expectSuccess(await runTool(withNode, node("process.stdout.write('x'.repeat(200000))")));
      assert.equal(output.stdout.length, MAX_COMMAND_OUTPUT_BYTES);
      assert.equal(output.stdoutTruncated, true);
      assert.equal(output.stderrTruncated, false);
      assert.equal(output.exitCode, 0);
    });

    it('truncates stderr at the per-stream limit', async () => {
      const { output } = expectSuccess(await runTool(withNode, node("process.stderr.write('y'.repeat(200000))")));
      assert.equal(output.stderr.length, MAX_COMMAND_OUTPUT_BYTES);
      assert.equal(output.stderrTruncated, true);
      assert.equal(output.stdoutTruncated, false);
    });

    it('does not mark output that exactly fits the limit as truncated', async () => {
      const { output } = expectSuccess(
        await runTool(withNode, node(`process.stdout.write('z'.repeat(${MAX_COMMAND_OUTPUT_BYTES}))`)),
      );
      assert.equal(output.stdout.length, MAX_COMMAND_OUTPUT_BYTES);
      assert.equal(output.stdoutTruncated, false);
    });

    it('reports commands that cannot be started as data, not as a crash', async () => {
      const sandbox = await RepositorySandbox.create(fixture.root, {
        commandPolicy: new CommandPolicy([
          { command: 'devpilot-no-such-binary', description: 'missing', checkArgs: () => undefined },
        ]),
      });
      const { output, evidence } = expectSuccess(
        await runTool(createRunCommandTool(sandbox), { command: 'devpilot-no-such-binary', args: [] }),
      );
      assert.match(output.startError ?? '', /ENOENT/);
      assert.equal(output.exitCode, null);
      assert.match(evidence[0]?.summary ?? '', /could not be started/);
    });
  });

  describe('evidence', () => {
    it('gives identical command observations the same evidence ID', async () => {
      const input = node("console.log('same')");
      const first = expectSuccess(await runTool(withNode, input, toolContext('action-1', NOW)));
      const second = expectSuccess(await runTool(withNode, input, toolContext('action-2', '2026-05-05T00:00:00.000Z')));
      assert.deepEqual(first.output.evidenceIds, second.output.evidenceIds);
    });

    it('gives different command results different evidence IDs', async () => {
      const ids = new Set<string>();
      for (const input of [
        node("console.log('a')"),
        node("console.log('b')"),
        node("console.log('a'); process.exitCode = 1"),
        { ...node("console.log('a')"), cwd: 'src' },
      ]) {
        const { output } = expectSuccess(await runTool(withNode, input));
        ids.add(output.evidenceIds[0] ?? '');
      }
      assert.equal(ids.size, 4);
    });

    it('records the command location and the observable output', async () => {
      const input = node("console.log('visible'); console.error('warned'); process.exitCode = 2");
      const { output, evidence } = expectSuccess(await runTool(withNode, input, toolContext('action-5')));
      assert.equal(evidence.length, 1);
      const [item] = evidence;
      assert.ok(item);
      assert.deepEqual(output.evidenceIds, [item.id]);
      assert.equal(item.kind, 'command_output');
      assert.deepEqual(item.location, { type: 'command', command: formatCommandLine('node', input.args), exitCode: 2 });
      assert.deepEqual(item.source, { tool: RUN_COMMAND_TOOL_NAME, actionId: 'action-5' });
      assert.match(item.content ?? '', /^\$ node -e /);
      assert.match(item.content ?? '', /cwd: \./);
      assert.match(item.content ?? '', /exit code: 2/);
      assert.match(item.content ?? '', /--- stdout ---\nvisible\n/);
      assert.match(item.content ?? '', /--- stderr ---\nwarned\n/);
      assert.equal(item.summary, `"${formatCommandLine('node', input.args)}" exited with code 2`);
    });

    it('omits the exit code from the location of a timed-out command and never verifies it as GREEN', async () => {
      const { output, evidence } = expectSuccess(
        await runTool(withNode, { ...node('setInterval(() => {}, 1000)'), timeoutMs: 200 }),
      );
      const [item] = evidence;
      assert.ok(item);
      assert.deepEqual(item.location, { type: 'command', command: formatCommandLine('node', ['-e', 'setInterval(() => {}, 1000)']) });
      assert.match(item.content ?? '', /timed out: true/);

      const verification = verifyCommandResult({ id: 'ver-timeout', result: output, evidenceId: item.id, expectation: 'passes' });
      assert.equal(verification.status, 'inconclusive');
      assert.equal(verification.commandOutcome, 'timed_out');
    });
  });
});
