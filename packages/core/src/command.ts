import { z } from 'zod';

export const CommandExecutionResultSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  /** Working directory relative to the repository root; `.` for the root. */
  cwd: z.string().min(1),
  /** Null when the process timed out, was killed by a signal, or never started. */
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  /** Why the process could not be started; null when it ran. */
  startError: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
  stdout: z.string(),
  stderr: z.string(),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
});
export type CommandExecutionResult = z.infer<typeof CommandExecutionResultSchema>;

const PLAIN_ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Human-readable command line for summaries and evidence locations. It is never executed. */
export function formatCommandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map((part) => (PLAIN_ARGUMENT.test(part) ? part : JSON.stringify(part))).join(' ');
}
