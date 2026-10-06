import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.js';

export const SignalKindSchema = z.enum([
  'failing_test',
  'ci_failure',
  'stack_trace',
  'bug_report',
  'log_output',
]);
export type SignalKind = z.infer<typeof SignalKindSchema>;

export const SignalSchema = z.object({
  id: IdSchema,
  kind: SignalKindSchema,
  title: z.string().min(1),
  /** Raw failure payload exactly as received (test output, stack trace, bug text, ...). */
  content: z.string().min(1),
  repository: z
    .object({
      path: z.string().min(1),
      ref: z.string().min(1).optional(),
    })
    .optional(),
  /** Command that reproduces the failure, when the reporter knows it. */
  command: z.string().min(1).optional(),
  receivedAt: TimestampSchema,
  metadata: z.record(z.string(), z.string()).optional(),
});
export type Signal = z.infer<typeof SignalSchema>;
