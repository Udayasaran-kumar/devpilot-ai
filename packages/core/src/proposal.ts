import { z } from 'zod';
import { IdSchema } from './common.js';
import { EvidenceIdSchema } from './evidence.js';
import { PatchRequestSchema } from './patch.js';

export const MAX_PROPOSAL_TEXT_LENGTH = 2000;

/**
 * A planner's proposed repair. It is only a proposal: it carries no status,
 * nothing applies it, and only the repair workflow can verify it. Strict, so
 * a planner cannot smuggle in fields such as `status: 'repaired'`.
 */
export const PatchProposalSchema = z.strictObject({
  hypothesisId: IdSchema,
  rationale: z.string().min(1).max(MAX_PROPOSAL_TEXT_LENGTH),
  /** Unified diff in the format `apply_patch` accepts. Reviewed exactly as given, never rewritten. */
  patch: PatchRequestSchema.shape.patch,
  /** Paths the planner says the patch changes; must equal the paths in the diff. */
  affectedPaths: z.array(z.string().min(1)).min(1),
  /** What the verification command should show if the hypothesis is right. A prediction, not a result. */
  expectedOutcome: z.string().min(1).max(MAX_PROPOSAL_TEXT_LENGTH),
  /** May be empty so that review can reject it with a structured reason. */
  supportingEvidenceIds: z.array(EvidenceIdSchema),
  confidence: z.number().min(0).max(1),
});
export type PatchProposal = z.infer<typeof PatchProposalSchema>;

/**
 * The only states a proposal can reach before the repair workflow runs:
 * recorded (`patch_proposed`), refused by review (`patch_rejected`), or
 * accepted by review and handed to the repair workflow (`awaiting_verification`).
 */
export const PatchProposalStatusSchema = z.enum(['patch_proposed', 'patch_rejected', 'awaiting_verification']);
export type PatchProposalStatus = z.infer<typeof PatchProposalStatusSchema>;

export const PatchReviewStatusSchema = PatchProposalStatusSchema.exclude(['patch_proposed']);
export type PatchReviewStatus = z.infer<typeof PatchReviewStatusSchema>;

/**
 * Why review refused a proposal. Path rules come from the patch safety policy;
 * the rest tie the proposal to the selected hypothesis and its evidence.
 */
export const PatchViolationCodeSchema = z.enum([
  'invalid_patch',
  'unsafe_path',
  'outside_repository',
  'protected_path',
  'test_file',
  'test_config',
  'package_manifest',
  'lockfile',
  'dependency_directory',
  'ci_config',
  'credential_file',
  'too_many_files',
  'unrelated_file',
  'affected_paths_mismatch',
  'hypothesis_not_selected',
  'missing_supporting_evidence',
  'unknown_evidence',
  'evidence_not_supporting_hypothesis',
  'confidence_exceeds_hypothesis',
]);
export type PatchViolationCode = z.infer<typeof PatchViolationCodeSchema>;

export const PatchViolationSchema = z.object({
  code: PatchViolationCodeSchema,
  message: z.string().min(1),
  path: z.string().min(1).optional(),
});
export type PatchViolation = z.infer<typeof PatchViolationSchema>;

export const PatchProposalRecordSchema = z
  .object({
    id: IdSchema,
    proposal: PatchProposalSchema,
    status: PatchProposalStatusSchema,
    violations: z.array(PatchViolationSchema),
  })
  .refine((record) => (record.status === 'patch_rejected') === record.violations.length > 0, {
    message: 'A proposal has violations exactly when it is rejected',
    path: ['violations'],
  });
export type PatchProposalRecord = z.infer<typeof PatchProposalRecordSchema>;
