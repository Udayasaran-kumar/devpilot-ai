import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildCommandEnvironment, type HostEnvironment } from './command-environment.js';
import { runProcess, type ProcessOutcome } from './process-runner.js';

export type WorkspaceErrorCode =
  | 'git_unavailable'
  | 'invalid_repository'
  | 'outside_allowed_root'
  | 'invalid_name'
  | 'unsafe_destination'
  | 'destination_exists'
  | 'git_failed'
  | 'workspace_removed'
  | 'not_owned'
  | 'remove_failed';

/** Expected failure of git resolution or a workspace lifecycle step. */
export class WorkspaceError extends Error {
  override readonly name = 'WorkspaceError';
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface GitExecutable {
  /** Absolute path of a git binary that answered `git --version`. */
  readonly path: string;
  readonly version: string;
}

export interface ResolveGitOptions {
  /** Absolute path to use instead of searching PATH; it must still pass the probe. */
  readonly executable?: string;
  /** Source of PATH and of the environment git runs with. Defaults to `process.env`. */
  readonly hostEnvironment?: HostEnvironment;
}

const PROBE_TIMEOUT_MS = 5000;
const GIT_TIMEOUT_MS = 60_000;
const GIT_OUTPUT_BYTES = 256 * 1024;
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const GIT_BINARY_NAMES = process.platform === 'win32' ? ['git.exe'] : ['git'];

/**
 * Prepended to every invocation so repository or user configuration cannot run
 * programs as a side effect: `git worktree add` runs the post-checkout hook,
 * and `core.fsmonitor` names a command git executes.
 */
const SAFE_GIT_CONFIG: readonly string[] = ['-c', `core.hooksPath=${NULL_DEVICE}`, '-c', 'core.fsmonitor=false'];

/**
 * Finds a working git: every PATH entry is probed with `git --version` in
 * order and the first one that succeeds wins. Probing matters on macOS, where
 * `/usr/bin/git` is an Xcode shim that exits non-zero until the Xcode license is
 * accepted, and usually precedes Homebrew's git on PATH.
 */
export async function resolveGitExecutable(options: ResolveGitOptions = {}): Promise<GitExecutable> {
  const host = options.hostEnvironment ?? process.env;
  const candidates = options.executable !== undefined ? [options.executable] : gitCandidates(host.PATH ?? '');
  const failures: string[] = [];

  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) {
      failures.push(`${candidate}: not an absolute path`);
      continue;
    }
    try {
      await access(candidate, constants.X_OK);
    } catch {
      if (options.executable !== undefined) failures.push(`${candidate}: not an executable file`);
      continue;
    }
    const outcome = await runProcess({
      command: candidate,
      args: ['--version'],
      cwd: tmpdir(),
      env: gitEnvironment(host),
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: 4096,
    });
    const version = outcome.stdout.trim();
    if (outcome.exitCode === 0 && version.startsWith('git version ')) {
      return { path: candidate, version };
    }
    failures.push(`${candidate}: ${describeFailure(outcome)}`);
  }

  const detail = failures.length > 0 ? ` (${failures.join('; ')})` : '';
  throw new WorkspaceError('git_unavailable', `No working git executable found on PATH${detail}`);
}

export interface GitOutput {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs git with internally constructed arguments only. Never pass arguments
 * that came from a model or another untrusted source.
 */
export async function runGit(
  git: GitExecutable,
  args: readonly string[],
  cwd: string,
  host: HostEnvironment = process.env,
): Promise<GitOutput> {
  const outcome = await runProcess({
    command: git.path,
    args: [...SAFE_GIT_CONFIG, ...args],
    cwd,
    env: gitEnvironment(host),
    timeoutMs: GIT_TIMEOUT_MS,
    maxOutputBytes: GIT_OUTPUT_BYTES,
  });
  if (outcome.exitCode !== 0 || outcome.timedOut || outcome.startError !== null) {
    throw new WorkspaceError('git_failed', `git ${args.slice(0, 2).join(' ')} ${describeFailure(outcome)}`);
  }
  return { stdout: outcome.stdout, stderr: outcome.stderr };
}

/** Filtered environment (no GIT_DIR and friends, no secrets) that never prompts for credentials. */
function gitEnvironment(host: HostEnvironment): Record<string, string> {
  return { ...buildCommandEnvironment(host), GIT_TERMINAL_PROMPT: '0' };
}

function gitCandidates(pathValue: string): string[] {
  const directories = [...new Set(pathValue.split(path.delimiter).filter((entry) => path.isAbsolute(entry)))];
  return directories.flatMap((directory) => GIT_BINARY_NAMES.map((name) => path.join(directory, name)));
}

function describeFailure(outcome: ProcessOutcome): string {
  if (outcome.startError !== null) return `failed to start: ${outcome.startError}`;
  if (outcome.timedOut) return 'timed out';
  const lines = outcome.stderr.trim().split('\n');
  const message = lines.find((line) => /^(fatal|error):/.test(line)) ?? lines.at(-1) ?? '';
  const status = outcome.exitCode === null ? `was killed by ${outcome.signal ?? 'a signal'}` : `exited with code ${outcome.exitCode}`;
  return message === '' ? status : `${status}: ${message}`;
}
