import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.js';
import { InvestigationActionRecordSchema } from './action.js';
import { EvidenceIdSchema } from './evidence.js';
import { HypothesisSchema } from './hypothesis.js';
import { PatchProposalRecordSchema } from './proposal.js';
import { RepairStatusSchema } from './repair.js';

/**
 * - `observation`: what a tool returned. Must quote text found in a cited evidence item.
 * - `finding`: an inference drawn from evidence. Must quote the evidence it rests on.
 * - `proposal`: what the planner proposed. Cites the evidence behind the proposal.
 * - `verification`: what the repair workflow proved. Must cite its confirmed GREEN evidence.
 */
export const GroundedClaimKindSchema = z.enum(['observation', 'finding', 'proposal', 'verification']);
export type GroundedClaimKind = z.infer<typeof GroundedClaimKindSchema>;

export const GroundedClaimSchema = z.strictObject({
  id: IdSchema,
  kind: GroundedClaimKindSchema,
  statement: z.string().min(1),
  evidenceIds: z.array(EvidenceIdSchema).min(1, 'Every claim must cite at least one evidence ID'),
  actionIds: z.array(IdSchema),
  /** Verbatim text from a cited evidence item that the statement rests on. */
  quote: z.string().min(1).optional(),
});
export type GroundedClaim = z.infer<typeof GroundedClaimSchema>;

/** Authoritative repair status: the repair workflow's result, or `not_attempted` if it never ran. */
export const ReportRepairStatusSchema = z.union([RepairStatusSchema, z.literal('not_attempted')]);
export type ReportRepairStatus = z.infer<typeof ReportRepairStatusSchema>;

export const ReportVerificationSchema = z.object({
  command: z.string().min(1).nullable(),
  status: ReportRepairStatusSchema,
  reason: z.string().nullable(),
  baselineEvidenceId: EvidenceIdSchema.nullable(),
  worktreeBaselineEvidenceId: EvidenceIdSchema.nullable(),
  finalEvidenceId: EvidenceIdSchema.nullable(),
});
export type ReportVerification = z.infer<typeof ReportVerificationSchema>;

export const RepairReportSchema = z.strictObject({
  id: IdSchema,
  investigationId: IdSchema,
  /** Investigation ID of the repair workflow run; null if it never ran. */
  repairInvestigationId: IdSchema.nullable(),
  signalId: IdSchema,
  /** The incident as reported; this is input, not a finding. */
  incident: z.object({ title: z.string().min(1), kind: z.string().min(1), command: z.string().nullable() }),
  selectedHypothesis: HypothesisSchema.nullable(),
  confidence: z.number().min(0).max(1),
  hypotheses: z.array(HypothesisSchema),
  supportingEvidenceIds: z.array(EvidenceIdSchema),
  contradictingEvidenceIds: z.array(EvidenceIdSchema),
  investigationActions: z.array(InvestigationActionRecordSchema),
  patchProposal: PatchProposalRecordSchema.nullable(),
  affectedFiles: z.array(z.string().min(1)),
  verification: ReportVerificationSchema,
  repairStatus: ReportRepairStatusSchema,
  claims: z.array(GroundedClaimSchema),
  limitations: z.array(z.string().min(1)),
  createdAt: TimestampSchema,
});
export type RepairReport = z.infer<typeof RepairReportSchema>;
