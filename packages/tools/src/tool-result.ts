import type { JsonValue } from '@devpilot/core';
import { SandboxError } from './sandbox.js';
import type { ToolResult } from './tool.js';

/** Converts expected sandbox failures into tool errors; unexpected errors propagate to the engine. */
export function sandboxErrorResult<TOutput extends JsonValue>(error: unknown): ToolResult<TOutput> {
  if (error instanceof SandboxError) {
    return { status: 'error', error: error.message };
  }
  throw error;
}
