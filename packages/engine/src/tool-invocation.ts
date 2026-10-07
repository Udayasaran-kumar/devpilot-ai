import { z } from 'zod';
import type { Evidence, InvestigationAction, JsonValue } from '@devpilot/core';
import { ToolResultSchema, type ToolRegistry } from '@devpilot/tools';

export type ToolOutcome =
  | { readonly ok: true; readonly output: JsonValue; readonly evidence: Evidence[] }
  | { readonly ok: false; readonly error: string };

export interface ToolInvocationContext {
  readonly investigationId: string;
  /** Current time as an ISO-8601 string. */
  now(): string;
}

/**
 * Runs one action's tool the way every engine component must: validate the
 * input, run it, validate the result envelope and the tool's output, and stamp
 * evidence with the tool name and action ID. Never throws for tool failures.
 */
export async function invokeTool(
  tools: ToolRegistry,
  action: InvestigationAction,
  context: ToolInvocationContext,
): Promise<ToolOutcome> {
  const tool = tools.get(action.tool);
  if (!tool) {
    return { ok: false, error: `Unknown tool "${action.tool}"` };
  }

  const input = tool.inputSchema.safeParse(action.input);
  if (!input.success) {
    return { ok: false, error: `Invalid input for tool "${tool.name}": ${z.prettifyError(input.error)}` };
  }
  const parsed = input.data as Record<string, unknown>;
  const unknown = Object.keys(action.input).filter((key) => action.input[key] !== undefined && !(key in parsed));
  if (unknown.length > 0) {
    return { ok: false, error: `Invalid input for tool "${tool.name}": unknown field(s) ${unknown.join(', ')}` };
  }

  let result: z.infer<typeof ToolResultSchema>;
  try {
    result = ToolResultSchema.parse(
      await tool.run(input.data, { investigationId: context.investigationId, actionId: action.id, now: context.now }),
    );
  } catch (error) {
    return { ok: false, error: `Tool "${tool.name}" failed: ${describeError(error)}` };
  }
  if (result.status === 'error') {
    return { ok: false, error: result.error };
  }

  const output = tool.outputSchema.safeParse(result.output);
  if (!output.success) {
    return { ok: false, error: `Invalid output from tool "${tool.name}": ${z.prettifyError(output.error)}` };
  }

  return {
    ok: true,
    output: output.data,
    evidence: result.evidence.map((item) => ({ ...item, source: { tool: tool.name, actionId: action.id } })),
  };
}

export function describeError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return z.prettifyError(error);
  }
  return error instanceof Error ? error.message : String(error);
}
