import { z } from 'zod';
import { IdSchema } from './common.js';
import { EvidenceIdSchema } from './evidence.js';

export const HypothesisStatusSchema = z.enum([
  'proposed',
  'supported',
  'contradicted',
  'confirmed',
  'rejected',
]);
export type HypothesisStatus = z.infer<typeof HypothesisStatusSchema>;

export const HypothesisSchema = z.object({
  id: IdSchema,
  statement: z.string().min(1),
  status: HypothesisStatusSchema,
  confidence: z.number().min(0).max(1),
  supportingEvidenceIds: z.array(EvidenceIdSchema),
  contradictingEvidenceIds: z.array(EvidenceIdSchema),
});
export type Hypothesis = z.infer<typeof HypothesisSchema>;
