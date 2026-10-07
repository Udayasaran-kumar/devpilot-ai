import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import { classifyCommandOutcome, createEvidenceId, EvidenceSchema, PatchRequestSchema, type PatchStatus } from '@devpilot/core';
import {
  APPLY_PATCH_TOOL_NAME,
  ApplyPatchInputSchema,
  createApplyPatchTool,
  createDefaultToolRegistry,
  createWorkspaceToolRegistry,
  GitWorktreeWorkspace,
  RepositorySandbox,
  resolveGitExecutable,
  type ApplyPatchInput,
  type ApplyPatchOutput,
  type GitExecutable,
  type PatchWorkspaceSource,
  type Tool,
} from '../src/index.js';
import {
  createGitRepositoryFixture,
  git,
  snapshotRepository,
  type GitRepositoryFixture,
} from './support/git-repository.js';
import { expectSuccess, runTool, toolContext } from './support/sandbox-fixture.js';

const patch = (...lines: string[]): string => `${lines.join('\n')}\n`;

const BUGGY_TAX = '  const tax = Math.round(subtotal * TAX_RATE);';
const FIXED_TAX = '  const tax = Math.round(discounted * TAX_RATE);';
const FIX_TAX = patch(
  'diff --git a/src/checkout.ts b/src/checkout.ts',
  'index 1111111..2222222 100644',
  '--- a/src/checkout.ts',
  '+++ b/src/checkout.ts',
  '@@ -31,5 +31,5 @@ export async function checkout(',
  '   const subtotal = cart.subtotal();',
  '   const discounted = applyDiscount(subtotal, options.discountCode);',
  `-${BUGGY_TAX}`,
  `+${FIXED_TAX}`,
  '   const total = discounted + tax;',
  ' ',
);
const createFile = (filePath: string, ...lines: string[]): string =>
  patch('--- /dev/null', `+++ b/${filePath}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`));
const modifyLine = (filePath: string, line: number, before: string, after: string): string =>
  patch(`--- a/${filePath}`, `+++ b/${filePath}`, `@@ -${line} +${line} @@`, `-${before}`, `+${after}`);
const MONEY_LINE_1 = 'export type Cents = number;';

const NOT_ROOT = { skip: process.getuid?.() === 0 ? 'permission checks do not apply to root' : false };
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'uses POSIX symlinks and modes' : false };
const SOURCE_DIRECTORY = fileURLToPath(new URL('../src/', import.meta.url));

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

