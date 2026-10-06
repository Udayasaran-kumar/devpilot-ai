import { z } from 'zod';
import { MAX_LIST_RESULTS, type RepositorySandbox } from './sandbox.js';
import type { Tool } from './tool.js';
import { sandboxErrorResult } from './tool-result.js';

export const LIST_FILES_TOOL_NAME = 'list_files';

export const ListFilesInputSchema = z.object({
  path: z.string().min(1).optional(),
  maxResults: z.number().int().min(1).max(MAX_LIST_RESULTS).optional(),
});
export type ListFilesInput = z.infer<typeof ListFilesInputSchema>;

export const ListFilesOutputSchema = z.object({
  /** Repository-relative directory that was listed; `.` for the repository root. */
  path: z.string().min(1),
  entries: z.array(
    z.object({
      path: z.string().min(1),
      type: z.enum(['file', 'directory', 'symlink']),
    }),
  ),
  truncated: z.boolean(),
});
export type ListFilesOutput = z.infer<typeof ListFilesOutputSchema>;

export function createListFilesTool(sandbox: RepositorySandbox): Tool<ListFilesInput, ListFilesOutput> {
  return {
    name: LIST_FILES_TOOL_NAME,
    description:
      'Recursively list files and directories under a repository directory (default: the root), sorted by path ' +
      `segment, up to ${MAX_LIST_RESULTS} entries. Symlinks are listed but not followed; .git and node_modules ` +
      'are skipped.',
    inputSchema: ListFilesInputSchema,
    outputSchema: ListFilesOutputSchema,
    async run(input) {
      let result;
      try {
        result = await sandbox.listFiles({
          ...(input.path !== undefined ? { path: input.path } : {}),
          ...(input.maxResults !== undefined ? { maxResults: input.maxResults } : {}),
        });
      } catch (error) {
        return sandboxErrorResult(error);
      }
      return {
        status: 'success',
        output: { path: result.scope, entries: result.entries, truncated: result.truncated },
        evidence: [],
      };
    },
  };
}
