import { z } from 'zod';
import { IdSchema, JsonObjectSchema } from './common.js';

export const InvestigationActionSchema = z.object({
  id: IdSchema,
  tool: z.string().min(1),
  input: JsonObjectSchema,
  rationale: z.string().min(1),
  hypothesisIds: z.array(IdSchema),
});
export type InvestigationAction = z.infer<typeof InvestigationActionSchema>;