describe('apply_patch', () => {
  let realGit: GitExecutable;
  let fixture: GitRepositoryFixture;
  let workspace: GitWorktreeWorkspace;
  let tool: Tool<ApplyPatchInput, ApplyPatchOutput>;
  const cleanups: Array<() => Promise<unknown>> = [];

  const apply = async (text: string, description?: string, target: Tool<ApplyPatchInput, ApplyPatchOutput> = tool) => {
    const input = description === undefined ? { patch: text } : { patch: text, description };
    return expectSuccess(await runTool(target, input));
  };
  const expectStatus = async (text: string, status: PatchStatus, reason?: RegExp): Promise<ApplyPatchOutput> => {
    const { output } = await apply(text);
    assert.equal(output.status, status, output.reason ?? undefined);
    if (reason) assert.match(output.reason ?? '', reason);
    return output;
  };
  const worktreeFile = (filePath: string) => readFile(path.join(workspace.getRoot(), filePath), 'utf8');
  const originalFile = (filePath: string) => readFile(path.join(fixture.root, filePath), 'utf8');

  before(async () => {
    realGit = await resolveGitExecutable();
  });

  beforeEach(async () => {
    fixture = await createGitRepositoryFixture(realGit);
    workspace = await GitWorktreeWorkspace.create(fixture.root, { git: realGit });
    tool = createApplyPatchTool(workspace);
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    await workspace.remove();
    await fixture.cleanup();
  });

  describe('applying', () => {
    it('A: applies a valid patch inside the worktree', async () => {
      const { output } = await apply(FIX_TAX, 'Apply tax to the discounted amount');

      assert.equal(output.status, 'applied');
      assert.equal(output.reason, null);
      assert.equal(output.workspace, workspace.name);
      assert.equal(output.description, 'Apply tax to the discounted amount');
      assert.deepEqual(output.files, [{ path: 'src/checkout.ts', operation: 'modify', additions: 1, deletions: 1 }]);
      assert.deepEqual(output.affectedPaths, ['src/checkout.ts']);
      assert.ok((await worktreeFile('src/checkout.ts')).includes(FIXED_TAX));
      assert.deepEqual(await workspace.status(), { clean: false, changedPaths: ['src/checkout.ts'] });
    });

    it('B: leaves the original repository unchanged', async () => {
      const before = await snapshotRepository(realGit, fixture.root);
      await expectStatus(FIX_TAX, 'applied');
      assert.deepEqual(await snapshotRepository(realGit, fixture.root), before);
      assert.ok((await originalFile('src/checkout.ts')).includes(BUGGY_TAX));
    });

    it('N: patches multiple files at once, including a real git diff with create and delete', async () => {
      const scratch = await GitWorktreeWorkspace.create(fixture.root, { git: realGit });
      const scratchRoot = scratch.getRoot();
      const checkoutPath = path.join(scratchRoot, 'src', 'checkout.ts');
      await writeFile(checkoutPath, (await readFile(checkoutPath, 'utf8')).replace(BUGGY_TAX, FIXED_TAX));
      const moneyPath = path.join(scratchRoot, 'src', 'money.ts');
      await writeFile(moneyPath, `// Amounts are integer cents.\n${await readFile(moneyPath, 'utf8')}`);
      await mkdir(path.join(scratchRoot, 'src', 'rounding'));
      await writeFile(path.join(scratchRoot, 'src', 'rounding', 'half-up.ts'), 'export const MODE = "half-up";\n');
      git(realGit, scratchRoot, 'rm', '-q', 'README.md');
      git(realGit, scratchRoot, 'add', '-N', 'src/rounding/half-up.ts');
      const diff = git(
        realGit,
        scratchRoot,
        '-c', 'diff.noprefix=false',
        'diff', 'HEAD', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/',
      );
      await scratch.remove();

      const { output } = await apply(diff, 'Several files');
      assert.equal(output.status, 'applied', output.reason ?? undefined);
      assert.deepEqual(
        output.files.map(({ path: filePath, operation }) => `${operation} ${filePath}`).sort(),
        ['delete README.md', 'modify src/checkout.ts', 'modify src/money.ts', 'create src/rounding/half-up.ts'].sort(),
      );
      assert.deepEqual((await workspace.status()).changedPaths, [
        'README.md',
        'src/checkout.ts',
        'src/money.ts',
        'src/rounding/half-up.ts',
      ]);
      assert.equal(await worktreeFile('src/rounding/half-up.ts'), 'export const MODE = "half-up";\n');
      assert.ok((await worktreeFile('src/money.ts')).startsWith('// Amounts are integer cents.\nexport type Cents'));
      assert.equal(await exists(path.join(workspace.getRoot(), 'README.md')), false);
      assert.ok(await exists(path.join(fixture.root, 'README.md')));
    });

    it('preserves the mode of modified files', POSIX_ONLY, async () => {
      const target = path.join(workspace.getRoot(), 'src', 'money.ts');
      await chmod(target, 0o755);
      await expectStatus(modifyLine('src/money.ts', 1, MONEY_LINE_1, 'export type Cents = number; // integer'), 'applied');
      assert.equal((await stat(target)).mode & 0o777, 0o755);
    });

    it('O: preserves unrelated uncommitted changes in the worktree', async () => {
      const root = workspace.getRoot();
      await writeFile(path.join(root, 'notes.txt'), 'untracked notes\n');
      const discountsPath = path.join(root, 'src', 'discounts.ts');
      const discounts = `${await readFile(discountsPath, 'utf8')}// local edit\n`;
      await writeFile(discountsPath, discounts);
      const checkoutPath = path.join(root, 'src', 'checkout.ts');
      await writeFile(checkoutPath, `// local header edit\n${await readFile(checkoutPath, 'utf8')}`);

      await expectStatus(FIX_TAX, 'applied');

      const checkout = await worktreeFile('src/checkout.ts');
      assert.ok(checkout.startsWith('// local header edit\n'), 'edit in the same file kept (hunk found at an offset)');
      assert.ok(checkout.includes(FIXED_TAX));
      assert.equal(await readFile(discountsPath, 'utf8'), discounts);
      assert.equal(await worktreeFile('notes.txt'), 'untracked notes\n');
    });
  });

  describe('path safety', () => {
    it('C: rejects traversal out of the worktree', async () => {
      for (const target of ['../outside.txt', '../../../../outside.txt', 'src/../../outside.txt', 'src/./money.ts']) {
        const output = await expectStatus(createFile(target, 'escaped'), 'unsafe_path', /"\." or "\.\." segments/);
        assert.deepEqual(output.affectedPaths, [target]);
      }
      await expectStatus(modifyLine('../repo/src/money.ts', 1, MONEY_LINE_1, 'x'), 'unsafe_path');
      for (const directory of [fixture.base, fixture.allowedRoot, path.join(workspace.getRoot(), '..')]) {
        assert.equal(await exists(path.join(directory, 'outside.txt')), false);
      }
      assert.equal((await originalFile('src/money.ts')).split('\n')[0], MONEY_LINE_1);
    });

    it('D: rejects absolute paths', async () => {
      const absolute = path.join(fixture.outside, 'absolute.txt');
      await expectStatus(patch('--- /dev/null', `+++ ${absolute}`, '@@ -0,0 +1 @@', '+x'), 'unsafe_path', /absolute/);
      await expectStatus(patch('--- /dev/null', `+++ b/${absolute}`, '@@ -0,0 +1 @@', '+x'), 'unsafe_path', /absolute/);
      await expectStatus(createFile('C:/Windows/x.txt', 'x'), 'unsafe_path', /absolute/);
      await expectStatus(createFile('src\\..\\..\\x.txt', 'x'), 'unsafe_path', /backslash/);
      assert.deepEqual(await readdir(fixture.outside), []);
    });

    it('E: rejects anything under .git, including the worktree .git file', async () => {
      const gitFile = await worktreeFile('.git');
      for (const target of ['.git', '.git/config', '.git/hooks/post-checkout', '.GIT/config', 'src/.git/HEAD']) {
        await expectStatus(createFile(target, 'x'), 'unsafe_path', /protected \.git/i);
        await expectStatus(modifyLine(target, 1, 'a', 'b'), 'unsafe_path', /protected \.git/i);
      }
      assert.equal(await worktreeFile('.git'), gitFile);
      assert.equal(await exists(path.join(fixture.root, '.git', 'hooks', 'post-checkout')), false);
    });

    it('F: rejects anything under .devpilot', async () => {
      for (const target of ['.devpilot/worktrees/evil/x.txt', '.devpilot/.gitignore', '.DevPilot/x', 'src/.devpilot/x']) {
        await expectStatus(createFile(target, 'x'), 'unsafe_path', /protected \.devpilot/i);
      }
      assert.equal(await exists(path.join(workspace.getRoot(), '.devpilot')), false);
      assert.equal(await readFile(path.join(fixture.root, '.devpilot', '.gitignore'), 'utf8'), '*\n');
    });

    it('G: rejects symlinks, including ones that escape the worktree', POSIX_ONLY, async () => {
      const root = workspace.getRoot();
      await writeFile(path.join(fixture.outside, 'secret.txt'), 'outside secret\n');
      await symlink(path.join(fixture.outside, 'secret.txt'), path.join(root, 'leak.txt'));
      await symlink(fixture.outside, path.join(root, 'linked-dir'));
      await symlink(path.join(fixture.outside, 'missing.txt'), path.join(root, 'dangling.txt'));
      await symlink('money.ts', path.join(root, 'src', 'money-alias.ts'));
      await symlink('src', path.join(root, 'src-alias'));

      await expectStatus(modifyLine('leak.txt', 1, 'outside secret', 'pwned'), 'unsafe_path', /symlink/);
      await expectStatus(modifyLine('linked-dir/secret.txt', 1, 'outside secret', 'pwned'), 'unsafe_path', /outside/);
      await expectStatus(createFile('linked-dir/new.txt', 'pwned'), 'unsafe_path', /symlink/);
      await expectStatus(createFile('dangling.txt', 'pwned'), 'unsafe_path', /symlink/);
      await expectStatus(modifyLine('src/money-alias.ts', 1, MONEY_LINE_1, 'x'), 'unsafe_path', /symlink/);
      await expectStatus(modifyLine('src-alias/money.ts', 1, MONEY_LINE_1, 'x'), 'unsafe_path', /symlink/);
      await expectStatus(
        patch('diff --git a/l b/l', 'new file mode 120000', '--- /dev/null', '+++ b/l', '@@ -0,0 +1 @@', '+/etc'),
        'unsafe_path',
        /symlinks/,
      );

      assert.deepEqual((await readdir(fixture.outside)).sort(), ['secret.txt']);
      assert.equal(await readFile(path.join(fixture.outside, 'secret.txt'), 'utf8'), 'outside secret\n');
      assert.equal((await worktreeFile('src/money.ts')).split('\n')[0], MONEY_LINE_1);
    });

    it('rejects a patch to a file that does not exist or a file that already exists', async () => {
      await expectStatus(modifyLine('src/missing.ts', 1, 'a', 'b'), 'rejected', /does not exist/);
      await expectStatus(createFile('src/money.ts', 'x'), 'rejected', /already exists/);
      await expectStatus(createFile('package.json/x.ts', 'x'), 'rejected', /not a directory/);
    });
  });

  describe('malformed and failed patches', () => {
    it('H: rejects malformed unified diffs without touching anything', async () => {
      const before = await snapshotRepository(realGit, workspace.getRoot());
      for (const text of [
        'please fix the tax bug\n',
        patch('--- a/src/money.ts', '+++ b/src/money.ts', '@@ -1,3 +1,3 @@', `-${MONEY_LINE_1}`, '+x'),
        patch('--- a/src/money.ts', '+++ b/src/money.ts', 'not a hunk'),
        patch('diff --git a/logo.png b/logo.png', 'GIT binary patch', 'literal 3', 'abc'),
      ]) {
        const output = await expectStatus(text, 'invalid_patch');
        assert.deepEqual(output.files, []);
      }
      assert.deepEqual(await snapshotRepository(realGit, workspace.getRoot()), before);
    });

    it('I: a patch with one bad hunk changes nothing', async () => {
      const before = await snapshotRepository(realGit, workspace.getRoot());
      const text =
        createFile('src/rounding/new.ts', 'export {};') +
        FIX_TAX +
        modifyLine('src/money.ts', 1, 'this line is not in the file', 'x');
      await expectStatus(text, 'rejected', /hunk 1 of src\/money\.ts does not match/);
      assert.deepEqual(await snapshotRepository(realGit, workspace.getRoot()), before);
      assert.equal(await exists(path.join(workspace.getRoot(), 'src', 'rounding')), false);
      assert.deepEqual(await workspace.status(), { clean: true, changedPaths: [] });
    });

    it('I: a write failure part-way rolls back completed changes', { skip: NOT_ROOT.skip || POSIX_ONLY.skip }, async () => {
      const before = await snapshotRepository(realGit, workspace.getRoot());
      const readOnly = path.join(workspace.getRoot(), 'src', 'payment');
      await chmod(readOnly, 0o555);
      cleanups.push(() => chmod(readOnly, 0o755));
      const gateway = (await worktreeFile('src/payment/gateway.ts')).split('\n')[0] ?? '';

      const output = await expectStatus(
        createFile('src/rounding/deep/new.ts', 'export {};') +
          FIX_TAX +
          modifyLine('src/payment/gateway.ts', 1, gateway, `${gateway} // edited`),
        'application_failed',
        /all completed changes were rolled back/,
      );

      assert.doesNotMatch(output.reason ?? '', new RegExp(fixture.base.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      await chmod(readOnly, 0o755);
      assert.deepEqual(await snapshotRepository(realGit, workspace.getRoot()), before);
      assert.equal(await exists(path.join(workspace.getRoot(), 'src', 'rounding')), false);
      assert.deepEqual(await readdir(readOnly), ['fake-gateway.ts', 'gateway.ts'], 'no temp files left behind');
    });
  });

  describe('no shell, no git arguments', () => {
    it('J: writes shell metacharacters literally and never spawns a process', async () => {
      const root = workspace.getRoot();
      const output = await expectStatus(
        createFile('$(touch PWNED-1);touch PWNED-2.txt', '$(touch PWNED-3)', '`touch PWNED-4`', '; rm -rf / #'),
        'applied',
      );
      assert.deepEqual(output.affectedPaths, ['$(touch PWNED-1);touch PWNED-2.txt']);
      assert.equal(
        await worktreeFile('$(touch PWNED-1);touch PWNED-2.txt'),
        '$(touch PWNED-3)\n`touch PWNED-4`\n; rm -rf / #\n',
      );
      for (const directory of [root, fixture.root, process.cwd()]) {
        assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith('PWNED')), []);
      }

      for (const file of ['apply-patch.ts', 'unified-diff.ts']) {
        const source = await readFile(path.join(SOURCE_DIRECTORY, file), 'utf8');
        assert.doesNotMatch(source, /child_process|process-runner|\brunGit\b|\bspawn\(|execFile/, file);
      }
    });

    it('K: accepts no fields besides patch and description', async () => {
      for (const extra of [
        { args: ['--unsafe-paths'] },
        { gitArgs: ['--directory=..'] },
        { strip: 0 },
        { cwd: '..' },
        { path: '/etc/passwd' },
      ]) {
        assert.equal(ApplyPatchInputSchema.safeParse({ patch: FIX_TAX, ...extra }).success, false);
        assert.equal(PatchRequestSchema.safeParse({ patch: FIX_TAX, ...extra }).success, false);
      }
      assert.equal(ApplyPatchInputSchema.safeParse({ patch: '' }).success, false);
      await expectStatus(
        patch('diff --git a/x b/x --unsafe-paths', '--- a/x', '+++ b/x', '@@ -1 +1 @@', '-a', '+b'),
        'invalid_patch',
        /does not match/,
      );
      const optionLike = await expectStatus(createFile('--output=pwned', 'literal'), 'applied');
      assert.deepEqual(optionLike.affectedPaths, ['--output=pwned']);
      assert.equal(await worktreeFile('--output=pwned'), 'literal\n');
    });
  });

  describe('evidence', () => {
    it('L: records deterministic evidence for an applied patch', async () => {
      const { output, evidence } = await apply(FIX_TAX, 'Apply tax to the discounted amount');
      assert.equal(evidence.length, 1);
      const [item] = evidence;
      assert.ok(item);
      EvidenceSchema.parse(item);
      assert.deepEqual(output.evidenceIds, [item.id]);
      assert.equal(item.kind, 'patch_application');
      assert.deepEqual(item.source, { tool: APPLY_PATCH_TOOL_NAME, actionId: 'action-1' });
      assert.deepEqual(item.location, { type: 'patch', workspace: workspace.name, paths: ['src/checkout.ts'], status: 'applied' });
      assert.equal(item.id, createEvidenceId({ tool: APPLY_PATCH_TOOL_NAME, location: item.location, content: item.content }));
      assert.match(item.summary, /Patch applied to 1 file in worktree/);
      for (const expected of [
        'apply_patch: applied',
        'description: Apply tax to the discounted amount',
        `patch sha256: ${output.patchSha256}`,
        'modify src/checkout.ts (+1 -1)',
        FIXED_TAX,
      ]) {
        assert.ok(item.content?.includes(expected), `evidence should include ${expected}`);
      }
      assert.ok(!item.content?.includes(fixture.base), 'evidence must not contain host paths');
      assert.ok(!item.content?.includes(workspace.getRoot()));

      const other = await createGitRepositoryFixture(realGit);
      const named = async (repository: string) => {
        const ws = await GitWorktreeWorkspace.create(repository, { git: realGit, name: 'evidence' });
        cleanups.push(() => ws.remove());
        return expectSuccess(await runTool(createApplyPatchTool(ws), { patch: FIX_TAX })).evidence[0]?.id;
      };
      cleanups.push(() => other.cleanup());
      assert.equal(await named(fixture.root), await named(other.root), 'same patch and workspace name, same ID');
    });

    it('M: records evidence for rejected, invalid, and impossible patches', async () => {
      const cases: Array<[string, PatchStatus, Tool<ApplyPatchInput, ApplyPatchOutput>]> = [
        [createFile('../outside.txt', 'x'), 'unsafe_path', tool],
        ['not a diff\n', 'invalid_patch', tool],
        [modifyLine('src/money.ts', 1, 'nope', 'x'), 'rejected', tool],
        [FIX_TAX, 'workspace_missing', createApplyPatchTool(() => undefined)],
      ];
      const ids = new Set<string>();
      for (const [text, status, target] of cases) {
        const { output, evidence } = await apply(text, 'attempt', target);
        assert.equal(output.status, status);
        const [item] = evidence;
        assert.ok(item);
        EvidenceSchema.parse(item);
        assert.equal(item.kind, 'patch_application');
        assert.match(item.summary, new RegExp(`Patch not applied \\(${status}\\)`));
        assert.ok(item.content?.includes(`apply_patch: ${status}`));
        assert.ok(item.content?.includes(`reason: ${output.reason}`));
        ids.add(item.id);
      }
      assert.equal(ids.size, cases.length);
    });
  });

  describe('isolation', () => {
    it('P: patches stay in their own worktree, and RED turns GREEN only there', async () => {
      const sibling = await GitWorktreeWorkspace.create(fixture.root, { git: realGit });
      cleanups.push(() => sibling.remove());
      const before = await snapshotRepository(realGit, fixture.root);

      await expectStatus(FIX_TAX, 'applied');

      const sandbox = workspace.getSandbox();
      const green = await sandbox.runCommand({ command: 'npm', args: ['test'] });
      assert.equal(classifyCommandOutcome(green), 'green');
      const siblingRun = await sibling.getSandbox().runCommand({ command: 'npm', args: ['test'] });
      assert.equal(classifyCommandOutcome(siblingRun), 'red');

      assert.ok((await readFile(path.join(sibling.getRoot(), 'src', 'checkout.ts'), 'utf8')).includes(BUGGY_TAX));
      assert.deepEqual(await snapshotRepository(realGit, fixture.root), before);
      assert.deepEqual(await sibling.status(), { clean: true, changedPaths: [] });
    });

    it('refuses to run without an active, isolated worktree', async () => {
      const removed = await GitWorktreeWorkspace.create(fixture.root, { git: realGit });
      const removedTool = createApplyPatchTool(removed);
      await removed.remove();
      const originalSandbox = await RepositorySandbox.create(fixture.root);
      const sources: Array<[PatchWorkspaceSource, RegExp]> = [
        [() => undefined, /No active worktree/],
        [{ name: 'fake', removed: false, getSandbox: () => originalSandbox }, /not an isolated worktree/],
      ];

      const before = await snapshotRepository(realGit, fixture.root);
      const { output } = await apply(FIX_TAX, undefined, removedTool);
      assert.equal(output.status, 'workspace_missing');
      assert.match(output.reason ?? '', /has been removed/);
      for (const [source, reason] of sources) {
        const result = await apply(FIX_TAX, undefined, createApplyPatchTool(source));
        assert.equal(result.output.status, 'workspace_missing');
        assert.match(result.output.reason ?? '', reason);
        assert.equal(result.output.workspace, typeof source === 'function' ? null : source.name);
      }
      assert.deepEqual(await snapshotRepository(realGit, fixture.root), before, 'the original checkout is never patched');
    });

    it('is registered only for worktree registries', async () => {
      const original = createDefaultToolRegistry(await RepositorySandbox.create(fixture.root));
      assert.equal(original.has(APPLY_PATCH_TOOL_NAME), false);

      const registry = createWorkspaceToolRegistry(workspace);
      assert.deepEqual(
        registry.list().map((registered) => registered.name),
        ['read_file', 'search_code', 'list_files', 'run_command', APPLY_PATCH_TOOL_NAME],
      );
      const registered = registry.get(APPLY_PATCH_TOOL_NAME);
      assert.ok(registered);
      const result = await registered.run(registered.inputSchema.parse({ patch: FIX_TAX }), toolContext());
      assert.equal(result.status === 'success' ? (result.output as ApplyPatchOutput).status : result.status, 'applied');
      assert.ok((await worktreeFile('src/checkout.ts')).includes(FIXED_TAX));
    });

    it('serializes concurrent patches to the same worktree', async () => {
      const results = await Promise.all([
        apply(FIX_TAX),
        apply(FIX_TAX),
        apply(modifyLine('src/money.ts', 1, MONEY_LINE_1, 'export type Cents = number; // integer')),
      ]);
      assert.deepEqual(
        results.map(({ output }) => output.status).sort(),
        ['applied', 'applied', 'rejected'],
        'the second identical patch no longer matches once the first has applied',
      );
    });
  });
});
