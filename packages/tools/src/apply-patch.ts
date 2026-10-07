import { createHash, randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import { chmod, lstat, mkdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  createEvidenceId,
  EvidenceIdSchema,
  PatchRequestSchema,
  PatchResultSchema,
  type Evidence,
  type EvidenceLocation,
  type PatchRequest,
  type PatchResult,
  type PatchStatus,
} from '@devpilot/core';
import { RepositorySandbox, SandboxError } from './sandbox.js';
import type { Tool, ToolContext } from './tool.js';
import { applyHunks, parseUnifiedDiff, PatchParseError, type FilePatch } from './unified-diff.js';
import { WORKSPACE_DIRECTORY_NAME, WORKTREES_DIRECTORY_NAME } from './worktree-workspace.js';

export const APPLY_PATCH_TOOL_NAME = 'apply_patch';
/** Path segments a patch may never touch, compared case-insensitively at any depth. */
export const PROTECTED_PATH_SEGMENTS: readonly string[] = ['.git', '.devpilot'];
/** Patch text kept in evidence; longer patches are truncated there (the sha256 covers the full text). */
export const MAX_EVIDENCE_PATCH_LENGTH = 16_000;

export const ApplyPatchInputSchema = PatchRequestSchema;
export type ApplyPatchInput = PatchRequest;

export const ApplyPatchOutputSchema = PatchResultSchema.extend({
  evidenceIds: z.array(EvidenceIdSchema),
});
export type ApplyPatchOutput = z.infer<typeof ApplyPatchOutputSchema>;

/** The part of `GitWorktreeWorkspace` that apply_patch needs. */
export interface PatchWorkspace {
  readonly name: string;
  readonly removed: boolean;
  getSandbox(): RepositorySandbox;
}

/** A workspace, or a getter for whichever workspace is currently active (if any). */
export type PatchWorkspaceSource = PatchWorkspace | (() => PatchWorkspace | undefined);

/**
 * `apply_patch` writes only inside an isolated worktree. It is never part of
 * the registry for the original repository; see `createWorkspaceTools`.
 */
export function createApplyPatchTool(source: PatchWorkspaceSource): Tool<ApplyPatchInput, ApplyPatchOutput> {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    name: APPLY_PATCH_TOOL_NAME,
    description:
      'Apply a git-style unified diff ("--- a/<path>", "+++ b/<path>", "@@" hunks; /dev/null to create or delete) ' +
      'inside the isolated worktree only, never the original checkout. Text files only: no renames, mode changes, ' +
      'binary patches, or symlinks, and nothing under .git or .devpilot. All-or-nothing: if any file fails, nothing ' +
      'is changed. Returns a status (applied, rejected, invalid_patch, unsafe_path, workspace_missing, application_failed).',
    inputSchema: ApplyPatchInputSchema,
    outputSchema: ApplyPatchOutputSchema,
    async run(input, context) {
      // One patch at a time per workspace tool, so concurrent calls cannot interleave writes.
      const run = queue.then(() => applyPatchToWorkspace(source, input));
      queue = run.catch(() => undefined);
      const result = await run;
      const evidence = createPatchEvidence(result, input.patch, context);
      return { status: 'success', output: { ...result, evidenceIds: [evidence.id] }, evidence: [evidence] };
    },
  };
}

interface PlannedChange {
  readonly file: FilePatch;
  readonly absolutePath: string;
  readonly original: { readonly content: string; readonly mode: number } | undefined;
  readonly content: string;
  /** Directories to create, outermost first. */
  readonly missingDirectories: readonly string[];
}

type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly status: PatchStatus; readonly reason: string };

/**
 * Validates and applies a patch inside the workspace's worktree. Nothing is
 * written unless every path is safe and every hunk applies; a failure while
 * writing rolls back the writes already made.
 */
