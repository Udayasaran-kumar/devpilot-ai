import { z } from 'zod';
import {
  CommandExecutionResultSchema,
  createEvidenceId,
  EvidenceIdSchema,
  formatCommandLine,
  type CommandExecutionResult,
  type Evidence,
  type EvidenceLocation,
} from '@devpilot/core';
import { MAX_COMMAND_ARG_LENGTH, MAX_COMMAND_ARGS } from './command-policy.js';
import { MAX_COMMAND_TIMEOUT_MS, type RepositorySandbox } from './sandbox.js';
import type { Tool, ToolContext } from './tool.js';
import { sandboxErrorResult } from './tool-result.js';

export const RUN_COMMAND_TOOL_NAME = 'run_command';

export const RunCommandInputSchema = z.object({
  command: z.string().min(1).max(256),
  args: z.array(z.string().max(MAX_COMMAND_ARG_LENGTH)).max(MAX_COMMAND_ARGS),
  cwd: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1).max(MAX_COMMAND_TIMEOUT_MS).optional(),
});
export type RunCommandInput = z.infer<typeof RunCommandInputSchema>;

export const RunCommandOutputSchema = CommandExecutionResultSchema.extend({
  evidenceIds: z.array(EvidenceIdSchema),
});
export type RunCommandOutput = z.infer<typeof RunCommandOutputSchema>;

export function createRunCommandTool(sandbox: RepositorySandbox): Tool<RunCommandInput, RunCommandOutput> {
  return {
    name: RUN_COMMAND_TOOL_NAME,
    description:
      `Run an allowlisted command (allowed: ${sandbox.allowedCommands.join(', ') || 'none'}) as an argv array, ` +
      'without a shell, inside the repository. Returns the exit code, captured stdout/stderr (truncated per ' +
      `stream), and whether it timed out (default 10s, max ${MAX_COMMAND_TIMEOUT_MS / 1000}s).`,
    inputSchema: RunCommandInputSchema,
    outputSchema: RunCommandOutputSchema,
    async run(input, context) {
      let result: CommandExecutionResult;
      try {
        result = await sandbox.runCommand({
          command: input.command,
          args: input.args,
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        });
      } catch (error) {
        return sandboxErrorResult(error);
      }

      const evidence = createCommandEvidence(result, context);
      return {
        status: 'success',
        output: { ...result, evidenceIds: [evidence.id] },
        evidence: [evidence],
      };
    },
  };
}

/** One evidence item for the observable result. Duration is excluded so identical runs share an ID. */
function createCommandEvidence(result: CommandExecutionResult, context: ToolContext): Evidence {
  const commandLine = formatCommandLine(result.command, result.args);
  const location: EvidenceLocation = {
    type: 'command',
    command: commandLine,
    ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
  };
  const content = renderObservation(commandLine, result);
  return {
    id: createEvidenceId({ tool: RUN_COMMAND_TOOL_NAME, location, content }),
    kind: 'command_output',
    summary: summarize(commandLine, result),
    content,
    location,
    source: { tool: RUN_COMMAND_TOOL_NAME, actionId: context.actionId },
    collectedAt: context.now(),
  };
}

function summarize(commandLine: string, result: CommandExecutionResult): string {
  const subject = `"${commandLine}"`;
  if (result.startError !== null) return `${subject} could not be started`;
  if (result.timedOut) return `${subject} timed out`;
  if (result.exitCode === null) return `${subject} was terminated by ${result.signal ?? 'a signal'}`;
  return `${subject} exited with code ${result.exitCode}`;
}

function renderObservation(commandLine: string, result: CommandExecutionResult): string {
  return [
    `$ ${commandLine}`,
    `cwd: ${result.cwd}`,
    `exit code: ${result.exitCode ?? 'none'}`,
    `signal: ${result.signal ?? 'none'}`,
    `timed out: ${result.timedOut}`,
    ...(result.startError !== null ? [`start error: ${result.startError}`] : []),
    `--- stdout${result.stdoutTruncated ? ' (truncated)' : ''} ---`,
    result.stdout,
    `--- stderr${result.stderrTruncated ? ' (truncated)' : ''} ---`,
    result.stderr,
  ].join('\n');
}
