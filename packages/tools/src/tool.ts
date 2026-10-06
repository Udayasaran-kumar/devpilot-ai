import { z } from 'zod';
import {
  EvidenceSchema,
  JsonObjectSchema,
  JsonValueSchema,
  type Evidence,
  type JsonObject,
  type JsonValue,
} from '@devpilot/core';

/** Tool inputs are JSON objects so actions stay serializable in the event log. */
export const ToolInputSchema = JsonObjectSchema;
export type ToolInput = JsonObject;

export interface ToolContext {
  readonly investigationId: string;
  readonly actionId: string;
  /** Current time as an ISO-8601 string, supplied by the engine clock. */
  now(): string;
}

export type ToolResult<TOutput extends JsonValue = JsonValue> =
  | {
      readonly status: 'success';
      readonly output: TOutput;
      readonly evidence: readonly Evidence[];
    }
  | {
      readonly status: 'error';
      readonly error: string;
    };

/** Validates the result envelope; the tool's own `outputSchema` validates `output`. */
export const ToolResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    output: JsonValueSchema,
    evidence: z.array(EvidenceSchema),
  }),
  z.object({
    status: z.literal('error'),
    error: z.string().min(1),
  }),
]);

export const TOOL_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export interface Tool<TInput extends ToolInput = ToolInput, TOutput extends JsonValue = JsonValue> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TOutput>;
  run(input: TInput, context: ToolContext): Promise<ToolResult<TOutput>>;
}

export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
}
