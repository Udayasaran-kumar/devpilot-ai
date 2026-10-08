import { z } from 'zod';
import { GroundedClaimSchema, IdSchema, ReportRepairStatusSchema, SignalKindSchema, TimestampSchema } from '@devpilot/core';

export const MAX_SIGNAL_TITLE_LENGTH = 200;
export const MAX_SIGNAL_CONTENT_LENGTH = 16 * 1024;
export const MAX_DISPLAY_NAME_LENGTH = 100;

/** Opaque, server-assigned name for a registered repository. It is not a path. */
export const RepositoryIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'Repository IDs are 1-64 lowercase letters, digits, or hyphens');
export type RepositoryId = z.infer<typeof RepositoryIdSchema>;

export const JobIdSchema = z.string().regex(/^job-[0-9a-f-]{36}$/, 'Unknown job ID format');
export type JobId = z.infer<typeof JobIdSchema>;

/**
 * The parts of a signal a caller may describe. Everything else a `Signal`
 * carries (ID, time received, repository, command) is set by the service.
 */
export const SignalInputSchema = z.strictObject({
  kind: SignalKindSchema,
  title: z.string().trim().min(1).max(MAX_SIGNAL_TITLE_LENGTH),
  content: z.string().min(1).max(MAX_SIGNAL_CONTENT_LENGTH),
});
export type SignalInput = z.infer<typeof SignalInputSchema>;

/** Strict: repository roots, commands, planners, budgets, and every other field are refused as unrecognized keys. */
export const StartInvestigationInputSchema = z.strictObject({
  repositoryId: RepositoryIdSchema,
  signal: SignalInputSchema.optional(),
});
export type StartInvestigationInput = z.infer<typeof StartInvestigationInputSchema>;

export const JobLookupInputSchema = z.strictObject({ jobId: JobIdSchema });
export type JobLookupInput = z.infer<typeof JobLookupInputSchema>;

export const JobStatusSchema = z.enum(['queued', 'running', 'completed', 'failed']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const RepositoryViewSchema = z.strictObject({
  repositoryId: RepositoryIdSchema,
  displayName: z.string().min(1),
  /** The verification command line, e.g. `npm test`. */
  command: z.string().min(1),
});
export type RepositoryView = z.infer<typeof RepositoryViewSchema>;

export const JobViewSchema = z.strictObject({
  jobId: JobIdSchema,
  repositoryId: RepositoryIdSchema,
  status: JobStatusSchema,
  createdAt: TimestampSchema,
  finishedAt: TimestampSchema.optional(),
  /** Why a `failed` job did not produce a report. Generic: internal errors are not exposed. */
  failureReason: z.string().min(1).optional(),
});
export type JobView = z.infer<typeof JobViewSchema>;

export const ProjectedFailureSchema = z.strictObject({
  testFile: z.string().min(1),
  suite: z.array(z.string()),
  testName: z.string().min(1),
});
export type ProjectedFailure = z.infer<typeof ProjectedFailureSchema>;

/**
 * A completed job's report, reduced to what a client may see. Claims,
 * failures, and files appear only when the report passed grounding
 * validation; otherwise the outcome says there is no verified result.
 */
export const InvestigationOutcomeSchema = z
  .strictObject({
    investigationId: IdSchema,
    groundingValid: z.boolean(),
    /** The repair workflow's status; null when the report is not grounded. */
    repairStatus: ReportRepairStatusSchema.nullable(),
    claims: z.array(GroundedClaimSchema),
    baselineFailures: z.array(ProjectedFailureSchema),
    affectedFiles: z.array(z.string().min(1)),
    limitations: z.array(z.string().min(1)),
    spokenSummary: z.string().min(1),
  })
  .superRefine((outcome, context) => {
    if (outcome.groundingValid) return;
    if (outcome.repairStatus !== null || outcome.claims.length > 0 || outcome.baselineFailures.length > 0 || outcome.affectedFiles.length > 0) {
      context.addIssue({ code: 'custom', message: 'An ungrounded outcome carries no status, claims, failures, or files' });
    }
  });
export type InvestigationOutcome = z.infer<typeof InvestigationOutcomeSchema>;

export const InvestigationResultSchema = z.strictObject({
  job: JobViewSchema,
  /** Null until the job has completed. */
  outcome: InvestigationOutcomeSchema.nullable(),
});
export type InvestigationResult = z.infer<typeof InvestigationResultSchema>;

export type ServiceErrorCode = 'invalid_input' | 'unknown_repository' | 'repository_busy' | 'signal_required' | 'unknown_job' | 'invalid_registration';

/** A refused service call. Messages never contain host paths. */
export class ServiceError extends Error {
  override readonly name = 'ServiceError';
  readonly code: ServiceErrorCode;

  constructor(code: ServiceErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Parses caller input, turning schema errors into an `invalid_input` ServiceError. */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ServiceError('invalid_input', z.prettifyError(parsed.error));
  return parsed.data;
}
