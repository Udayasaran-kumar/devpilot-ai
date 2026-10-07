import { randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HostEnvironment } from './command-environment.js';
import { resolveGitExecutable, runGit, WorkspaceError, type GitExecutable } from './git.js';
import { RepositorySandbox, SandboxError, type RepositorySandboxOptions } from './sandbox.js';

/** Directory inside the target repository that holds DevPilot state. */
export const WORKSPACE_DIRECTORY_NAME = '.devpilot';
export const WORKTREES_DIRECTORY_NAME = 'worktrees';
/** A single path segment: no separators, dots, or traversal. */
export const WORKSPACE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface GitWorktreeWorkspaceOptions {
  /** The repository must be inside this directory (after symlinks). Defaults to the repository root itself. */
  readonly allowedRoot?: string;
  /** Directory name under `.devpilot/worktrees`; a unique one is generated when omitted. */
  readonly name?: string;
  /** Resolved with `resolveGitExecutable` when omitted. */
  readonly git?: GitExecutable;
  readonly sandboxOptions?: RepositorySandboxOptions;
  readonly hostEnvironment?: HostEnvironment;
}

export interface WorkspaceStatus {
  readonly clean: boolean;
  /** Paths relative to the workspace root with uncommitted changes, untracked files included. */
  readonly changedPaths: readonly string[];
}

interface WorkspaceFields {
  readonly name: string;
  readonly repositoryRoot: string;
  readonly baseCommit: string;
  readonly root: string;
  readonly worktreesDirectory: string;
  readonly sandbox: RepositorySandbox;
  readonly git: GitExecutable;
  readonly host: HostEnvironment;
}

type DirectoryState = 'owned' | 'missing' | 'replaced';

/**
 * A detached git worktree of a repository's HEAD at
 * `<repository>/.devpilot/worktrees/<name>`, for changing files without
 * touching the original working tree. Lifecycle: `create` -> use `getRoot` /
 * `getSandbox` -> `remove`. After `remove` the workspace cannot be used again.
 */
export class GitWorktreeWorkspace {
  readonly name: string;
  /** Canonical root of the repository the worktree was created from. */
  readonly repositoryRoot: string;
  /** Commit checked out (detached) in the worktree. */
  readonly baseCommit: string;
  readonly #root: string;
  readonly #worktreesDirectory: string;
  readonly #sandbox: RepositorySandbox;
  readonly #git: GitExecutable;
  readonly #host: HostEnvironment;
  #removal: Promise<void> | undefined;
  #removed = false;

  private constructor(fields: WorkspaceFields) {
    this.name = fields.name;
    this.repositoryRoot = fields.repositoryRoot;
    this.baseCommit = fields.baseCommit;
    this.#root = fields.root;
    this.#worktreesDirectory = fields.worktreesDirectory;
    this.#sandbox = fields.sandbox;
    this.#git = fields.git;
    this.#host = fields.host;
  }

  static async create(repositoryRoot: string, options: GitWorktreeWorkspaceOptions = {}): Promise<GitWorktreeWorkspace> {
    const name = options.name ?? generateWorkspaceName();
    if (!WORKSPACE_NAME_PATTERN.test(name)) {
      throw new WorkspaceError('invalid_name', `Workspace name must match ${WORKSPACE_NAME_PATTERN}: ${JSON.stringify(name)}`);
    }
    const host = options.hostEnvironment ?? process.env;
    const repository = await resolveRepositoryRoot(repositoryRoot, options.allowedRoot ?? repositoryRoot);
    const git = options.git ?? (await resolveGitExecutable({ hostEnvironment: host }));
    const baseCommit = await verifyRepository(git, repository, repositoryRoot, host);
    const worktreesDirectory = await ensureWorktreesDirectory(repository);

    const root = path.join(worktreesDirectory, name);
    try {
      // Claims the name atomically; git accepts an existing empty directory.
      await mkdir(root);
    } catch (error) {
      if (hasErrorCode(error, 'EEXIST')) {
        throw new WorkspaceError('destination_exists', `Workspace directory already exists: ${name}`);
      }
      throw error;
    }

    try {
      await runGit(git, ['worktree', 'add', '--detach', '--', root, baseCommit], repository, host);
      const sandbox = await RepositorySandbox.create(root, options.sandboxOptions);
      return new GitWorktreeWorkspace({ name, repositoryRoot: repository, baseCommit, root, worktreesDirectory, sandbox, git, host });
    } catch (error) {
      await discardFailedWorktree(git, repository, worktreesDirectory, root, host);
      throw error;
    }
  }

