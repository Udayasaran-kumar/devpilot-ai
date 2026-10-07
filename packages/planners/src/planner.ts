import { z } from 'zod';
import {
  HypothesisSchema,
  IdSchema,
  JsonObjectSchema,
  PatchProposalSchema,
  PlannerActionTypeSchema,
  type Evidence,
  type Hypothesis,
  type InvestigationActionRecord,
  type PatchProposalRecord,
  type Signal,
  type VerificationResult,
} from '@devpilot/core';
import type { ToolDescriptor } from '@devpilot/tools';

/**
 * Read-only view of the investigation that a planner decides from. It is
 * plain data: no tool registry, sandbox, file system, or process handle is
 * reachable from it, so a planner can only ask the engine to act.
 */
export interface PlannerContext {
  readonly investigationId: string;
  readonly signal: Signal;
  readonly stepCount: number;
  readonly remainingSteps: number;
  readonly actions: readonly InvestigationActionRecord[];
  readonly evidence: readonly Evidence[];
  readonly hypotheses: readonly Hypothesis[];
  readonly verifications: readonly VerificationResult[];
  readonly patchProposals: readonly PatchProposalRecord[];
  readonly tools: readonly ToolDescriptor[];
}

/**
 * Decisions are validated at runtime because future planners (LLM-backed)
 * produce them from untrusted model output. Every variant is strict, and none
 * can execute anything, write anything, or report a repair outcome.
 */
export const PlannerDecisionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('act'),
    tool: PlannerActionTypeSchema,
    input: JsonObjectSchema,
    rationale: z.string().min(1),
    expectedEvidence: z.string().min(1),
    hypothesisIds: z.array(IdSchema).optional(),
  }),
  z.strictObject({
    type: z.literal('update_hypotheses'),
    hypotheses: z.array(HypothesisSchema).min(1),
  }),
  z.strictObject({
    type: z.literal('propose_patch'),
    proposal: PatchProposalSchema,
  }),
  z.strictObject({
    type: z.literal('finish'),
    reason: z.string().min(1),
  }),
]);
export type PlannerDecision = z.infer<typeof PlannerDecisionSchema>;

export interface Planner {
  readonly name: string;
  next(context: PlannerContext): Promise<PlannerDecision>;
}
