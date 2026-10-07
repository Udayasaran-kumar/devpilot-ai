import { createApplyPatchTool } from './apply-patch.js';
import { createListFilesTool } from './list-files.js';
import { createReadFileTool } from './read-file.js';
import { InMemoryToolRegistry } from './registry.js';
import { createRunCommandTool } from './run-command.js';
import type { RepositorySandbox } from './sandbox.js';
import { createSearchCodeTool } from './search-code.js';
import type { Tool } from './tool.js';
import type { GitWorktreeWorkspace } from './worktree-workspace.js';

export function createRepositoryTools(sandbox: RepositorySandbox): Tool[] {
  return [
    createReadFileTool(sandbox),
    createSearchCodeTool(sandbox),
    createListFilesTool(sandbox),
    createRunCommandTool(sandbox),
  ];
}

/** Registry containing the repository tools, all bound to one sandbox. Read-only: no apply_patch. */
export function createDefaultToolRegistry(sandbox: RepositorySandbox): InMemoryToolRegistry {
  return new InMemoryToolRegistry(createRepositoryTools(sandbox));
}

/** The repository tools bound to a worktree, plus apply_patch. The only way apply_patch is registered. */
export function createWorkspaceTools(workspace: GitWorktreeWorkspace): Tool[] {
  return [...createRepositoryTools(workspace.getSandbox()), createApplyPatchTool(workspace)];
}

export function createWorkspaceToolRegistry(workspace: GitWorktreeWorkspace): InMemoryToolRegistry {
  return new InMemoryToolRegistry(createWorkspaceTools(workspace));
}
