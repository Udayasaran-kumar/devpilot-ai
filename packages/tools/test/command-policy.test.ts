import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  buildCommandEnvironment,
  CommandPolicy,
  DEFAULT_COMMAND_POLICY,
  FIXED_COMMAND_ENV,
  NPM_TEST_RULE,
} from '../src/index.js';

describe('CommandPolicy', () => {
  it('allows only npm test by default', () => {
    assert.deepEqual(DEFAULT_COMMAND_POLICY.allowedCommands, ['npm']);
    assert.deepEqual(DEFAULT_COMMAND_POLICY.check('npm', ['test']), { allowed: true });
    assert.deepEqual(DEFAULT_COMMAND_POLICY.check('npm', ['test', '--', '--test-name-pattern=checkout']), {
      allowed: true,
    });
  });

  const rejected: Array<[string, string, string[]]> = [
    ['unlisted executable', 'node', ['-e', '1']],
    ['shell', 'sh', ['-c', 'npm test']],
    ['bash', 'bash', ['-c', 'npm test']],
    ['absolute executable path', '/usr/bin/npm', ['test']],
    ['relative executable path', './npm', ['test']],
    ['parent-relative executable path', '../npm', ['test']],
    ['command line as a single string', 'npm test', []],
    ['metacharacters in the command name', 'npm;touch', ['x']],
    ['empty command', '', []],
    ['npm install', 'npm', ['install', 'left-pad']],
    ['npm exec', 'npm', ['exec', '--', 'touch', 'x']],
    ['npm run', 'npm', ['run', 'build']],
    ['bare npm', 'npm', []],
    ['npm option before the subcommand', 'npm', ['--prefix=/tmp', 'test']],
    ['npm option after test', 'npm', ['test', '--prefix', '/tmp']],
    ['script argument with a semicolon', 'npm', ['test', '--', '; touch pwned']],
    ['script argument with command substitution', 'npm', ['test', '--', '$(touch pwned)']],
    ['script argument with a space', 'npm', ['test', '--', 'a b']],
    ['NUL byte in an argument', 'npm', ['test', '--', 'a\0b']],
    ['too many arguments', 'npm', ['test', '--', ...Array.from({ length: 70 }, (_, i) => `a${i}`)]],
  ];

  for (const [name, command, args] of rejected) {
    it(`rejects ${name}`, () => {
      const decision = DEFAULT_COMMAND_POLICY.check(command, args);
      assert.equal(decision.allowed, false);
      assert.ok(!decision.allowed && decision.reason.length > 0);
    });
  }

  it('names the allowed commands in rejections', () => {
    const decision = DEFAULT_COMMAND_POLICY.check('curl', ['https://example.com']);
    assert.ok(!decision.allowed);
    assert.match(decision.reason, /"curl" is not allowed \(allowed: npm\)/);
  });

  it('is extensible with explicit rules and validates them', () => {
    const policy = new CommandPolicy([
      NPM_TEST_RULE,
      { command: 'node', description: 'version check', checkArgs: (args) => (args.join(' ') === '--version' ? undefined : 'only --version') },
    ]);
    assert.deepEqual(policy.check('node', ['--version']), { allowed: true });
    assert.equal(policy.check('node', ['-e', '1']).allowed, false);
    assert.throws(() => new CommandPolicy([NPM_TEST_RULE, NPM_TEST_RULE]), /Duplicate/);
    assert.throws(
      () => new CommandPolicy([{ command: '/bin/sh', description: 'x', checkArgs: () => undefined }]),
      /bare executable name/,
    );
  });
});

describe('buildCommandEnvironment', () => {
  const host = {
    PATH: ['/usr/local/bin', '', '.', 'node_modules/.bin', '/repo/bin', '/usr/bin'].join(path.delimiter),
    HOME: '/home/dev',
    LANG: 'en_US.UTF-8',
    AWS_ACCESS_KEY_ID: 'AKIA-EXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'secret',
    AWS_SESSION_TOKEN: 'token',
    AWS_PROFILE: 'prod',
    BEDROCK_MODEL_ID: 'model',
    MODEL_API_KEY: 'key',
    OPENAI_API_KEY: 'key',
    GITHUB_TOKEN: 'token',
    NPM_TOKEN: 'token',
    NODE_OPTIONS: '--require /tmp/evil.js',
    npm_config_registry: 'https://evil.example',
    DEVPILOT_FLAG: 'on',
  };

  it('copies only allowlisted variables and adds fixed ones', () => {
    const env = buildCommandEnvironment(host, { excludedPathRoots: ['/repo'] });
    assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH', ...Object.keys(FIXED_COMMAND_ENV)].sort());
    assert.equal(env.NO_COLOR, '1');
  });

  it('removes empty, relative, and repository-internal PATH entries', () => {
    const env = buildCommandEnvironment(host, { excludedPathRoots: ['/repo'] });
    assert.equal(env.PATH, ['/usr/local/bin', '/usr/bin'].join(path.delimiter));
  });

  it('drops secret-looking names even when explicitly passed through', () => {
    const env = buildCommandEnvironment(host, {
      passthrough: ['PATH', 'AWS_PROFILE', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'NPM_TOKEN', 'MODEL_API_KEY', 'DEVPILOT_FLAG'],
    });
    assert.equal(env.DEVPILOT_FLAG, 'on');
    for (const secret of ['AWS_PROFILE', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'NPM_TOKEN', 'MODEL_API_KEY']) {
      assert.equal(env[secret], undefined, secret);
    }
  });
});
