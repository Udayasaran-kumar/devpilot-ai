import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_IGNORED_DIRECTORY_NAMES } from './sandbox.js';

export const MAX_FINGERPRINT_ENTRIES = 100_000;

/**
 * Entries of a `.git` directory that define the repository apart from its
 * object store: what is checked out, branches and tags, configuration, and
 * hooks. Excluded are `objects/` (append-only and content-addressed), `logs/`,
 * `index` (rewritten by any `git status`), and `worktrees/` (linked worktree
 * bookkeeping, which changes whenever a worktree is added or removed).
 */
export const GIT_METADATA_ENTRIES: readonly string[] = [
  'HEAD',
  'config',
  'packed-refs',
  'refs',
  'hooks',
  'info',
  'shallow',
  'commondir',
];

export interface TreeFingerprint {
  /** sha256 over every entry, in path order. */
  readonly digest: string;
  /** POSIX relative path -> entry description (type, executable bit, content hash or link target). */
  readonly entries: ReadonlyMap<string, string>;
}

export interface FingerprintOptions {
  /** Entry names skipped at any depth. Defaults to the sandbox's ignored names (`.git`, `.devpilot`, `node_modules`). */
  readonly ignoredNames?: readonly string[];
}

/**
 * Content fingerprint of a working tree for detecting changes. Symlinks are
 * recorded by target and never followed. Only the executable bit of the mode
 * is recorded, since that is all git tracks. Ignored names are skipped
 * entirely, so changes inside them are not detected.
 */
export async function fingerprintTree(root: string, options: FingerprintOptions = {}): Promise<TreeFingerprint> {
  const ignored = new Set(options.ignoredNames ?? DEFAULT_IGNORED_DIRECTORY_NAMES);
  const entries = new Map<string, string>();
  for (const name of await sortedNames(root)) {
    if (!ignored.has(name)) await addEntry(entries, root, path.join(root, name), ignored);
  }
  return finish(entries);
}

/**
 * Fingerprint of the repository's own git metadata (see `GIT_METADATA_ENTRIES`),
 * keyed as `.git/<path>`. Requires `.git` to be a real directory.
 */
export async function fingerprintGitMetadata(repositoryRoot: string): Promise<TreeFingerprint> {
  const gitDirectory = path.join(repositoryRoot, '.git');
  const stats = await lstat(gitDirectory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('.git must be a real directory');
  }
  const entries = new Map<string, string>();
  for (const name of GIT_METADATA_ENTRIES) {
    const absolute = path.join(gitDirectory, name);
    if ((await lstat(absolute).catch(() => undefined)) !== undefined) {
      await addEntry(entries, repositoryRoot, absolute, new Set());
    }
  }
  return finish(entries);
}

/** Paths added, removed, or changed between two fingerprints, sorted. */
export function diffFingerprints(before: TreeFingerprint, after: TreeFingerprint): string[] {
  if (before.digest === after.digest) return [];
  const paths = new Set([...before.entries.keys(), ...after.entries.keys()]);
  return [...paths].filter((relative) => before.entries.get(relative) !== after.entries.get(relative)).sort();
}

async function addEntry(
  entries: Map<string, string>,
  root: string,
  absolute: string,
  ignored: ReadonlySet<string>,
): Promise<void> {
  if (entries.size >= MAX_FINGERPRINT_ENTRIES) {
    throw new RangeError(`Working tree has more than ${MAX_FINGERPRINT_ENTRIES} entries`);
  }
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  const stats = await lstat(absolute);
  if (stats.isSymbolicLink()) {
    entries.set(relative, `symlink ${await readlink(absolute)}`);
  } else if (stats.isDirectory()) {
    entries.set(relative, 'directory');
    for (const name of await sortedNames(absolute)) {
      if (!ignored.has(name)) await addEntry(entries, root, path.join(absolute, name), ignored);
    }
  } else if (stats.isFile()) {
    const hash = createHash('sha256').update(await readFile(absolute)).digest('hex');
    entries.set(relative, `file ${stats.mode & 0o111 ? 'x' : '-'} ${hash}`);
  } else {
    entries.set(relative, 'other');
  }
}

async function sortedNames(directory: string): Promise<string[]> {
  return (await readdir(directory)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function finish(entries: Map<string, string>): TreeFingerprint {
  const digest = createHash('sha256');
  for (const [relative, description] of entries) {
    digest.update(`${relative}\0${description}\n`);
  }
  return { digest: digest.digest('hex'), entries };
}
