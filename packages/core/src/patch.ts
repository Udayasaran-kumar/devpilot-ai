import { z } from 'zod';

/** Upper bound on patch text, in UTF-16 code units. */
export const MAX_PATCH_LENGTH = 1_000_000;
export const MAX_PATCH_DESCRIPTION_LENGTH = 500;

/**
 * A unified diff to apply inside an isolated worktree. Strict: there is no
 * field for paths, strip levels, or git options, and unknown keys are rejected.
 */
export const PatchRequestSchema = z.strictObject({
  patch: z.string().min(1).max(MAX_PATCH_LENGTH),
  /** Why the patch is being applied; recorded in evidence. */
  description: z.string().min(1).max(MAX_PATCH_DESCRIPTION_LENGTH).optional(),
});
export type PatchRequest = z.infer<typeof PatchRequestSchema>;

/**
 * - `applied`: every file change was written.
 * - `rejected`: a well-formed, safe patch does not match the current files (context mismatch,
 *   creating a file that exists, changing a file that does not). Nothing was written.
 * - `invalid_patch`: malformed or unsupported diff (binary, rename, mode change, ...). Nothing was written.
 * - `unsafe_path`: a path is absolute, traverses, targets `.git`/`.devpilot`, or crosses a symlink. Nothing was written.
 * - `workspace_missing`: there is no active worktree. Nothing was written.
 * - `application_failed`: writing failed part-way; completed writes were rolled back.
 */
export const PatchStatusSchema = z.enum([
  'applied',
  'rejected',
  'invalid_patch',
  'unsafe_path',
  'workspace_missing',
  'application_failed',
]);
export type PatchStatus = z.infer<typeof PatchStatusSchema>;

export const PatchFileOperationSchema = z.enum(['create', 'modify', 'delete']);
export type PatchFileOperation = z.infer<typeof PatchFileOperationSchema>;

export const PatchFileChangeSchema = z.object({
  /** POSIX path relative to the worktree root, as named in the patch. */
  path: z.string().min(1),
  operation: PatchFileOperationSchema,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type PatchFileChange = z.infer<typeof PatchFileChangeSchema>;

export const PatchResultSchema = z.object({
  status: PatchStatusSchema,
  description: z.string().nullable(),
  /** Name of the worktree workspace; null when none was active. */
  workspace: z.string().nullable(),
  /** sha256 of the patch text exactly as received. */
  patchSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** File changes parsed from the patch; empty when it could not be parsed. */
  files: z.array(PatchFileChangeSchema),
  affectedPaths: z.array(z.string().min(1)),
  /** Why the patch was not applied; null when applied. */
  reason: z.string().nullable(),
});
export type PatchResult = z.infer<typeof PatchResultSchema>;
