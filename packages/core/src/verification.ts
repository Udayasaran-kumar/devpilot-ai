import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.js';
import { EvidenceIdSchema } from './evidence.js';

export const VerificationStatusSchema = z.enum(['confirmed', 'rejected', 'inconclusive', 'not_run']);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

export const VerificationResultSchema = z
  .object({
    id: IdSchema,
    hypothesisId: IdSchema.optional(),
    status: VerificationStatusSchema,
    summary: z.string().min(1),
    command: z.string().min(1).optional(),
    exitCode: z.number().int().optional(),
    evidenceIds: z.array(EvidenceIdSchema),
    completedAt: TimestampSchema.optional(),
  })
  .refine(
    (result) =>
      (result.status !== 'confirmed' && result.status !== 'rejected') || result.evidenceIds.length > 0,
    { message: 'A confirmed or rejected verification must cite at least one evidence ID', path: ['evidenceIds'] },
  );
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
