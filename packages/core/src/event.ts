import { z } from 'zod';
import { IdSchema, JsonValueSchema, TimestampSchema } from './common.js';
import { InvestigationActionSchema } from './action.js';
import { EvidenceSchema } from './evidence.js';
import { HypothesisSchema } from './hypothesis.js';
import { SignalSchema } from './signal.js';
import { VerificationResultSchema } from './verification.js';

export const InvestigationBudgetSchema = z.object({
  maxSteps: z.number().int().positive(),
  maxDurationMs: z.number().int().positive(),
});
export type InvestigationBudget = z.infer<typeof InvestigationBudgetSchema>;

export const TerminalStatusSchema = z.enum([
  'completed',
  'step_budget_exhausted',
  'time_budget_exhausted',
  'failed',
]);
export type TerminalStatus = z.infer<typeof TerminalStatusSchema>;

const eventBase = {
  investigationId: IdSchema,
  /** Zero-based, gapless position of the event within its investigation. */
  sequence: z.number().int().nonnegative(),
  timestamp: TimestampSchema,
};

export const InvestigationStartedEventSchema = z.object({
  ...eventBase,
  type: z.literal('investigation_started'),
  signal: SignalSchema,
  budget: InvestigationBudgetSchema,
});

export const ActionPlannedEventSchema = z.object({
  ...eventBase,
  type: z.literal('action_planned'),
  action: InvestigationActionSchema,
});

export const ActionCompletedEventSchema = z.object({
  ...eventBase,
  type: z.literal('action_completed'),
  actionId: IdSchema,
  output: JsonValueSchema,
  evidence: z.array(EvidenceSchema),
});

export const ActionFailedEventSchema = z.object({
  ...eventBase,
  type: z.literal('action_failed'),
  actionId: IdSchema,
  error: z.string().min(1),
});

export const HypothesesUpdatedEventSchema = z.object({
  ...eventBase,
  type: z.literal('hypotheses_updated'),
  hypotheses: z.array(HypothesisSchema).min(1),
});

export const VerificationRecordedEventSchema = z.object({
  ...eventBase,
  type: z.literal('verification_recorded'),
  verification: VerificationResultSchema,
});

export const InvestigationCompletedEventSchema = z.object({
  ...eventBase,
  type: z.literal('investigation_completed'),
  status: TerminalStatusSchema,
  reason: z.string().min(1),
});

export const InvestigationEventSchema = z.discriminatedUnion('type', [
  InvestigationStartedEventSchema,
  ActionPlannedEventSchema,
  ActionCompletedEventSchema,
  ActionFailedEventSchema,
  HypothesesUpdatedEventSchema,
  VerificationRecordedEventSchema,
  InvestigationCompletedEventSchema,
]);
export type InvestigationEvent = z.infer<typeof InvestigationEventSchema>;
export type InvestigationEventType = InvestigationEvent['type'];
