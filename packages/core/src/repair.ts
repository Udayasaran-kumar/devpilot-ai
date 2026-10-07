import { z } from 'zod';
import { IdSchema } from './common.js';
import { EvidenceIdSchema } from './evidence.js';
import { PatchRequestSchema, PatchStatusSchema } from './patch.js';
import { SignalSchema } from './signal.js';

/**
 * The command that reproduces the incident and later proves the repair. It is
 * an argv pair checked against the command policy; there is no field for a
 * shell, working directory, environment, or executable path.
 */
export const RepairVerificationSchema = z.strictObject({
  command: z.string().min(1).max(256),
  args: z.array(z.string().max(4096)).max(64),
  /**
   * Text copied from the signal (failing test name, assertion message) that
   * the baseline output must contain for the failure to count as the incident.
   */
  expectedFailure: z.array(z.string().min(1).max(1000)).min(1).max(20),
});
export type RepairVerification = z.infer<typeof RepairVerificationSchema>;

export const RepairRequestSchema = z.strictObject({
  repositoryRoot: z.string().min(1),
  signal: SignalSchema,
  verification: RepairVerificationSchema,
  patch: PatchRequestSchema.shape.patch,
  description: PatchRequestSchema.shape.description,
  hypothesisId: IdSchema.optional(),
});
export type RepairRequest = z.infer<typeof RepairRequestSchema>;

/**
 * - `repaired`: confirmed RED baseline, patch applied in a worktree, the same command confirmed GREEN there,
 *   and the original repository unchanged.
 * - `baseline_not_red`: the original repository already passes; no patch was applied.
 * - `baseline_inconclusive`: the baseline timed out, could not start, or failed without the expected output.
 * - `worktree_failed`: the isolated worktree could not be created, does not match the baseline checkout, or the
 *   unpatched worktree does not reproduce the confirmed RED.
 * - `patch_failed`: apply_patch did not return `applied`.
 * - `verification_failed`: the patched worktree is still RED.
 * - `verification_inconclusive`: the verification timed out or could not run.
 * - `safety_check_failed`: GREEN, but the original changed, the worktree changed outside the patch or moved its
 *   HEAD, or the patch adds a file whose name looks like a secret.
 * - `error`: an unexpected internal error stopped the workflow.
 */
export const RepairStatusSchema = z.enum([
  'repaired',
  'baseline_not_red',
  'baseline_inconclusive',
  'worktree_failed',
  'patch_failed',
  'verification_failed',
  'verification_inconclusive',
  'safety_check_failed',
  'error',
]);
export type RepairStatus = z.infer<typeof RepairStatusSchema>;

export const RepairFailureStatusSchema = RepairStatusSchema.exclude(['repaired']);
export type RepairFailureStatus = z.infer<typeof RepairFailureStatusSchema>;

export const RepairResultSchema = z
  .object({
    investigationId: IdSchema,
    status: RepairStatusSchema,
    /** Why the repair is not `repaired`; null when it is. */
    reason: z.string().nullable(),
    /** The verification command line, identical for the baseline and the final run. */
    verificationCommand: z.string().min(1),
    hypothesisId: IdSchema.nullable(),
    baselineVerificationId: IdSchema.nullable(),
    baselineEvidenceId: EvidenceIdSchema.nullable(),
    worktree: z.string().nullable(),
    baseCommit: z.string().nullable(),
    /** The same command, still RED in the unpatched worktree. */
    worktreeBaselineEvidenceId: EvidenceIdSchema.nullable(),
    patchStatus: PatchStatusSchema.nullable(),
    patchEvidenceId: EvidenceIdSchema.nullable(),
    finalVerificationId: IdSchema.nullable(),
    finalEvidenceId: EvidenceIdSchema.nullable(),
    /** Paths changed in the worktree relative to its base commit. */
    changedFiles: z.array(z.string().min(1)),
    /** Null when the check was not reached. */
    originalUnchanged: z.boolean().nullable(),
    /** Whether the worktree still exists: always after a repair, otherwise only if removing it failed. */
    worktreeRetained: z.boolean(),
  })
  .superRefine((result, context) => {
    if (result.status !== 'repaired') return;
    const required = [
      'baselineVerificationId',
      'baselineEvidenceId',
      'worktree',
      'worktreeBaselineEvidenceId',
      'patchEvidenceId',
      'finalVerificationId',
      'finalEvidenceId',
    ] as const;
    for (const key of required) {
      if (result[key] === null) {
        context.addIssue({ code: 'custom', path: [key], message: `A repaired result requires ${key}` });
      }
    }
    if (result.patchStatus !== 'applied') {
      context.addIssue({ code: 'custom', path: ['patchStatus'], message: 'A repaired result requires an applied patch' });
    }
    if (result.originalUnchanged !== true) {
      context.addIssue({
        code: 'custom',
        path: ['originalUnchanged'],
        message: 'A repaired result requires the original repository to be unchanged',
      });
    }
    if (result.reason !== null) {
      context.addIssue({ code: 'custom', path: ['reason'], message: 'A repaired result has no failure reason' });
    }
    if (result.changedFiles.length === 0) {
      context.addIssue({ code: 'custom', path: ['changedFiles'], message: 'A repaired result changes at least one file' });
    }
    if (!result.worktreeRetained) {
      context.addIssue({ code: 'custom', path: ['worktreeRetained'], message: 'A repaired result keeps its worktree' });
    }
  });
export type RepairResult = z.infer<typeof RepairResultSchema>;
