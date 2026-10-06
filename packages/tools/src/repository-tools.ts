import { createListFilesTool } from './list-files.js';
import { createReadFileTool } from './read-file.js';
import { InMemoryToolRegistry } from './registry.js';
import { createRunCommandTool } from './run-command.js';
import type { RepositorySandbox } from './sandbox.js';
import { createSearchCodeTool } from './search-code.js';
import type { Tool } from './tool.js';

export function createRepositoryTools(sandbox: RepositorySandbox): Tool[] {
  return [
    createReadFileTool(sandbox),
    createSearchCodeTool(sandbox),
    createListFilesTool(sandbox),
    createRunCommandTool(sandbox),
  ];
}

/** Registry containing the repository tools, all bound to one sandbox. */
export function createDefaultToolRegistry(sandbox: RepositorySandbox): InMemoryToolRegistry {
  return new InMemoryToolRegistry(createRepositoryTools(sandbox));
}
