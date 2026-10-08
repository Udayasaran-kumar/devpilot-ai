import path from 'node:path';
import { z } from 'zod';
import { formatCommandLine } from '@devpilot/core';
import { DEFAULT_COMMAND_POLICY } from '@devpilot/tools';
import {
  MAX_DISPLAY_NAME_LENGTH,
  RepositoryIdSchema,
  ServiceError,
  SignalInputSchema,
  type RepositoryId,
  type RepositoryView,
  type SignalInput,
} from './contracts.js';

const AbsolutePathSchema = z.string().min(1).refine((value) => path.isAbsolute(value), 'Must be an absolute path');

/**
 * Trusted, server-side configuration for one repository. It is supplied by
 * whoever runs the service, never by a caller of the service.
 */
export const RepositoryRegistrationSchema = z.strictObject({
  repositoryId: RepositoryIdSchema,
  displayName: z.string().trim().min(1).max(MAX_DISPLAY_NAME_LENGTH),
  repositoryRoot: AbsolutePathSchema,
  /** The repository must be inside this directory. Defaults to the repository root. */
  allowedRoot: AbsolutePathSchema.optional(),
  /** The command the investigation reproduces and the repair workflow verifies, as argv. */
  verification: z.strictObject({
    command: z.string().min(1),
    args: z.array(z.string()),
  }),
  /** The signal used when a caller starts an investigation without describing one. */
  defaultSignal: SignalInputSchema.optional(),
});
export type RepositoryRegistration = z.input<typeof RepositoryRegistrationSchema>;

/** A registered repository as the service uses it internally. Holds host paths: never returned to callers. */
export interface RegisteredRepository {
  readonly repositoryId: RepositoryId;
  readonly displayName: string;
  readonly repositoryRoot: string;
  readonly allowedRoot: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly defaultSignal?: SignalInput;
}

export class RepositoryRegistry {
  readonly #repositories = new Map<RepositoryId, RegisteredRepository>();

  /** Registers a repository; the command must pass the default command policy the pipeline applies. */
  register(registration: RepositoryRegistration): RepositoryView {
    const parsed = RepositoryRegistrationSchema.safeParse(registration);
    if (!parsed.success) throw new ServiceError('invalid_registration', z.prettifyError(parsed.error));
    const { repositoryId, displayName, verification, defaultSignal } = parsed.data;
    const repositoryRoot = path.resolve(parsed.data.repositoryRoot);
    const allowedRoot = path.resolve(parsed.data.allowedRoot ?? repositoryRoot);
    const relative = path.relative(allowedRoot, repositoryRoot);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new ServiceError('invalid_registration', `Repository ${repositoryId} is not inside its allowed root`);
    }
    const decision = DEFAULT_COMMAND_POLICY.check(verification.command, verification.args);
    if (!decision.allowed) throw new ServiceError('invalid_registration', `Repository ${repositoryId}: ${decision.reason}`);
    if (this.#repositories.has(repositoryId)) {
      throw new ServiceError('invalid_registration', `Repository ${repositoryId} is already registered`);
    }
    const repository: RegisteredRepository = {
      repositoryId,
      displayName,
      repositoryRoot,
      allowedRoot,
      command: verification.command,
      args: [...verification.args],
      ...(defaultSignal ? { defaultSignal } : {}),
    };
    this.#repositories.set(repositoryId, repository);
    return viewOf(repository);
  }

  list(): RepositoryView[] {
    return [...this.#repositories.values()].map(viewOf);
  }

  /** Internal lookup for the service; the result includes host paths. */
  resolve(repositoryId: RepositoryId): RegisteredRepository | undefined {
    return this.#repositories.get(repositoryId);
  }
}

function viewOf(repository: RegisteredRepository): RepositoryView {
  return {
    repositoryId: repository.repositoryId,
    displayName: repository.displayName,
    command: formatCommandLine(repository.command, repository.args),
  };
}
