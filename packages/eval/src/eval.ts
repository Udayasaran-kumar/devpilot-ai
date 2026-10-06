import { z } from 'zod';
import {
  EvidenceLocationSchema,
  IdSchema,
  SignalSchema,
  type InvestigationEvent,
  type Report,
} from '@devpilot/core';

/**
 * Expected outcome for a fixture. Ground truth lives with each fixture's data,
 * never in evaluator code, so evaluators stay incident-agnostic.
 */
export const GroundTruthSchema = z.object({
  rootCauseSummary: z.string().min(1),
  rootCauseLocations: z.array(EvidenceLocationSchema).min(1),
  /** Command that fails before the fix and passes after it (red-to-green). */
  verificationCommand: z.string().min(1).optional(),
});
export type GroundTruth = z.infer<typeof GroundTruthSchema>;

export const FixtureSchema = z.object({
  id: IdSchema,
  description: z.string().min(1),
  /** Repository path relative to the fixtures directory. */
  repositoryPath: z.string().min(1),
  signal: SignalSchema,
  groundTruth: GroundTruthSchema,
});
export type Fixture = z.infer<typeof FixtureSchema>;

export const EvaluationResultSchema = z.object({
  fixtureId: IdSchema,
  evaluator: z.string().min(1),
  passed: z.boolean(),
  score: z.number().min(0).max(1),
  metrics: z.record(z.string(), z.number()),
  notes: z.array(z.string()),
});
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;

export interface EvaluationInput {
  readonly fixture: Fixture;
  readonly events: readonly InvestigationEvent[];
  readonly report?: Report;
}

export interface Evaluator {
  readonly name: string;
  evaluate(input: EvaluationInput): Promise<EvaluationResult>;
}