export async function applyPatchToWorkspace(source: PatchWorkspaceSource, request: PatchRequest): Promise<PatchResult> {
  const workspace = typeof source === 'function' ? source() : source;
  const base = {
    description: request.description ?? null,
    workspace: workspace?.name ?? null,
    patchSha256: createHash('sha256').update(request.patch).digest('hex'),
  };
  const finish = (status: PatchStatus, files: readonly FilePatch[], reason: string | null): PatchResult => ({
    ...base,
    status,
    files: files.map(({ path: filePath, operation, additions, deletions }) => ({
      path: filePath,
      operation,
      additions,
      deletions,
    })),
    affectedPaths: files.map((file) => file.path),
    reason,
  });

  const sandbox = await activeSandbox(workspace);
  if (!sandbox.ok) return finish(sandbox.status, [], sandbox.reason);

  let files: FilePatch[];
  try {
    files = parseUnifiedDiff(request.patch);
  } catch (error) {
    if (error instanceof PatchParseError) return finish(error.code, [], error.message);
    throw error;
  }

  for (const file of files) {
    const problem = checkPatchPath(file.path);
    if (problem !== undefined) {
      return finish('unsafe_path', files, `${JSON.stringify(file.path)} ${problem}`);
    }
  }

  const plans: PlannedChange[] = [];
  for (const file of files) {
    const plan = await planChange(sandbox.value, file);
    if (!plan.ok) return finish(plan.status, files, plan.reason);
    plans.push(plan.value);
  }

  const written = await writeChanges(plans);
  if (!written.ok) return finish('application_failed', files, redact(written.reason, sandbox.value.root));
  return finish('applied', files, null);
}

async function activeSandbox(workspace: PatchWorkspace | undefined): Promise<Outcome<RepositorySandbox>> {
  if (workspace === undefined) {
    return { ok: false, status: 'workspace_missing', reason: 'No active worktree workspace' };
  }
  if (workspace.removed) {
    return { ok: false, status: 'workspace_missing', reason: `Workspace ${workspace.name} has been removed` };
  }
  const sandbox = workspace.getSandbox();
  let stats: Stats | undefined;
  try {
    stats = await lstat(sandbox.root);
  } catch {
    stats = undefined;
  }
  if (stats === undefined || !stats.isDirectory()) {
    return { ok: false, status: 'workspace_missing', reason: `Worktree of workspace ${workspace.name} no longer exists` };
  }
  if (!(await isIsolatedWorktree(sandbox.root))) {
    return {
      ok: false,
      status: 'workspace_missing',
      reason: `Workspace ${workspace.name} is not an isolated worktree under ${WORKTREES_SUFFIX.join('/')}`,
    };
  }
  return { ok: true, value: sandbox };
}

const WORKTREES_SUFFIX = [WORKSPACE_DIRECTORY_NAME, WORKTREES_DIRECTORY_NAME];

/**
 * Refuses anything but a linked worktree (whose `.git` is a file, unlike a main
 * checkout's directory) directly under `.devpilot/worktrees`, so a sandbox for
 * the original repository can never be patched.
 */
async function isIsolatedWorktree(root: string): Promise<boolean> {
  const parent = path.dirname(root);
  if (path.basename(parent) !== WORKTREES_DIRECTORY_NAME || path.basename(path.dirname(parent)) !== WORKSPACE_DIRECTORY_NAME) {
    return false;
  }
  try {
    return (await lstat(path.join(root, '.git'))).isFile();
  } catch {
    return false;
  }
}

/** Lexical checks on a patch path; returns why it is unsafe, or undefined. */
export function checkPatchPath(filePath: string): string | undefined {
  if (/[\u0000-\u001f\u007f]/.test(filePath)) return 'contains control characters';
  if (filePath.startsWith('/') || /^[A-Za-z]:/.test(filePath)) return 'is an absolute path';
  if (filePath.includes('\\')) return 'contains a backslash';
  const segments = filePath.split('/');
  if (segments.some((segment) => segment === '')) return 'has an empty path segment';
  if (segments.some((segment) => segment === '.' || segment === '..')) return 'contains "." or ".." segments';
  const protectedSegment = segments.find((segment) => PROTECTED_PATH_SEGMENTS.includes(segment.toLowerCase()));
  if (protectedSegment !== undefined) return `targets the protected ${protectedSegment} directory`;
  return undefined;
}

