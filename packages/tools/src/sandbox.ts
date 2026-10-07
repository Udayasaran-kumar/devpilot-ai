import { constants, type Dirent } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CommandExecutionResult } from '@devpilot/core';
import { buildCommandEnvironment, type HostEnvironment } from './command-environment.js';
import { DEFAULT_COMMAND_POLICY, type CommandPolicy } from './command-policy.js';
import { isWithin } from './paths.js';
import { runProcess } from './process-runner.js';
import { splitLines } from './text.js';

export type SandboxErrorCode =
  | 'invalid_path'
  | 'invalid_argument'
  | 'command_not_allowed'
  | 'outside_root'
  | 'not_found'
  | 'not_a_file'
  | 'not_a_directory'
  | 'file_too_large'
  | 'not_text';

/** Expected, caller-facing failure. Messages only ever echo the caller's own path, never resolved host paths. */
export class SandboxError extends Error {
  override readonly name = 'SandboxError';
  readonly code: SandboxErrorCode;

  constructor(code: SandboxErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type RepositoryEntryType = 'file' | 'directory' | 'symlink';

export interface RepositoryEntry {
  /** POSIX-style path relative to the repository root. */
  readonly path: string;
  readonly type: RepositoryEntryType;
}

export interface ResolvedRepositoryPath {
  readonly absolutePath: string;
  /** Canonical POSIX-style path relative to the repository root; `.` for the root itself. */
  readonly relativePath: string;
  readonly type: 'file' | 'directory';
}

export interface RepositoryFile {
  readonly path: string;
  readonly content: string;
  readonly sizeBytes: number;
}

export interface SearchMatch {
  readonly path: string;
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column of the first occurrence on the line. */
  readonly column: number;
  readonly text: string;
}

export interface SearchOptions {
  readonly path?: string;
  readonly maxResults?: number;
}

export interface SearchResult {
  readonly scope: string;
  readonly matches: SearchMatch[];
  readonly truncated: boolean;
  readonly filesSearched: number;
  /** Files skipped because they are binary, not valid UTF-8, or over the size limit. */
  readonly filesSkipped: number;
}

export interface ListOptions {
  readonly path?: string;
  readonly maxResults?: number;
}

export interface ListResult {
  readonly scope: string;
  readonly entries: RepositoryEntry[];
  readonly truncated: boolean;
}

export interface CommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  /** Working directory relative to the repository root (or absolute inside it). Defaults to the root. */
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export interface RepositorySandboxOptions {
  readonly maxFileBytes?: number;
  /**
   * Entry names skipped while walking, whatever their type (a linked worktree's
   * `.git` is a file). Explicitly requested paths are still allowed.
   */
  readonly ignoredDirectoryNames?: readonly string[];
  readonly commandPolicy?: CommandPolicy;
  /** Source of passthrough variables for commands. Defaults to `process.env`. */
  readonly hostEnvironment?: HostEnvironment;
  /** Overrides the default passthrough variable names; secret-looking names are still dropped. */
  readonly envPassthrough?: readonly string[];
}

export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
/** `.devpilot` holds DevPilot's own worktrees, which would otherwise duplicate every search result. */
export const DEFAULT_IGNORED_DIRECTORY_NAMES: readonly string[] = ['.git', '.devpilot', 'node_modules'];
export const DEFAULT_SEARCH_RESULTS = 50;
export const MAX_SEARCH_RESULTS = 500;
export const DEFAULT_LIST_RESULTS = 200;
export const MAX_LIST_RESULTS = 2000;
export const MAX_MATCH_LINE_LENGTH = 500;
export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
export const MAX_COMMAND_TIMEOUT_MS = 30_000;
export const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
/** Replaces the repository root in captured command output. */
export const REPOSITORY_ROOT_PLACEHOLDER = '<repo>';

const BINARY_SNIFF_BYTES = 8192;
const OPEN_READ_NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

interface WalkEntry extends RepositoryEntry {
  readonly absolutePath: string;
}

/**
 * View of a single repository directory. Every path is resolved lexically and
 * then through `realpath`, and must stay inside the canonical root after
 * symlinks are followed. Walks never follow symlinks. Commands must pass the
 * command policy and run without a shell, inside the root, with a filtered
 * environment, a timeout, and bounded output capture.
 */
export class RepositorySandbox {
  /** Canonical (realpath) repository root. */
  readonly root: string;
  readonly #rootAliases: readonly string[];
  readonly #maxFileBytes: number;
  readonly #ignoredDirectoryNames: ReadonlySet<string>;
  readonly #commandPolicy: CommandPolicy;
  readonly #hostEnvironment: HostEnvironment;
  readonly #envPassthrough: readonly string[] | undefined;

  private constructor(root: string, rootAliases: readonly string[], options: RepositorySandboxOptions) {
    this.root = root;
    this.#rootAliases = rootAliases;
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.#ignoredDirectoryNames = new Set(options.ignoredDirectoryNames ?? DEFAULT_IGNORED_DIRECTORY_NAMES);
    this.#commandPolicy = options.commandPolicy ?? DEFAULT_COMMAND_POLICY;
    this.#hostEnvironment = options.hostEnvironment ?? process.env;
    this.#envPassthrough = options.envPassthrough;
  }

  get allowedCommands(): readonly string[] {
    return this.#commandPolicy.allowedCommands;
  }

  static async create(root: string, options: RepositorySandboxOptions = {}): Promise<RepositorySandbox> {
    const requested = path.resolve(root);
    let canonical: string;
    try {
      canonical = await realpath(requested);
    } catch {
      throw new SandboxError('not_found', `Repository root does not exist: ${root}`);
    }
    if (!(await stat(canonical)).isDirectory()) {
      throw new SandboxError('not_a_directory', `Repository root is not a directory: ${root}`);
    }
    if (options.maxFileBytes !== undefined && !(Number.isInteger(options.maxFileBytes) && options.maxFileBytes > 0)) {
      throw new SandboxError('invalid_argument', 'maxFileBytes must be a positive integer');
    }
    return new RepositorySandbox(canonical, [...new Set([canonical, requested])], options);
  }

  async resolveSafePath(requestedPath: string): Promise<ResolvedRepositoryPath> {
    if (typeof requestedPath !== 'string' || requestedPath.length === 0 || requestedPath.includes('\0')) {
      throw new SandboxError('invalid_path', 'Path must be a non-empty string without NUL bytes');
    }

    const candidate = path.isAbsolute(requestedPath)
      ? path.resolve(requestedPath)
      : path.resolve(this.root, requestedPath);
    if (!this.#rootAliases.some((root) => isWithin(root, candidate))) {
      throw outsideRoot(requestedPath);
    }

    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch (error) {
      if (hasErrorCode(error, 'ELOOP')) {
        throw new SandboxError('invalid_path', `Path contains a symlink loop: ${requestedPath}`);
      }
      if (!isNotFoundError(error)) {
        throw error;
      }
      // Report escapes before existence so callers cannot probe for files outside the root.
      if (!isWithin(this.root, await nearestExistingRealpath(candidate))) {
        throw outsideRoot(requestedPath);
      }
      throw new SandboxError('not_found', `Path does not exist: ${requestedPath}`);
    }
    if (!isWithin(this.root, canonical)) {
      throw outsideRoot(requestedPath);
    }

    const stats = await stat(canonical);
    if (!stats.isFile() && !stats.isDirectory()) {
      throw new SandboxError('invalid_path', `Path is not a regular file or directory: ${requestedPath}`);
    }
    return {
      absolutePath: canonical,
      relativePath: this.#toRepositoryPath(canonical),
      type: stats.isDirectory() ? 'directory' : 'file',
    };
  }

  async readFile(requestedPath: string): Promise<RepositoryFile> {
    const resolved = await this.resolveSafePath(requestedPath);
    if (resolved.type !== 'file') {
      throw new SandboxError('not_a_file', `Path is a directory, not a file: ${requestedPath}`);
    }
    return this.#readText(resolved.absolutePath, resolved.relativePath);
  }

  /** Case-sensitive literal search, one match per line, in deterministic path then line order. */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    if (typeof query !== 'string' || query.length === 0) {
      throw new SandboxError('invalid_argument', 'Search query must be a non-empty string');
    }
    const maxResults = resolveLimit(options.maxResults, DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS);
    const scope = await this.resolveSafePath(options.path ?? '.');
    const files: AsyncIterable<WalkEntry> | WalkEntry[] =
      scope.type === 'file'
        ? [{ absolutePath: scope.absolutePath, path: scope.relativePath, type: 'file' }]
        : this.#walk(scope.absolutePath);

    const matches: SearchMatch[] = [];
    let truncated = false;
    let filesSearched = 0;
    let filesSkipped = 0;

    scan: for await (const entry of files) {
      if (entry.type !== 'file') {
        continue;
      }
      let content: string;
      try {
        content = (await this.#readText(entry.absolutePath, entry.path)).content;
      } catch (error) {
        if (error instanceof SandboxError && (error.code === 'not_text' || error.code === 'file_too_large')) {
          filesSkipped += 1;
          continue;
        }
        throw error;
      }
      filesSearched += 1;

      const lines = splitLines(content);
      for (const [index, line] of lines.entries()) {
        const column = line.indexOf(query);
        if (column === -1) {
          continue;
        }
        if (matches.length === maxResults) {
          truncated = true;
          break scan;
        }
        matches.push({
          path: entry.path,
          line: index + 1,
          column: column + 1,
          text: line.length > MAX_MATCH_LINE_LENGTH ? line.slice(0, MAX_MATCH_LINE_LENGTH) : line,
        });
      }
    }

    return { scope: scope.relativePath, matches, truncated, filesSearched, filesSkipped };
  }

  /** Recursive pre-order listing sorted by name. Symlinks are listed but never followed. */
  async listFiles(options: ListOptions = {}): Promise<ListResult> {
    const maxResults = resolveLimit(options.maxResults, DEFAULT_LIST_RESULTS, MAX_LIST_RESULTS);
    const requestedPath = options.path ?? '.';
    const scope = await this.resolveSafePath(requestedPath);
    if (scope.type !== 'directory') {
      throw new SandboxError('not_a_directory', `Path is a file, not a directory: ${requestedPath}`);
    }

    const entries: RepositoryEntry[] = [];
    let truncated = false;
    for await (const entry of this.#walk(scope.absolutePath)) {
      if (entries.length === maxResults) {
        truncated = true;
        break;
      }
      entries.push({ path: entry.path, type: entry.type });
    }
    return { scope: scope.relativePath, entries, truncated };
  }

  /**
   * Runs an allowlisted command. Policy rejections and unsafe working
   * directories throw `SandboxError` before anything is spawned; process
   * outcomes (non-zero exit, timeout, failure to start) are returned as data.
   */
  async runCommand(request: CommandRequest): Promise<CommandExecutionResult> {
    const decision = this.#commandPolicy.check(request.command, request.args);
    if (!decision.allowed) {
      throw new SandboxError('command_not_allowed', decision.reason);
    }
    const timeoutMs = resolveLimit(request.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS, 'timeoutMs');
    const requestedCwd = request.cwd ?? '.';
    const cwd = await this.resolveSafePath(requestedCwd);
    if (cwd.type !== 'directory') {
      throw new SandboxError('not_a_directory', `Working directory is a file, not a directory: ${requestedCwd}`);
    }

    const outcome = await runProcess({
      command: request.command,
      args: request.args,
      cwd: cwd.absolutePath,
      env: buildCommandEnvironment(this.#hostEnvironment, {
        ...(this.#envPassthrough ? { passthrough: this.#envPassthrough } : {}),
        excludedPathRoots: this.#rootAliases,
      }),
      timeoutMs,
      maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
    });
    return {
      command: request.command,
      args: [...request.args],
      cwd: cwd.relativePath,
      ...outcome,
      stdout: this.#redactRoot(outcome.stdout),
      stderr: this.#redactRoot(outcome.stderr),
    };
  }

  #redactRoot(text: string): string {
    return [...this.#rootAliases]
      .sort((a, b) => b.length - a.length)
      .reduce((redacted, root) => redacted.split(root).join(REPOSITORY_ROOT_PLACEHOLDER), text);
  }

  async *#walk(directory: string): AsyncGenerator<WalkEntry> {
    const dirents = await readdir(directory, { withFileTypes: true });
    dirents.sort((a, b) => compareCodeUnits(a.name, b.name));
    for (const dirent of dirents) {
      const absolutePath = path.join(directory, dirent.name);
      const type = await direntType(dirent, absolutePath);
      if (type === undefined || this.#ignoredDirectoryNames.has(dirent.name)) {
        continue;
      }
      yield { absolutePath, path: this.#toRepositoryPath(absolutePath), type };
      if (type === 'directory') {
        yield* this.#walk(absolutePath);
      }
    }
  }

  async #readText(absolutePath: string, relativePath: string): Promise<RepositoryFile> {
    let handle;
    try {
      handle = await open(absolutePath, OPEN_READ_NO_FOLLOW);
    } catch (error) {
      if (hasErrorCode(error, 'ELOOP')) {
        throw new SandboxError('invalid_path', `Path changed to a symlink while reading: ${relativePath}`);
      }
      throw error;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        throw new SandboxError('not_a_file', `Path is not a regular file: ${relativePath}`);
      }
      if (stats.size > this.#maxFileBytes) {
        throw tooLarge(relativePath, this.#maxFileBytes);
      }
      const buffer = await handle.readFile();
      if (buffer.length > this.#maxFileBytes) {
        throw tooLarge(relativePath, this.#maxFileBytes);
      }
      return { path: relativePath, content: decodeText(buffer, relativePath), sizeBytes: buffer.length };
    } finally {
      await handle.close();
    }
  }

  #toRepositoryPath(absolutePath: string): string {
    const relative = path.relative(this.root, absolutePath);
    return relative === '' ? '.' : relative.split(path.sep).join('/');
  }
}

async function nearestExistingRealpath(candidate: string): Promise<string> {
  let current = candidate;
  for (;;) {
    try {
      return await realpath(current);
    } catch (error) {
      const parent = path.dirname(current);
      if (!isNotFoundError(error) || parent === current) {
        throw error;
      }
      current = parent;
    }
  }
}

async function direntType(dirent: Dirent, absolutePath: string): Promise<RepositoryEntryType | undefined> {
  if (dirent.isSymbolicLink()) return 'symlink';
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isFile()) return 'file';
  if (dirent.isBlockDevice() || dirent.isCharacterDevice() || dirent.isFIFO() || dirent.isSocket()) {
    return undefined;
  }
  const stats = await lstat(absolutePath);
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'file';
  return undefined;
}

function decodeText(buffer: Buffer, relativePath: string): string {
  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    throw new SandboxError('not_text', `File appears to be binary: ${relativePath}`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new SandboxError('not_text', `File is not valid UTF-8 text: ${relativePath}`);
  }
}

function resolveLimit(requested: number | undefined, fallback: number, cap: number, name = 'maxResults'): number {
  if (requested === undefined) {
    return fallback;
  }
  if (!Number.isInteger(requested) || requested < 1) {
    throw new SandboxError('invalid_argument', `${name} must be a positive integer`);
  }
  return Math.min(requested, cap);
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function outsideRoot(requestedPath: string): SandboxError {
  return new SandboxError('outside_root', `Path resolves outside the repository root: ${requestedPath}`);
}

function tooLarge(relativePath: string, limit: number): SandboxError {
  return new SandboxError('file_too_large', `File exceeds the ${limit}-byte limit: ${relativePath}`);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function isNotFoundError(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR');
}
