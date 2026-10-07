import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceError, type GitExecutable, type WorkspaceErrorCode } from '../../src/index.js';
import { FIXTURE_ROOT } from './sandbox-fixture.js';

export interface GitRepositoryFixture {
  readonly base: string;
  /** Directory the repository must stay inside. */
  readonly allowedRoot: string;
  /** Repository as created (may be a non-canonical alias such as /var vs /private/var). */
  readonly root: string;
  /** Canonical repository root. */
  readonly canonicalRoot: string;
  /** Directory outside the allowed root that escapes point at. */
  readonly outside: string;
  cleanup(): Promise<void>;
}

/** Host environment without GIT_* variables, so a test run inside a git hook cannot redirect commands. */
const GIT_TEST_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
) as Record<string, string>;

/** Runs the real git for test setup and assertions, isolated from user hooks and signing config. */
export function git(executable: GitExecutable, cwd: string, ...args: string[]): string {
  return execFileSync(
    executable.path,
    [
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'commit.gpgsign=false',
      '-c', 'user.name=DevPilot Test',
      '-c', 'user.email=test@devpilot.invalid',
      ...args,
    ],
    { cwd, encoding: 'utf8', env: { ...GIT_TEST_ENV, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

/** `allowed/repo`: a copy of the sample repository committed on `main`, plus an empty `outside` directory. */
export async function createGitRepositoryFixture(executable: GitExecutable): Promise<GitRepositoryFixture> {
  const base = await mkdtemp(path.join(tmpdir(), 'devpilot-worktree-'));
  const allowedRoot = path.join(base, 'allowed');
  const root = path.join(allowedRoot, 'repo');
  const outside = path.join(base, 'outside');
  await mkdir(allowedRoot);
  await mkdir(outside);
  await cp(FIXTURE_ROOT, root, { recursive: true });
  git(executable, root, 'init', '-q', '-b', 'main');
  git(executable, root, 'add', '-A');
  git(executable, root, 'commit', '-q', '-m', 'Initial commit');
  return {
    base,
    allowedRoot,
    root,
    canonicalRoot: await realpath(root),
    outside,
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

export interface RepositorySnapshot {
  readonly head: string;
  readonly branches: string;
  readonly status: string;
  /** sha256 of every file outside `.git` and `.devpilot`, keyed by relative path. */
  readonly files: Readonly<Record<string, string>>;
}

export async function snapshotRepository(executable: GitExecutable, root: string): Promise<RepositorySnapshot> {
  const files: Record<string, string> = {};
  const entries = (await readdir(root, { recursive: true })).sort();
  for (const entry of entries) {
    const [first] = entry.split(path.sep);
    if (first === '.git' || first === '.devpilot') continue;
    const absolute = path.join(root, entry);
    if ((await lstat(absolute)).isFile()) {
      files[entry] = createHash('sha256').update(await readFile(absolute)).digest('hex');
    }
  }
  return {
    head: git(executable, root, 'rev-parse', 'HEAD').trim(),
    branches: git(executable, root, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'),
    status: git(executable, root, 'status', '--porcelain=v1', '--untracked-files=all'),
    files,
  };
}

/** Absolute worktree paths git has registered for the repository. */
export function listWorktrees(executable: GitExecutable, root: string): string[] {
  return git(executable, root, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

export async function writeExecutable(file: string, content: string): Promise<void> {
  await writeFile(file, content);
  await chmod(file, 0o755);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export async function rejectsWithCode(promise: Promise<unknown>, code: WorkspaceErrorCode): Promise<WorkspaceError> {
  let caught: unknown;
  await assert.rejects(promise, (error: unknown) => {
    caught = error;
    return true;
  });
  assert.ok(caught instanceof WorkspaceError, `expected WorkspaceError, got ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  return caught;
}
