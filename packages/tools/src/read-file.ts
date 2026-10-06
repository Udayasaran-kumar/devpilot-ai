import { z } from 'zod';
import { createEvidenceId, EvidenceIdSchema, type Evidence, type EvidenceLocation } from '@devpilot/core';
import type { RepositorySandbox } from './sandbox.js';
import { splitLines } from './text.js';
import type { Tool } from './tool.js';
import { sandboxErrorResult } from './tool-result.js';

export const READ_FILE_TOOL_NAME = 'read_file';

const LineNumberSchema = z.number().int().positive();

export const ReadFileInputSchema = z
  .object({
    path: z.string().min(1),
    startLine: LineNumberSchema.optional(),
    endLine: LineNumberSchema.optional(),
  })
  .refine((input) => input.startLine === undefined || input.endLine === undefined || input.endLine >= input.startLine, {
    message: 'endLine must be greater than or equal to startLine',
    path: ['endLine'],
  });
export type ReadFileInput = z.infer<typeof ReadFileInputSchema>;

export const ReadFileOutputSchema = z.object({
  path: z.string().min(1),
  requestedRange: z
    .object({
      startLine: LineNumberSchema.optional(),
      endLine: LineNumberSchema.optional(),
    })
    .optional(),
  /** Lines actually returned; null for an empty file. `endLine` is clamped to the end of the file. */
  returnedRange: z.object({ startLine: LineNumberSchema, endLine: LineNumberSchema }).nullable(),
  totalLines: z.number().int().nonnegative(),
  content: z.string(),
  evidenceIds: z.array(EvidenceIdSchema),
});
export type ReadFileOutput = z.infer<typeof ReadFileOutputSchema>;

export function createReadFileTool(sandbox: RepositorySandbox): Tool<ReadFileInput, ReadFileOutput> {
  return {
    name: READ_FILE_TOOL_NAME,
    description:
      'Read a UTF-8 text file from the repository, optionally limited to an inclusive 1-based line range. ' +
      'Paths are relative to the repository root.',
    inputSchema: ReadFileInputSchema,
    outputSchema: ReadFileOutputSchema,
    async run(input, context) {
      let file;
      try {
        file = await sandbox.readFile(input.path);
      } catch (error) {
        return sandboxErrorResult(error);
      }

      const lines = splitLines(file.content);
      const totalLines = lines.length;
      const startLine = input.startLine ?? 1;
      if (input.startLine !== undefined && startLine > totalLines) {
        return {
          status: 'error',
          error: `startLine ${startLine} is beyond the end of ${file.path} (${totalLines} lines)`,
        };
      }
      const endLine = Math.min(input.endLine ?? totalLines, totalLines);
      const content = lines.slice(startLine - 1, endLine).join('\n');
      const returnedRange = totalLines === 0 ? null : { startLine, endLine };

      const location: EvidenceLocation = returnedRange
        ? { type: 'file', path: file.path, ...returnedRange }
        : { type: 'file', path: file.path };
      const evidence: Evidence = {
        id: createEvidenceId({ tool: READ_FILE_TOOL_NAME, location, content }),
        kind: 'source_code',
        summary: returnedRange
          ? `${file.path} lines ${returnedRange.startLine}-${returnedRange.endLine}`
          : `${file.path} (empty file)`,
        content,
        location,
        source: { tool: READ_FILE_TOOL_NAME, actionId: context.actionId },
        collectedAt: context.now(),
      };

      const requestedRange =
        input.startLine !== undefined || input.endLine !== undefined
          ? {
              ...(input.startLine !== undefined ? { startLine: input.startLine } : {}),
              ...(input.endLine !== undefined ? { endLine: input.endLine } : {}),
            }
          : undefined;

      return {
        status: 'success',
        output: {
          path: file.path,
          ...(requestedRange ? { requestedRange } : {}),
          returnedRange,
          totalLines,
          content,
          evidenceIds: [evidence.id],
        },
        evidence: [evidence],
      };
    },
  };
}