/**
 * Resolves the target through the worktree sandbox (realpath containment) and
 * additionally requires that no component of the path is a symlink, so a
 * patch can never write through one, even to a target inside the worktree.
 */
async function planChange(sandbox: RepositorySandbox, file: FilePatch): Promise<Outcome<PlannedChange>> {
  const segments = file.path.split('/');
  const absolutePath = path.join(sandbox.root, ...segments);
  const quoted = JSON.stringify(file.path);
  const unsafe = (reason: string): Outcome<never> => ({ ok: false, status: 'unsafe_path', reason });
  const rejected = (reason: string): Outcome<never> => ({ ok: false, status: 'rejected', reason });

  const stats = await lstatOrUndefined(absolutePath);
  let original: PlannedChange['original'];
  let missingDirectories: string[] = [];

  if (stats?.isSymbolicLink()) {
    return unsafe(`${quoted} is a symlink; symlinks are never patched`);
  }
  if (stats !== undefined) {
    const resolved = await resolveInSandbox(sandbox, file.path);
    if (!resolved.ok) return resolved;
    if (resolved.value.absolutePath !== absolutePath) {
      return unsafe(`${quoted} resolves through a symlink`);
    }
    if (resolved.value.type !== 'file') return rejected(`${quoted} is not a regular file`);
    if (file.operation === 'create') return rejected(`${quoted} already exists`);
    try {
      original = { content: (await sandbox.readFile(file.path)).content, mode: stats.mode & 0o7777 };
    } catch (error) {
      if (error instanceof SandboxError) return rejected(error.message);
      throw error;
    }
  } else {
    if (file.operation !== 'create') return rejected(`${quoted} does not exist`);
    const parent = await findExistingParent(sandbox, segments);
    if (!parent.ok) return parent;
    missingDirectories = parent.value;
  }

  const applied = applyHunks(original?.content ?? '', file);
  if (!applied.ok) return rejected(applied.reason);
  return { ok: true, value: { file, absolutePath, original, content: applied.content, missingDirectories } };
}

/** Walks up to the nearest existing ancestor, which must be a real directory inside the worktree. */
async function findExistingParent(sandbox: RepositorySandbox, segments: readonly string[]): Promise<Outcome<string[]>> {
  const missing: string[] = [];
  for (let depth = segments.length - 1; depth >= 0; depth -= 1) {
    const relative = depth === 0 ? '.' : segments.slice(0, depth).join('/');
    const absolute = path.join(sandbox.root, ...segments.slice(0, depth));
    const stats = await lstatOrUndefined(absolute);
    if (stats === undefined) {
      missing.unshift(absolute);
      continue;
    }
    if (stats.isSymbolicLink()) {
      return { ok: false, status: 'unsafe_path', reason: `${JSON.stringify(relative)} is a symlink` };
    }
    const resolved = await resolveInSandbox(sandbox, relative);
    if (!resolved.ok) return resolved;
    if (resolved.value.absolutePath !== absolute) {
      return { ok: false, status: 'unsafe_path', reason: `${JSON.stringify(relative)} resolves through a symlink` };
    }
    if (resolved.value.type !== 'directory') {
      return { ok: false, status: 'rejected', reason: `${JSON.stringify(relative)} is not a directory` };
    }
    return { ok: true, value: missing };
  }
  return { ok: false, status: 'workspace_missing', reason: 'Worktree root is missing' };
}

async function resolveInSandbox(
  sandbox: RepositorySandbox,
  relative: string,
): Promise<Outcome<{ absolutePath: string; type: 'file' | 'directory' }>> {
  try {
    return { ok: true, value: await sandbox.resolveSafePath(relative) };
  } catch (error) {
    if (error instanceof SandboxError) {
      const status = error.code === 'not_found' ? 'rejected' : 'unsafe_path';
      return { ok: false, status, reason: error.message };
    }
    throw error;
  }
}

/**
 * Writes every planned change; on the first failure, undoes the completed
 * steps in reverse order. Modified files are replaced via a temp file and
 * `rename`, which replaces the directory entry and never follows a link.
 */
