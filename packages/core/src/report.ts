import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.js';
import { EvidenceIdSchema } from './evidence.js';
import { HypothesisSchema } from './hypothesis.js';
import { VerificationResultSchema } from './verification.js';

export const ClaimSchema = z.object({
  id: IdSchema,
  statement: z.string().min(1),
  evidenceIds: z.array(EvidenceIdSchema).min(1, 'Every claim must cite at least one evidence ID'),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const ReportOutcomeSchema = z.enum(['fix_verified', 'root_cause_identified', 'inconclusive']);
export type ReportOutcome = z.infer<typeof ReportOutcomeSchema>;

export const ReportSchema = z.object({
  id: IdSchema,
  investigationId: IdSchema,
  signalId: IdSchema,
  outcome: ReportOutcomeSchema,
  summary: z.string().min(1),
  claims: z.array(ClaimSchema),
  hypotheses: z.array(HypothesisSchema),
  verifications: z.array(VerificationResultSchema),
  createdAt: TimestampSchema,
});
export type Report = z.infer<typeof ReportSchema>;
