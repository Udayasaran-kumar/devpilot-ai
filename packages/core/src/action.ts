import { z } from 'zod';
import { IdSchema, JsonObjectSchema } from './common.js';
import { EvidenceIdSchema } from './evidence.js';

/**
 * The only action types a planner may request. Each is a registered, sandboxed
 * tool; planners cannot request patch application or any other type.
 */
export const PlannerActionTypeSchema = z.enum(['read_file', 'search_code', 'list_files', 'run_command']);
export type PlannerActionType = z.infer<typeof PlannerActionTypeSchema>;

export const InvestigationActionSchema = z.object({
  id: IdSchema,
  /** Action type: the name of the registered tool that executes it. */
  tool: z.string().min(1),
  input: JsonObjectSchema,
  /** Why the action is being taken. */
  rationale: z.string().min(1),
  /** What evidence the action is expected to produce. */
  expectedEvidence: z.string().min(1),
  hypothesisIds: z.array(IdSchema),
});
export type InvestigationAction = z.infer<typeof InvestigationActionSchema>;

export const ActionStatusSchema = z.enum(['planned', 'completed', 'failed']);
export type ActionStatus = z.infer<typeof ActionStatusSchema>;

/** An action with its outcome, as held in investigation state. */
export const InvestigationActionRecordSchema = InvestigationActionSchema.extend({
  status: ActionStatusSchema,
  resultingEvidenceIds: z.array(EvidenceIdSchema),
  error: z.string().min(1).optional(),
});
export type InvestigationActionRecord = z.infer<typeof InvestigationActionRecordSchema>;