async function writeChanges(plans: readonly PlannedChange[]): Promise<{ ok: true } | { ok: false; reason: string }> {
  const undo: Array<() => Promise<void>> = [];
  const createdDirectories = new Set<string>();
  try {
    for (const plan of plans) {
      for (const directory of plan.missingDirectories) {
        if (createdDirectories.has(directory)) continue;
        await mkdir(directory);
        createdDirectories.add(directory);
        undo.push(() => rmdir(directory));
      }
      const { absolutePath, original } = plan;
      if (original === undefined) {
        await writeFile(absolutePath, plan.content, { flag: 'wx' });
        undo.push(() => unlink(absolutePath));
        continue;
      }
      await assertRegularFile(absolutePath);
      if (plan.file.operation === 'delete') {
        await unlink(absolutePath);
        undo.push(() => writeFile(absolutePath, original.content, { flag: 'wx', mode: original.mode }));
      } else {
        await replaceFile(absolutePath, plan.content, original.mode);
        undo.push(() => replaceFile(absolutePath, original.content, original.mode));
      }
    }
    return { ok: true };
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const step of undo.reverse()) {
      try {
        await step();
      } catch (rollbackError) {
        rollbackErrors.push(errorMessage(rollbackError));
      }
    }
    const rollback =
      rollbackErrors.length === 0
        ? 'all completed changes were rolled back'
        : `rollback incomplete: ${rollbackErrors.join('; ')}`;
    return { ok: false, reason: `${errorMessage(error)}; ${rollback}` };
  }
}

async function replaceFile(absolutePath: string, content: string, mode: number): Promise<void> {
  const temporary = path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.${randomBytes(6).toString('hex')}.devpilot-tmp`,
  );
  await writeFile(temporary, content, { flag: 'wx', mode });
  try {
    await chmod(temporary, mode);
    await rename(temporary, absolutePath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function assertRegularFile(absolutePath: string): Promise<void> {
  const stats = await lstat(absolutePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${path.basename(absolutePath)} changed to a non-regular file during application`);
  }
}

async function lstatOrUndefined(target: string): Promise<Stats | undefined> {
  try {
    return await lstat(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

function createPatchEvidence(result: PatchResult, patch: string, context: ToolContext): Evidence {
  const location: EvidenceLocation = {
    type: 'patch',
    workspace: result.workspace ?? 'none',
    paths: result.affectedPaths,
    status: result.status,
  };
  const content = renderObservation(result, patch);
  return {
    id: createEvidenceId({ tool: APPLY_PATCH_TOOL_NAME, location, content }),
    kind: 'patch_application',
    summary: summarize(result),
    content,
    location,
    source: { tool: APPLY_PATCH_TOOL_NAME, actionId: context.actionId },
    collectedAt: context.now(),
  };
}

function summarize(result: PatchResult): string {
  const count = `${result.files.length} file${result.files.length === 1 ? '' : 's'}`;
  if (result.status === 'applied') {
    return `Patch applied to ${count} in worktree ${result.workspace ?? 'none'}`;
  }
  return `Patch not applied (${result.status}): ${result.reason ?? 'no reason given'}`;
}

function renderObservation(result: PatchResult, patch: string): string {
  const truncated = patch.length > MAX_EVIDENCE_PATCH_LENGTH;
  return [
    `apply_patch: ${result.status}`,
    `workspace: ${result.workspace ?? 'none'}`,
    `description: ${result.description ?? 'none'}`,
    `patch sha256: ${result.patchSha256}`,
    'files:',
    ...(result.files.length === 0
      ? ['  (none parsed)']
      : result.files.map((file) => `  ${file.operation} ${file.path} (+${file.additions} -${file.deletions})`)),
    `reason: ${result.reason ?? 'none'}`,
    `--- patch${truncated ? ` (first ${MAX_EVIDENCE_PATCH_LENGTH} characters)` : ''} ---`,
    truncated ? patch.slice(0, MAX_EVIDENCE_PATCH_LENGTH) : patch,
  ].join('\n');
}

function redact(text: string, root: string): string {
  return text.split(root).join('<worktree>');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
