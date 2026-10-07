import { z } from 'zod';
import { IdSchema, JsonValueSchema, TimestampSchema } from './common.js';
import { InvestigationActionSchema } from './action.js';
import { EvidenceIdSchema, EvidenceSchema } from './evidence.js';
import { HypothesisSchema } from './hypothesis.js';
import { PatchFileChangeSchema } from './patch.js';
import { PatchProposalSchema, PatchReviewStatusSchema, PatchViolationSchema } from './proposal.js';
import { RepairFailureStatusSchema } from './repair.js';
import { SignalSchema } from './signal.js';
import { VerificationResultSchema } from './verification.js';

export const InvestigationBudgetSchema = z.object({
  maxSteps: z.number().int().positive(),
  maxDurationMs: z.number().int().positive(),
});
export type InvestigationBudget = z.infer<typeof InvestigationBudgetSchema>;

export const TerminalStatusSchema = z.enum([
  'completed',
  'step_budget_exhausted',
  'time_budget_exhausted',
  'failed',
]);
export type TerminalStatus = z.infer<typeof TerminalStatusSchema>;

const eventBase = {
  investigationId: IdSchema,
  /** Zero-based, gapless position of the event within its investigation. */
  sequence: z.number().int().nonnegative(),
  timestamp: TimestampSchema,
};

export const InvestigationStartedEventSchema = z.object({
  ...eventBase,
  type: z.literal('investigation_started'),
  signal: SignalSchema,
  budget: InvestigationBudgetSchema,
});

export const ActionPlannedEventSchema = z.object({
  ...eventBase,
  type: z.literal('action_planned'),
  action: InvestigationActionSchema,
});

export const ActionCompletedEventSchema = z.object({
  ...eventBase,
  type: z.literal('action_completed'),
  actionId: IdSchema,
  output: JsonValueSchema,
  evidence: z.array(EvidenceSchema),
});

export const ActionFailedEventSchema = z.object({
  ...eventBase,
  type: z.literal('action_failed'),
  actionId: IdSchema,
  error: z.string().min(1),
});

export const HypothesesUpdatedEventSchema = z.object({
  ...eventBase,
  type: z.literal('hypotheses_updated'),
  hypotheses: z.array(HypothesisSchema).min(1),
});

export const VerificationRecordedEventSchema = z.object({
  ...eventBase,
  type: z.literal('verification_recorded'),
  verification: VerificationResultSchema,
});

export const InvestigationCompletedEventSchema = z.object({
  ...eventBase,
  type: z.literal('investigation_completed'),
  status: TerminalStatusSchema,
  reason: z.string().min(1),
});

/** A planner proposed a patch. Recorded before review; nothing is applied. */
export const PatchProposedEventSchema = z.object({
  ...eventBase,
  type: z.literal('patch_proposed'),
  proposalId: IdSchema,
  proposal: PatchProposalSchema,
});

/** Deterministic review of a proposal: refused, or accepted and awaiting the repair workflow. */
export const PatchReviewedEventSchema = z
  .object({
    ...eventBase,
    type: z.literal('patch_reviewed'),
    proposalId: IdSchema,
    status: PatchReviewStatusSchema,
    violations: z.array(PatchViolationSchema),
  })
  .refine((event) => (event.status === 'patch_rejected') === event.violations.length > 0, {
    message: 'A review has violations exactly when it rejects the proposal',
    path: ['violations'],
  });

export const RepairStartedEventSchema = z.object({
  ...eventBase,
  type: z.literal('repair_started'),
  /** Formatted command line used for both the baseline and the final verification. */
  verificationCommand: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  /** Timeout of every verification run; part of the command's identity. */
  timeoutMs: z.number().int().positive(),
  expectedFailure: z.array(z.string().min(1)).min(1),
  patchSha256: z.string().regex(/^[0-9a-f]{64}$/),
  description: z.string().min(1).optional(),
  hypothesisId: IdSchema.optional(),
});

/** The baseline run on the original repository was a confirmed RED reproduction. */
export const BaselineVerifiedEventSchema = z.object({
  ...eventBase,
  type: z.literal('baseline_verified'),
  verificationId: IdSchema,
  evidenceId: EvidenceIdSchema,
});

/**
 * The worktree exists, matches the tree the baseline ran on, and the same
 * command is a confirmed RED there too, before any patch.
 */
export const WorktreeCreatedEventSchema = z.object({
  ...eventBase,
  type: z.literal('worktree_created'),
  /** Workspace name under `.devpilot/worktrees`; never a host path. */
  workspace: z.string().min(1),
  baseCommit: z.string().min(1),
  verificationId: IdSchema,
  evidenceId: EvidenceIdSchema,
});

export const PatchAppliedEventSchema = z.object({
  ...eventBase,
  type: z.literal('patch_applied'),
  evidenceId: EvidenceIdSchema,
  files: z.array(PatchFileChangeSchema).min(1),
});

/** The same verification command was a confirmed GREEN in the patched worktree and the safety checks passed. */
export const RepairVerifiedEventSchema = z.object({
  ...eventBase,
  type: z.literal('repair_verified'),
  verificationId: IdSchema,
  evidenceId: EvidenceIdSchema,
  changedFiles: z.array(z.string().min(1)).min(1),
  originalUnchanged: z.literal(true),
});

export const RepairFailedEventSchema = z.object({
  ...eventBase,
  type: z.literal('repair_failed'),
  status: RepairFailureStatusSchema,
  reason: z.string().min(1),
  worktreeRemoved: z.boolean(),
});

export const InvestigationEventSchema = z.discriminatedUnion('type', [
  InvestigationStartedEventSchema,
  ActionPlannedEventSchema,
  ActionCompletedEventSchema,
  ActionFailedEventSchema,
  HypothesesUpdatedEventSchema,
  VerificationRecordedEventSchema,
  InvestigationCompletedEventSchema,
  PatchProposedEventSchema,
  PatchReviewedEventSchema,
  RepairStartedEventSchema,
  BaselineVerifiedEventSchema,
  WorktreeCreatedEventSchema,
  PatchAppliedEventSchema,
  RepairVerifiedEventSchema,
  RepairFailedEventSchema,
]);
export type InvestigationEvent = z.infer<typeof InvestigationEventSchema>;
export type InvestigationEventType = InvestigationEvent['type'];
