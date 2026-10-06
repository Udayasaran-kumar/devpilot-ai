import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.js';
import { EvidenceIdSchema } from './evidence.js';

export const VerificationStatusSchema = z.enum(['confirmed', 'rejected', 'inconclusive', 'not_run']);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

/** What a verification command is expected to do: reproduce a failure, or pass. */
export const VerificationExpectationSchema = z.enum(['fails', 'passes']);
export type VerificationExpectation = z.infer<typeof VerificationExpectationSchema>;

/** Observable outcome of a verification command. RED is a non-zero exit; GREEN is exit code 0. */
export const CommandOutcomeSchema = z.enum(['green', 'red', 'timed_out', 'terminated', 'not_started']);
export type CommandOutcome = z.infer<typeof CommandOutcomeSchema>;

export const VerificationResultSchema = z
  .object({
    id: IdSchema,
    hypothesisId: IdSchema.optional(),
    status: VerificationStatusSchema,
    summary: z.string().min(1),
    command: z.string().min(1).optional(),
    exitCode: z.number().int().optional(),
    expectation: VerificationExpectationSchema.optional(),
    commandOutcome: CommandOutcomeSchema.optional(),
    evidenceIds: z.array(EvidenceIdSchema),
    completedAt: TimestampSchema.optional(),
  })
  .refine(
    (result) =>
      (result.status !== 'confirmed' && result.status !== 'rejected') || result.evidenceIds.length > 0,
    { message: 'A confirmed or rejected verification must cite at least one evidence ID', path: ['evidenceIds'] },
  );
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
