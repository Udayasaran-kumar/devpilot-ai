import { z } from 'zod';
import { createEvidenceId, EvidenceIdSchema, type Evidence, type EvidenceLocation } from '@devpilot/core';
import { MAX_SEARCH_RESULTS, type RepositorySandbox } from './sandbox.js';
import type { Tool } from './tool.js';
import { sandboxErrorResult } from './tool-result.js';

export const SEARCH_CODE_TOOL_NAME = 'search_code';

export const SearchCodeInputSchema = z.object({
  query: z.string().min(1).max(1000),
  path: z.string().min(1).optional(),
  maxResults: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
});
export type SearchCodeInput = z.infer<typeof SearchCodeInputSchema>;

export const SearchCodeOutputSchema = z.object({
  query: z.string().min(1),
  /** Repository-relative scope that was searched; `.` for the whole repository. */
  path: z.string().min(1),
  matches: z.array(
    z.object({
      path: z.string().min(1),
      line: z.number().int().positive(),
      column: z.number().int().positive(),
      text: z.string(),
      evidenceId: EvidenceIdSchema,
    }),
  ),
  truncated: z.boolean(),
  filesSearched: z.number().int().nonnegative(),
  filesSkipped: z.number().int().nonnegative(),
});
export type SearchCodeOutput = z.infer<typeof SearchCodeOutputSchema>;

export function createSearchCodeTool(sandbox: RepositorySandbox): Tool<SearchCodeInput, SearchCodeOutput> {
  return {
    name: SEARCH_CODE_TOOL_NAME,
    description:
      'Case-sensitive literal text search across UTF-8 files in the repository, optionally scoped to a file or ' +
      `directory. Returns at most one match per line and at most ${MAX_SEARCH_RESULTS} matches. ` +
      'Binary files, symlinks, .git, and node_modules are skipped.',
    inputSchema: SearchCodeInputSchema,
    outputSchema: SearchCodeOutputSchema,
    async run(input, context) {
      let result;
      try {
        result = await sandbox.search(input.query, {
          ...(input.path !== undefined ? { path: input.path } : {}),
          ...(input.maxResults !== undefined ? { maxResults: input.maxResults } : {}),
        });
      } catch (error) {
        return sandboxErrorResult(error);
      }

      const collectedAt = context.now();
      const evidence: Evidence[] = [];
      const matches = result.matches.map((match) => {
        const location: EvidenceLocation = {
          type: 'file',
          path: match.path,
          startLine: match.line,
          endLine: match.line,
        };
        const item: Evidence = {
          id: createEvidenceId({ tool: SEARCH_CODE_TOOL_NAME, location, content: match.text }),
          kind: 'search_result',
          summary: `${match.path}:${match.line} contains "${input.query}"`,
          content: match.text,
          location,
          source: { tool: SEARCH_CODE_TOOL_NAME, actionId: context.actionId },
          collectedAt,
        };
        evidence.push(item);
        return { ...match, evidenceId: item.id };
      });

      return {
        status: 'success',
        output: {
          query: input.query,
          path: result.scope,
          matches,
          truncated: result.truncated,
          filesSearched: result.filesSearched,
          filesSkipped: result.filesSkipped,
        },
        evidence,
      };
    },
  };
}
