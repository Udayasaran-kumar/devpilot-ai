import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { formatCommandLine, SignalSchema, type Signal } from '@devpilot/core';
import { GroundedRepairPipeline } from '@devpilot/engine';
import type { GitExecutable, HostEnvironment } from '@devpilot/tools';
import {
  InvestigationResultSchema,
  JobLookupInputSchema,
  JobViewSchema,
  parseInput,
  ServiceError,
  StartInvestigationInputSchema,
  type InvestigationResult,
  type JobId,
  type JobStatus,
  type JobView,
  type RepositoryId,
  type RepositoryView,
  type SignalInput,
} from './contracts.js';
import { projectOutcome, retainReport, type RetainedReport } from './projection.js';
import type { RegisteredRepository, RepositoryRegistry } from './registry.js';

/** Trusted configuration from whoever runs the service; callers of the service cannot set any of it. */
export interface InvestigationServiceOptions {
  readonly registry: RepositoryRegistry;
  readonly git?: GitExecutable;
  readonly hostEnvironment?: HostEnvironment;
  /** Epoch milliseconds. */
  readonly clock?: () => number;
}

interface Job {
  readonly id: JobId;
  readonly repository: RegisteredRepository;
  readonly createdAt: string;
  status: JobStatus;
  finishedAt?: string;
  failureReason?: string;
  retained?: RetainedReport;
  notes: string[];
  hostPaths: string[];
  done?: Promise<void>;
}

const WORKTREE_REMOVED = 'DevPilot removed the verification worktree after the run; the patch was not applied to the repository.';
const WORKTREE_NOT_REMOVED = 'DevPilot could not remove the verification worktree after the run; the patch was not applied to the repository.';
const RUN_FAILED = 'The investigation could not be run for this repository.';

/**
 * Transport-free orchestration over `GroundedRepairPipeline`: it resolves a
 * registered repository, builds the signal itself, runs one pipeline job per
 * repository at a time, and projects only grounded results. It never runs
 * commands, applies patches, or starts the repair workflow on its own; the
 * pipeline does all of that.
 */
export class InvestigationService {
  readonly #registry: RepositoryRegistry;
  readonly #options: InvestigationServiceOptions;
  readonly #clock: () => number;
  readonly #jobs = new Map<JobId, Job>();
  readonly #active = new Map<RepositoryId, JobId>();

  constructor(options: InvestigationServiceOptions) {
    this.#registry = options.registry;
    this.#options = options;
    this.#clock = options.clock ?? Date.now;
  }

  listRepositories(): RepositoryView[] {
    return this.#registry.list();
  }

  /**
   * Validates the input, queues a job, and starts it in the background. Refuses
   * a repository that already has a queued or running job.
   */
  startInvestigation(input: unknown): JobView {
    const { repositoryId, signal: described } = parseInput(StartInvestigationInputSchema, input);
    const repository = this.#registry.resolve(repositoryId);
    if (!repository) throw new ServiceError('unknown_repository', `No repository is registered as ${repositoryId}`);
    const description = described ?? repository.defaultSignal;
    if (!description) throw new ServiceError('signal_required', `Repository ${repositoryId} has no default signal; describe the failure`);
    if (this.#active.has(repositoryId)) {
      throw new ServiceError('repository_busy', `Repository ${repositoryId} already has an investigation in progress`);
    }

    const job: Job = { id: `job-${randomUUID()}`, repository, createdAt: this.#now(), status: 'queued', notes: [], hostPaths: [] };
    const signal = buildSignal(description, repository, `sig-${randomUUID()}`, job.createdAt);
    this.#jobs.set(job.id, job);
    this.#active.set(repositoryId, job.id);
    job.done = this.#execute(job, signal);
    return viewOf(job);
  }

  getJob(input: unknown): JobView {
    return viewOf(this.#job(input));
  }

  /** The job and, once it has completed, its projected outcome. */
  getResult(input: unknown): InvestigationResult {
    const job = this.#job(input);
    const outcome =
      job.status === 'completed' && job.retained
        ? projectOutcome(job.retained, { displayName: job.repository.displayName, hostPaths: job.hostPaths, notes: job.notes })
        : null;
    return InvestigationResultSchema.parse({ job: viewOf(job), outcome });
  }

  /** Resolves once the job has completed or failed. */
  async waitForJob(input: unknown): Promise<JobView> {
    const job = this.#job(input);
    await job.done;
    return viewOf(job);
  }

  #job(input: unknown): Job {
    const { jobId } = parseInput(JobLookupInputSchema, input);
    const job = this.#jobs.get(jobId);
    if (!job) throw new ServiceError('unknown_job', `No job ${jobId}`);
    return job;
  }

  async #execute(job: Job, signal: Signal): Promise<void> {
    const { repository } = job;
    try {
      await Promise.resolve();
      job.status = 'running';
      job.hostPaths = await hostPathsOf(repository);
      const { git, hostEnvironment } = this.#options;
      const pipeline = new GroundedRepairPipeline({
        allowedRoot: repository.allowedRoot,
        clock: this.#clock,
        ...(git ? { git } : {}),
        ...(hostEnvironment ? { hostEnvironment } : {}),
      });
      const run = await pipeline.run({ repositoryRoot: repository.repositoryRoot, signal });
      const workspace = run.repair?.workspace;
      if (workspace) {
        try {
          await workspace.remove();
          job.notes.push(WORKTREE_REMOVED);
        } catch {
          job.notes.push(WORKTREE_NOT_REMOVED);
        }
      }
      job.retained = retainReport(run);
      job.status = 'completed';
    } catch {
      job.status = 'failed';
      job.failureReason = RUN_FAILED;
    } finally {
      job.finishedAt = this.#now();
      this.#active.delete(repository.repositoryId);
    }
  }

  #now(): string {
    return new Date(this.#clock()).toISOString();
  }
}

/** The internal signal: the caller's description plus fields only the service sets. The repository root is not included. */
export function buildSignal(description: SignalInput, repository: RegisteredRepository, id: string, receivedAt: string): Signal {
  return SignalSchema.parse({
    id,
    kind: description.kind,
    title: description.title,
    content: description.content,
    command: formatCommandLine(repository.command, repository.args),
    receivedAt,
    metadata: { repositoryId: repository.repositoryId },
  });
}

function viewOf(job: Job): JobView {
  return JobViewSchema.parse({
    jobId: job.id,
    repositoryId: job.repository.repositoryId,
    status: job.status,
    createdAt: job.createdAt,
    ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
    ...(job.failureReason !== undefined ? { failureReason: job.failureReason } : {}),
  });
}

async function hostPathsOf(repository: RegisteredRepository): Promise<string[]> {
  const declared = [repository.repositoryRoot, repository.allowedRoot, homedir()];
  const real = await Promise.all(declared.map((item) => realpath(item).catch(() => item)));
  return [...new Set([...declared, ...real])];
}
