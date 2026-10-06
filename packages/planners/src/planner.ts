import { z } from 'zod';
import {
  HypothesisSchema,
  IdSchema,
  JsonObjectSchema,
  type Evidence,
  type Hypothesis,
  type InvestigationAction,
  type Signal,
  type VerificationResult,
} from '@devpilot/core';
import type { ToolDescriptor } from '@devpilot/tools';

/** Read-only view of the investigation that a planner decides from. */
export interface PlannerContext {
  readonly investigationId: string;
  readonly signal: Signal;
  readonly stepCount: number;
  readonly remainingSteps: number;
  readonly actions: readonly InvestigationAction[];
  readonly evidence: readonly Evidence[];
  readonly hypotheses: readonly Hypothesis[];
  readonly verifications: readonly VerificationResult[];
  readonly tools: readonly ToolDescriptor[];
}

/**
 * Decisions are validated at runtime because future planners (LLM-backed)
 * produce them from untrusted model output.
 */
export const PlannerDecisionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('act'),
    tool: z.string().min(1),
    input: JsonObjectSchema,
    rationale: z.string().min(1),
    hypothesisIds: z.array(IdSchema).optional(),
  }),
  z.object({
    type: z.literal('update_hypotheses'),
    hypotheses: z.array(HypothesisSchema).min(1),
  }),
  z.object({
    type: z.literal('finish'),
    reason: z.string().min(1),
  }),
]);
export type PlannerDecision = z.infer<typeof PlannerDecisionSchema>;

export interface Planner {
  readonly name: string;
  next(context: PlannerContext): Promise<PlannerDecision>;
}
