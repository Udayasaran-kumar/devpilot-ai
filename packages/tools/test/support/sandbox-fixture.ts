import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvidenceSchema, type Evidence, type JsonValue } from '@devpilot/core';
import {
  RepositorySandbox,
  type RepositorySandboxOptions,
  type Tool,
  type ToolContext,
  type ToolInput,
  type ToolResult,
} from '../../src/index.js';

export const FIXTURE_ROOT = fileURLToPath(new URL('../../../../fixtures/sample-repository', import.meta.url));
export const NOW = '2026-01-01T00:00:00.000Z';
export const OUTSIDE_SECRET = 'OUTSIDE_SECRET_TOKEN';

export interface SandboxFixture {
  /** Temp directory holding the repository and its hostile neighbours. */
  readonly base: string;
  /** Repository root as created (may be a non-canonical alias such as /var vs /private/var). */
  readonly root: string;
  /** Directory outside the repository that symlinks try to escape to. */
  readonly outside: string;
  /** Sibling whose path shares the repository root as a string prefix. */
  readonly prefixSibling: string;
  readonly sandbox: RepositorySandbox;
  cleanup(): Promise<void>;
}

/**
 * Copies the sample repository to a temp directory and adds hostile entries:
 * escaping file and directory symlinks, an internal symlink, a binary file,
 * ignored directories, and a sibling directory sharing the root's name prefix.
 */
export async function createSandboxFixture(options: RepositorySandboxOptions = {}): Promise<SandboxFixture> {
  const base = await mkdtemp(path.join(tmpdir(), 'devpilot-tools-'));
  const root = path.join(base, 'repo');
  const outside = path.join(base, 'outside');
  const prefixSibling = path.join(base, 'repo-evil');

  await cp(FIXTURE_ROOT, root, { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), `${OUTSIDE_SECRET} applyDiscount\n`);
  await mkdir(prefixSibling);
  await writeFile(path.join(prefixSibling, 'secret.txt'), `${OUTSIDE_SECRET}\n`);

  await symlink(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'));
  await symlink(outside, path.join(root, 'src', 'outside-dir'));
  await symlink('money.ts', path.join(root, 'src', 'money-alias.ts'));

  await mkdir(path.join(root, 'assets'));
  await writeFile(
    path.join(root, 'assets', 'logo.bin'),
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]), Buffer.from('applyDiscount')]),
  );
  await writeFile(path.join(root, 'empty.txt'), '');
  await mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
  await writeFile(path.join(root, 'node_modules', 'dep', 'index.js'), 'export const applyDiscount = 1;\n');
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, '.git', 'HEAD'), 'applyDiscount\n');

  const sandbox = await RepositorySandbox.create(root, options);
  return {
    base,
    root,
    outside,
    prefixSibling,
    sandbox,
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

export function toolContext(actionId = 'action-1', now = NOW): ToolContext {
  return { investigationId: 'inv-test', actionId, now: () => now };
}

/**
 * Runs a tool the way the engine does: validates input first, then checks that
 * successful output and evidence satisfy their schemas and survive JSON.
 */
export async function runTool<TInput extends ToolInput, TOutput extends JsonValue>(
  tool: Tool<TInput, TOutput>,
  input: unknown,
  context: ToolContext = toolContext(),
): Promise<ToolResult<TOutput>> {
  const parsed = tool.inputSchema.parse(input);
  const result = await tool.run(parsed, context);
  if (result.status === 'success') {
    tool.outputSchema.parse(result.output);
    for (const item of result.evidence) {
      EvidenceSchema.parse(item);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  }
  return result;
}

export function expectSuccess<TOutput extends JsonValue>(
  result: ToolResult<TOutput>,
): { readonly output: TOutput; readonly evidence: readonly Evidence[] } {
  assert.equal(result.status, 'success', result.status === 'error' ? result.error : undefined);
  return result as Extract<ToolResult<TOutput>, { status: 'success' }>;
}

export function expectError(result: ToolResult, pattern: RegExp): void {
  assert.equal(result.status, 'error', 'expected the tool to return an error');
  if (result.status === 'error') {
    assert.match(result.error, pattern);
  }
}
