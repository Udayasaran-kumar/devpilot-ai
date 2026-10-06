import type { JsonValue } from '@devpilot/core';
import { TOOL_NAME_PATTERN, type Tool, type ToolDescriptor, type ToolInput } from './tool.js';

export interface ToolRegistry {
  register<TInput extends ToolInput, TOutput extends JsonValue>(tool: Tool<TInput, TOutput>): this;
  get(name: string): Tool | undefined;
  has(name: string): boolean;
  list(): readonly Tool[];
  describe(): readonly ToolDescriptor[];
}

export class InMemoryToolRegistry implements ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  constructor(tools: readonly Tool[] = []) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  register<TInput extends ToolInput, TOutput extends JsonValue>(tool: Tool<TInput, TOutput>): this {
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      throw new Error(`Invalid tool name "${tool.name}": must match ${TOOL_NAME_PATTERN}`);
    }
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.#tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  list(): readonly Tool[] {
    return [...this.#tools.values()];
  }

  describe(): readonly ToolDescriptor[] {
    return this.list().map(({ name, description }) => ({ name, description }));
  }
}