  get removed(): boolean {
    return this.#removed;
  }

  /** Canonical absolute path of the worktree. */
  getRoot(): string {
    this.#assertActive();
    return this.#root;
  }

  /** Sandbox rooted at the worktree; repository tools built on it never see the original working tree. */
  getSandbox(): RepositorySandbox {
    this.#assertActive();
    return this.#sandbox;
  }

  async status(): Promise<WorkspaceStatus> {
    const { stdout } = await runGit(
      this.#git,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      this.getRoot(),
      this.#host,
    );
    const changedPaths: string[] = [];
    let skipRenameSource = false;
    for (const record of stdout.split('\0')) {
      if (skipRenameSource || record === '') {
        skipRenameSource = false;
        continue;
      }
      changedPaths.push(record.slice(3));
      skipRenameSource = record[0] === 'R' || record[0] === 'C';
    }
    changedPaths.sort();
    return { clean: changedPaths.length === 0, changedPaths };
  }

  /**
   * Removes the worktree with `git worktree remove --force`, discarding any
   * changes made in it. Only ever touches the directory this instance created,
   * and only while git still lists it as a worktree of the repository.
   * Repeated and concurrent calls share one removal; a failed removal can be retried.
   */
  remove(): Promise<void> {
    this.#removal ??= this.#remove().catch((error: unknown) => {
      this.#removal = undefined;
      throw error;
    });
    return this.#removal;
  }

  async #remove(): Promise<void> {
    const state = await inspectWorkspaceDirectory(this.#root, this.#worktreesDirectory);
    if (state === 'missing') {
      this.#removed = true;
      return;
    }
    if (state === 'replaced') {
      throw new WorkspaceError(
        'not_owned',
        `Workspace directory ${this.name} is no longer the directory this workspace created; refusing to delete it`,
      );
    }
    if (!(await this.#isRegisteredWorktree())) {
      throw new WorkspaceError(
        'not_owned',
        `Workspace directory ${this.name} is not a registered worktree of the repository; refusing to delete it`,
      );
    }
    try {
      await runGit(this.#git, ['worktree', 'remove', '--force', '--', this.#root], this.repositoryRoot, this.#host);
    } catch (error) {
      throw new WorkspaceError('remove_failed', `Could not remove workspace ${this.name}: ${errorMessage(error)}`);
    }
    if ((await inspectWorkspaceDirectory(this.#root, this.#worktreesDirectory)) === 'owned') {
      await rm(this.#root, { recursive: true, force: true });
    }
    this.#removed = true;
  }

  async #isRegisteredWorktree(): Promise<boolean> {
    const { stdout } = await runGit(this.#git, ['worktree', 'list', '--porcelain'], this.repositoryRoot, this.#host);
    return stdout.split('\n').some((line) => line === `worktree ${this.#root}`);
  }

  #assertActive(): void {
    if (this.#removed) {
      throw new WorkspaceError('workspace_removed', `Workspace ${this.name} has been removed`);
    }
  }
}

/** Canonical repository root, required to be inside the allowed root using the sandbox's own containment rules. */
async function resolveRepositoryRoot(requested: string, allowedRoot: string): Promise<string> {
  let allowed: RepositorySandbox;
  try {
    allowed = await RepositorySandbox.create(allowedRoot);
  } catch (error) {
    if (error instanceof SandboxError) {
      throw new WorkspaceError('invalid_repository', `Allowed root is not an existing directory: ${allowedRoot}`);
    }
    throw error;
  }
  try {
    const resolved = await allowed.resolveSafePath(path.resolve(requested));
    if (resolved.type === 'directory') {
      return resolved.absolutePath;
    }
  } catch (error) {
    if (!(error instanceof SandboxError)) {
      throw error;
    }
    if (error.code === 'outside_root') {
      throw new WorkspaceError('outside_allowed_root', `Repository is outside the allowed root: ${requested}`);
    }
  }
  throw new WorkspaceError('invalid_repository', `Repository root is not an existing directory: ${requested}`);
}

/** Returns the commit to check out. The root must be the top level of a non-bare working tree with a commit. */
async function verifyRepository(
  git: GitExecutable,
  repository: string,
  requested: string,
  host: HostEnvironment,
): Promise<string> {
  let topLevel = '';
  try {
    topLevel = (await runGit(git, ['rev-parse', '--show-toplevel'], repository, host)).stdout.trim();
  } catch {
    // Reported below.
  }
  if (topLevel === '' || (await realpathOrUndefined(topLevel)) !== repository) {
    throw new WorkspaceError('invalid_repository', `Not the top level of a git working tree: ${requested}`);
  }

  let commit = '';
  try {
    commit = (await runGit(git, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], repository, host)).stdout.trim();
  } catch {
    // Reported below.
  }
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) {
    throw new WorkspaceError('invalid_repository', `Repository has no commit to check out: ${requested}`);
  }
  return commit;
}

/** Creates `.devpilot/worktrees` as real directories, refusing symlinks or files at either level. */
async function ensureWorktreesDirectory(repository: string): Promise<string> {
  const workspaceDirectory = path.join(repository, WORKSPACE_DIRECTORY_NAME);
  const worktreesDirectory = path.join(workspaceDirectory, WORKTREES_DIRECTORY_NAME);
  for (const directory of [workspaceDirectory, worktreesDirectory]) {
    try {
      await mkdir(directory);
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw error;
    }
    const stats = await lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new WorkspaceError(
        'unsafe_destination',
        `${path.relative(repository, directory)} must be a real directory, not a symlink or file`,
      );
    }
  }
  if ((await realpath(worktreesDirectory)) !== worktreesDirectory) {
    throw new WorkspaceError('unsafe_destination', `${WORKSPACE_DIRECTORY_NAME}/${WORKTREES_DIRECTORY_NAME} resolves elsewhere`);
  }
  // Ignores itself and everything beside it, so the original repository's status
  // stays clean without editing its tracked .gitignore. Never overwrites a file.
  try {
    await writeFile(path.join(workspaceDirectory, '.gitignore'), '*\n', { flag: 'wx' });
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) throw error;
  }
  return worktreesDirectory;
}

/** Undoes a failed `create`. `root` was created by that call, so deleting it never touches foreign data. */
async function discardFailedWorktree(
  git: GitExecutable,
  repository: string,
  worktreesDirectory: string,
  root: string,
  host: HostEnvironment,
): Promise<void> {
  try {
    await runGit(git, ['worktree', 'remove', '--force', '--', root], repository, host);
  } catch {
    // Usually not registered: git cleans up its own metadata when `worktree add` fails.
  }
  if ((await inspectWorkspaceDirectory(root, worktreesDirectory)) === 'owned') {
    await rm(root, { recursive: true, force: true });
  }
}

/** `owned` only if `root` is still a real directory directly under the controlled worktrees directory. */
async function inspectWorkspaceDirectory(root: string, worktreesDirectory: string): Promise<DirectoryState> {
  let stats;
  try {
    stats = await lstat(root);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return 'missing';
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory() || path.dirname(root) !== worktreesDirectory) {
    return 'replaced';
  }
  return (await realpathOrUndefined(root)) === root ? 'owned' : 'replaced';
}

function generateWorkspaceName(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

async function realpathOrUndefined(target: string): Promise<string | undefined> {
  try {
    return await realpath(target);
  } catch {
    return undefined;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
