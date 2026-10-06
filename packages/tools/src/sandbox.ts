import { constants, type Dirent } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { splitLines } from './text.js';

export type SandboxErrorCode =
  | 'invalid_path'
  | 'invalid_argument'
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

export interface RepositorySandboxOptions {
  readonly maxFileBytes?: number;
  /** Directory names never descended into while walking. Explicitly requested paths are still allowed. */
  readonly ignoredDirectoryNames?: readonly string[];
}

export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
export const DEFAULT_IGNORED_DIRECTORY_NAMES: readonly string[] = ['.git', 'node_modules'];
export const DEFAULT_SEARCH_RESULTS = 50;
export const MAX_SEARCH_RESULTS = 500;
export const DEFAULT_LIST_RESULTS = 200;
export const MAX_LIST_RESULTS = 2000;
export const MAX_MATCH_LINE_LENGTH = 500;

const BINARY_SNIFF_BYTES = 8192;
const OPEN_READ_NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

interface WalkEntry extends RepositoryEntry {
  readonly absolutePath: string;
}

/**
 * Read-only view of a single repository directory. Every path is resolved
 * lexically and then through `realpath`, and must stay inside the canonical
 * root after symlinks are followed. Walks never follow symlinks.
 */
export class RepositorySandbox {
  /** Canonical (realpath) repository root. */
  readonly root: string;
  readonly #rootAliases: readonly string[];
  readonly #maxFileBytes: number;
  readonly #ignoredDirectoryNames: ReadonlySet<string>;

  private constructor(root: string, rootAliases: readonly string[], options: RepositorySandboxOptions) {
    this.root = root;
    this.#rootAliases = rootAliases;
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.#ignoredDirectoryNames = new Set(options.ignoredDirectoryNames ?? DEFAULT_IGNORED_DIRECTORY_NAMES);
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

  async *#walk(directory: string): AsyncGenerator<WalkEntry> {
    const dirents = await readdir(directory, { withFileTypes: true });
    dirents.sort((a, b) => compareCodeUnits(a.name, b.name));
    for (const dirent of dirents) {
      const absolutePath = path.join(directory, dirent.name);
      const type = await direntType(dirent, absolutePath);
      if (type === undefined || (type === 'directory' && this.#ignoredDirectoryNames.has(dirent.name))) {
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

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
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

function resolveLimit(requested: number | undefined, fallback: number, cap: number): number {
  if (requested === undefined) {
    return fallback;
  }
  if (!Number.isInteger(requested) || requested < 1) {
    throw new SandboxError('invalid_argument', 'maxResults must be a positive integer');
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
