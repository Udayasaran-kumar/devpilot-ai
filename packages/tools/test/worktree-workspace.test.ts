import assert from 'node:assert/strict';
import { access, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { classifyCommandOutcome } from '@devpilot/core';
import {
  createRepositoryTools,
  GitWorktreeWorkspace,
  RepositorySandbox,
  resolveGitExecutable,
  WORKSPACE_NAME_PATTERN,
  type GitExecutable,
  type ListFilesOutput,
  type ReadFileOutput,
  type RunCommandOutput,
  type SearchCodeOutput,
} from '../src/index.js';
import {
  createGitRepositoryFixture,
  git,
  listWorktrees,
  rejectsWithCode,
  shellQuote,
  snapshotRepository,
  writeExecutable,
  type GitRepositoryFixture,
} from './support/git-repository.js';
import { expectSuccess, runTool } from './support/sandbox-fixture.js';

const POSIX_ONLY = { skip: process.platform === 'win32' ? 'uses POSIX shell scripts and symlinks' : false };
const BUGGY_TAX = 'Math.round(subtotal * TAX_RATE)';
const FIXED_TAX = 'Math.round(discounted * TAX_RATE)';

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

describe('GitWorktreeWorkspace', () => {
  let realGit: GitExecutable;
  let fixture: GitRepositoryFixture;
  let worktreesDirectory: string;
  const workspaces: GitWorktreeWorkspace[] = [];

  const create = async (options: Parameters<typeof GitWorktreeWorkspace.create>[1] = {}) => {
    const workspace = await GitWorktreeWorkspace.create(fixture.root, { git: realGit, ...options });
    workspaces.push(workspace);
    return workspace;
  };

  before(async () => {
    realGit = await resolveGitExecutable();
  });

  beforeEach(async () => {
    fixture = await createGitRepositoryFixture(realGit);
    worktreesDirectory = path.join(fixture.canonicalRoot, '.devpilot', 'worktrees');
  });

  afterEach(async () => {
    await Promise.allSettled(workspaces.splice(0).map((workspace) => workspace.remove()));
    await fixture.cleanup();
  });

  describe('create', () => {
    it('creates a detached worktree of HEAD that is a valid git working tree', async () => {
      const head = git(realGit, fixture.root, 'rev-parse', 'HEAD').trim();
      const workspace = await create();
      const root = workspace.getRoot();

      assert.equal(workspace.baseCommit, head);
      assert.equal(workspace.repositoryRoot, fixture.canonicalRoot);
      assert.equal(git(realGit, root, 'rev-parse', '--is-inside-work-tree').trim(), 'true');
      assert.equal(git(realGit, root, 'rev-parse', '--show-toplevel').trim(), root);
      assert.equal(git(realGit, root, 'rev-parse', 'HEAD').trim(), head);
      assert.equal(git(realGit, root, 'branch', '--show-current').trim(), '', 'worktree should be detached');
      assert.ok((await lstat(path.join(root, '.git'))).isFile(), 'linked worktrees have a .git file');
      assert.ok(listWorktrees(realGit, fixture.root).includes(root));
      assert.equal(
        await readFile(path.join(root, 'src', 'checkout.ts'), 'utf8'),
        await readFile(path.join(fixture.root, 'src', 'checkout.ts'), 'utf8'),
      );
      assert.deepEqual(await workspace.status(), { clean: true, changedPaths: [] });
    });

    it('places the worktree in its own directory under .devpilot/worktrees', async () => {
      const workspace = await create();
      assert.match(workspace.name, WORKSPACE_NAME_PATTERN);
      assert.equal(workspace.getRoot(), path.join(worktreesDirectory, workspace.name));
      assert.deepEqual(await readdir(worktreesDirectory), [workspace.name]);
    });

    it('leaves the original repository unchanged and its status clean', async () => {
      const before = await snapshotRepository(realGit, fixture.root);
      await create();
      const after = await snapshotRepository(realGit, fixture.root);

      assert.deepEqual(after, before);
      assert.equal(after.status, '', '.devpilot must not show up as untracked');
      assert.equal(await readFile(path.join(fixture.root, '.devpilot', '.gitignore'), 'utf8'), '*\n');
    });

    it('keeps changes made in the worktree out of the original repository', async () => {
      const before = await snapshotRepository(realGit, fixture.root);
      const workspace = await create();
      const checkoutPath = path.join(workspace.getRoot(), 'src', 'checkout.ts');
      await writeFile(checkoutPath, (await readFile(checkoutPath, 'utf8')).replace(BUGGY_TAX, FIXED_TAX));
      await writeFile(path.join(workspace.getRoot(), 'NOTES.md'), 'scratch\n');
      await rm(path.join(workspace.getRoot(), 'README.md'));

      assert.deepEqual(await snapshotRepository(realGit, fixture.root), before);
      assert.ok((await readFile(path.join(fixture.root, 'src', 'checkout.ts'), 'utf8')).includes(BUGGY_TAX));
      assert.deepEqual(await workspace.status(), {
        clean: false,
        changedPaths: ['NOTES.md', 'README.md', 'src/checkout.ts'],
      });
    });

    it('generates distinct names for concurrent workspaces', async () => {
      const created = await Promise.all(Array.from({ length: 6 }, () => create()));
      const names = created.map((workspace) => workspace.name);

      assert.equal(new Set(names).size, names.length);
      assert.deepEqual((await readdir(worktreesDirectory)).sort(), [...names].sort());
      const registered = listWorktrees(realGit, fixture.root);
      for (const workspace of created) {
        assert.ok(registered.includes(workspace.getRoot()));
        assert.ok(await exists(path.join(workspace.getRoot(), 'src', 'checkout.ts')));
      }

      await Promise.all(created.map((workspace) => workspace.remove()));
      assert.deepEqual(listWorktrees(realGit, fixture.root), [fixture.canonicalRoot]);
    });
  });

  describe('sandbox', () => {
    it('runs the repository tools against the worktree, RED to GREEN, without touching the original', async () => {
      const workspace = await create();
      const sandbox = workspace.getSandbox();
      assert.ok(sandbox instanceof RepositorySandbox);
      assert.equal(sandbox.root, workspace.getRoot());
      assert.equal(workspace.getSandbox(), sandbox, 'one sandbox per workspace');

      const tools = new Map(createRepositoryTools(sandbox).map((tool) => [tool.name, tool]));
      const tool = (name: string) => {
        const found = tools.get(name);
        assert.ok(found, `missing tool ${name}`);
        return found;
      };

      const listed = expectSuccess(await runTool(tool('list_files'), {})).output as ListFilesOutput;
      const paths = listed.entries.map((entry) => entry.path);
      assert.ok(paths.includes('src/checkout.ts'));
      assert.ok(!paths.includes('.git'), "the worktree's .git file is not listed");

      const found = expectSuccess(await runTool(tool('search_code'), { query: BUGGY_TAX })).output as SearchCodeOutput;
      assert.deepEqual(found.matches.map((match) => match.path), ['src/checkout.ts']);

      const red = expectSuccess(await runTool(tool('run_command'), { command: 'npm', args: ['test'] }))
        .output as RunCommandOutput;
      assert.equal(classifyCommandOutcome(red), 'red');
      assert.match(red.stdout, /200 !== 180/);

      const checkoutPath = path.join(workspace.getRoot(), 'src', 'checkout.ts');
      await writeFile(checkoutPath, (await readFile(checkoutPath, 'utf8')).replace(BUGGY_TAX, FIXED_TAX));

      const read = expectSuccess(await runTool(tool('read_file'), { path: 'src/checkout.ts' })).output as ReadFileOutput;
      assert.ok(read.content.includes(FIXED_TAX));
      const green = expectSuccess(await runTool(tool('run_command'), { command: 'npm', args: ['test'] }))
        .output as RunCommandOutput;
      assert.equal(classifyCommandOutcome(green), 'green');

      const original = await RepositorySandbox.create(fixture.root);
      assert.ok((await original.readFile('src/checkout.ts')).content.includes(BUGGY_TAX));
      const originalPaths = (await original.listFiles({ maxResults: 2000 })).entries.map((entry) => entry.path);
      assert.ok(!originalPaths.some((entry) => entry.startsWith('.devpilot')), 'walks skip DevPilot worktrees');
      assert.equal((await original.search(FIXED_TAX)).matches.length, 0);
    });

    it('keeps the sandbox confined to the worktree', async () => {
      const sandbox = (await create()).getSandbox();
      await assert.rejects(sandbox.readFile('../../../src/checkout.ts'), { code: 'outside_root' });
      await assert.rejects(sandbox.readFile(path.join(fixture.root, 'package.json')), { code: 'outside_root' });
    });
  });

  describe('validation', () => {
    it('rejects repositories outside the allowed root, including traversal and symlinks', async () => {
      const otherRepository = path.join(fixture.base, 'other');
      await mkdir(otherRepository);
      git(realGit, otherRepository, 'init', '-q', '-b', 'main');
      await symlink(otherRepository, path.join(fixture.allowedRoot, 'linked'));
      const allowedRoot = fixture.allowedRoot;

      for (const candidate of [
        otherRepository,
        path.join(allowedRoot, '..', 'other'),
        `${allowedRoot}/repo/../../other`,
        path.join(allowedRoot, 'linked'),
        fixture.outside,
      ]) {
        await rejectsWithCode(
          GitWorktreeWorkspace.create(candidate, { allowedRoot, git: realGit }),
          'outside_allowed_root',
        );
      }
      assert.equal(await exists(path.join(otherRepository, '.devpilot')), false);
      await create({ allowedRoot });
    });

    it('rejects workspace names that are not a single safe path segment', async () => {
      for (const name of ['../escape', '..', '.', 'a/b', 'a\\b', '/abs', '', '-x', 'Upper', 'a\0b', 'x'.repeat(65)]) {
        await rejectsWithCode(create({ name }), 'invalid_name');
      }
      assert.equal(await exists(path.join(fixture.root, '.devpilot')), false, 'nothing is created for invalid names');
    });

    it('rejects directories that are not the top level of a repository with a commit', async () => {
      const plain = path.join(fixture.allowedRoot, 'plain');
      const empty = path.join(fixture.allowedRoot, 'empty');
      await mkdir(plain);
      await mkdir(empty);
      git(realGit, empty, 'init', '-q', '-b', 'main');

      const allowedRoot = fixture.allowedRoot;
      for (const candidate of [plain, empty, path.join(fixture.root, 'src'), path.join(fixture.root, 'package.json')]) {
        await rejectsWithCode(GitWorktreeWorkspace.create(candidate, { allowedRoot, git: realGit }), 'invalid_repository');
      }
      await rejectsWithCode(
        GitWorktreeWorkspace.create(path.join(fixture.allowedRoot, 'missing'), { allowedRoot, git: realGit }),
        'invalid_repository',
      );
      for (const candidate of [plain, empty, path.join(fixture.root, 'src')]) {
        assert.equal(await exists(path.join(candidate, '.devpilot')), false);
      }
    });

    it('never reuses an existing destination', async () => {
      const first = await create({ name: 'fixed' });
      await writeFile(path.join(first.getRoot(), 'work-in-progress.txt'), 'keep me\n');
      await rejectsWithCode(create({ name: 'fixed' }), 'destination_exists');
      assert.equal(await readFile(path.join(first.getRoot(), 'work-in-progress.txt'), 'utf8'), 'keep me\n');

      const manual = path.join(worktreesDirectory, 'manual');
      await mkdir(manual);
      await writeFile(path.join(manual, 'user-file.txt'), 'not ours\n');
      await rejectsWithCode(create({ name: 'manual' }), 'destination_exists');
      assert.equal(await readFile(path.join(manual, 'user-file.txt'), 'utf8'), 'not ours\n');
      assert.deepEqual(listWorktrees(realGit, fixture.root), [fixture.canonicalRoot, first.getRoot()]);
    });

    it('rejects a .devpilot or worktrees directory that is a symlink or a file', POSIX_ONLY, async () => {
      const devpilot = path.join(fixture.root, '.devpilot');

      await symlink(fixture.outside, devpilot);
      await rejectsWithCode(create(), 'unsafe_destination');
      assert.deepEqual(await readdir(fixture.outside), [], 'nothing written through the symlink');
      await rm(devpilot);

      await mkdir(devpilot);
      await symlink(fixture.outside, path.join(devpilot, 'worktrees'));
      await rejectsWithCode(create(), 'unsafe_destination');
      assert.deepEqual(await readdir(fixture.outside), []);
      await rm(devpilot, { recursive: true });

      await writeFile(devpilot, 'not a directory\n');
      await rejectsWithCode(create(), 'unsafe_destination');
      assert.equal(await readFile(devpilot, 'utf8'), 'not a directory\n');
      assert.deepEqual(listWorktrees(realGit, fixture.root), [fixture.canonicalRoot]);
    });

    it('rejects a destination that is a symlink out of the repository', POSIX_ONLY, async () => {
      await create();
      await symlink(fixture.outside, path.join(worktreesDirectory, 'escape'));
      await rejectsWithCode(create({ name: 'escape' }), 'destination_exists');
      assert.deepEqual(await readdir(fixture.outside), []);
      assert.ok((await lstat(path.join(worktreesDirectory, 'escape'))).isSymbolicLink(), 'the symlink is left alone');
    });
  });

  describe('failed creation', () => {
    const failures = [
      {
        label: 'git fails after writing into the destination',
        // Simulates a checkout that dies part-way: files on disk, nothing registered.
        onAdd: () => `
          next=0
          for arg in "$@"; do
            if [ "$next" = 1 ]; then target=$arg; break; fi
            [ "$arg" = "--" ] && next=1
          done
          mkdir -p "$target/partial" && echo partial > "$target/partial/file.txt"
          echo "fatal: simulated checkout failure" >&2
          exit 128`,
      },
      {
        label: 'git registers the worktree and then fails',
        onAdd: (realPath: string) => `
          ${shellQuote(realPath)} "$@" || exit $?
          echo "fatal: simulated failure after registration" >&2
          exit 1`,
      },
    ];

    for (const failure of failures) {
      it(`cleans up partial state when ${failure.label}`, POSIX_ONLY, async () => {
        const before = await snapshotRepository(realGit, fixture.root);
        const fakeGit = path.join(fixture.base, 'fake-git');
        await writeExecutable(
          fakeGit,
          `#!/bin/sh
case " $* " in
  *" worktree add "*)
${failure.onAdd(realGit.path)}
    ;;
esac
exec ${shellQuote(realGit.path)} "$@"
`,
        );

        const error = await rejectsWithCode(
          GitWorktreeWorkspace.create(fixture.root, { name: 'doomed', git: { path: fakeGit, version: 'fake' } }),
          'git_failed',
        );
        assert.match(error.message, /simulated/);
        assert.deepEqual(await readdir(worktreesDirectory), [], 'the claimed directory is gone');
        assert.deepEqual(listWorktrees(realGit, fixture.root), [fixture.canonicalRoot]);
        assert.deepEqual(await snapshotRepository(realGit, fixture.root), before);

        const retry = await create({ name: 'doomed' });
        assert.ok(await exists(path.join(retry.getRoot(), 'src', 'checkout.ts')));
      });
    }
  });

  describe('remove', () => {
    it('deletes a dirty worktree and leaves the original repository intact', async () => {
      const before = await snapshotRepository(realGit, fixture.root);
      const workspace = await create();
      const root = workspace.getRoot();
      const checkoutPath = path.join(root, 'src', 'checkout.ts');
      await writeFile(checkoutPath, (await readFile(checkoutPath, 'utf8')).replace(BUGGY_TAX, FIXED_TAX));
      await writeFile(path.join(root, 'untracked.txt'), 'scratch\n');

      await workspace.remove();

      assert.equal(workspace.removed, true);
      assert.equal(await exists(root), false);
      assert.deepEqual(await readdir(worktreesDirectory), []);
      assert.deepEqual(listWorktrees(realGit, fixture.root), [fixture.canonicalRoot]);
      assert.deepEqual(await snapshotRepository(realGit, fixture.root), before);
      assert.ok((await readFile(path.join(fixture.root, 'src', 'checkout.ts'), 'utf8')).includes(BUGGY_TAX));
    });

    it('is idempotent and safe to call concurrently', async () => {
      const workspace = await create();
      await Promise.all([workspace.remove(), workspace.remove()]);
      await workspace.remove();
      assert.equal(await exists(path.join(worktreesDirectory, workspace.name)), false);
      assert.deepEqual(listWorktrees(realGit, fixture.root), [fixture.canonicalRoot]);
    });

    it('makes the workspace unusable afterwards', async () => {
      const workspace = await create();
      await workspace.remove();
      await rejectsWithCode(Promise.resolve().then(() => workspace.getRoot()), 'workspace_removed');
      await rejectsWithCode(Promise.resolve().then(() => workspace.getSandbox()), 'workspace_removed');
      await rejectsWithCode(workspace.status(), 'workspace_removed');
    });

    it('succeeds when the worktree directory is already gone', async () => {
      const workspace = await create();
      git(realGit, fixture.root, 'worktree', 'remove', '--force', workspace.getRoot());
      await workspace.remove();
      assert.equal(workspace.removed, true);
    });

    it('refuses to delete a directory that replaced its worktree', async () => {
      const workspace = await create();
      const root = workspace.getRoot();
      git(realGit, fixture.root, 'worktree', 'remove', '--force', root);
      await mkdir(root);
      await writeFile(path.join(root, 'user-file.txt'), 'not ours\n');

      await rejectsWithCode(workspace.remove(), 'not_owned');
      assert.equal(await readFile(path.join(root, 'user-file.txt'), 'utf8'), 'not ours\n');
      assert.equal(workspace.removed, false);
      await rm(root, { recursive: true });
    });

    it('refuses to follow a symlink that replaced its worktree', POSIX_ONLY, async () => {
      const workspace = await create();
      const root = workspace.getRoot();
      git(realGit, fixture.root, 'worktree', 'remove', '--force', root);
      await writeFile(path.join(fixture.outside, 'precious.txt'), 'keep\n');
      await symlink(fixture.outside, root);

      await rejectsWithCode(workspace.remove(), 'not_owned');
      assert.equal(await readFile(path.join(fixture.outside, 'precious.txt'), 'utf8'), 'keep\n');
      assert.ok((await lstat(root)).isSymbolicLink());
      await rm(root);
    });
  });
});

describe('resolveGitExecutable', POSIX_ONLY, () => {
  let base: string;
  let realGit: GitExecutable;
  let brokenDirectory: string;
  let workingDirectory: string;

  before(async () => {
    realGit = await resolveGitExecutable();
    base = await mkdtemp(path.join(tmpdir(), 'devpilot-git-resolution-'));
    brokenDirectory = path.join(base, 'broken');
    workingDirectory = path.join(base, 'working');
    await mkdir(brokenDirectory);
    await mkdir(workingDirectory);
    await writeExecutable(
      path.join(brokenDirectory, 'git'),
      '#!/bin/sh\necho "You have not agreed to the Xcode license agreements." >&2\nexit 69\n',
    );
    await writeExecutable(path.join(workingDirectory, 'git'), `#!/bin/sh\nexec ${shellQuote(realGit.path)} "$@"\n`);
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('skips a PATH entry whose git fails to run, like the macOS Xcode shim', async () => {
    const resolved = await resolveGitExecutable({
      hostEnvironment: { PATH: [path.join(base, 'empty'), brokenDirectory, workingDirectory].join(path.delimiter) },
    });
    assert.equal(resolved.path, path.join(workingDirectory, 'git'));
    assert.match(resolved.version, /^git version /);
  });

  it('ignores relative PATH entries, even ones that lead to a working git', async () => {
    const relative = path.relative(process.cwd(), workingDirectory);
    assert.ok(!path.isAbsolute(relative));
    await rejectsWithCode(
      resolveGitExecutable({ hostEnvironment: { PATH: ['.', relative].join(path.delimiter) } }),
      'git_unavailable',
    );
  });

  it('returns a controlled error that explains why each candidate failed', async () => {
    const error = await rejectsWithCode(
      resolveGitExecutable({ hostEnvironment: { PATH: brokenDirectory } }),
      'git_unavailable',
    );
    assert.match(error.message, /exited with code 69: You have not agreed to the Xcode license/);
    await rejectsWithCode(resolveGitExecutable({ hostEnvironment: { PATH: '' } }), 'git_unavailable');
  });

  it('accepts an explicit absolute executable and rejects unusable ones', async () => {
    const explicit = path.join(workingDirectory, 'git');
    assert.equal((await resolveGitExecutable({ executable: explicit, hostEnvironment: { PATH: '' } })).path, explicit);
    for (const executable of ['git', path.join(base, 'missing-git'), path.join(brokenDirectory, 'git')]) {
      await rejectsWithCode(resolveGitExecutable({ executable }), 'git_unavailable');
    }
  });

  it('is used by create, so a missing git is reported before anything is written', async () => {
    const fixture = await createGitRepositoryFixture(realGit);
    try {
      await rejectsWithCode(
        GitWorktreeWorkspace.create(fixture.root, { hostEnvironment: { PATH: brokenDirectory } }),
        'git_unavailable',
      );
      assert.equal(await exists(path.join(fixture.root, '.devpilot')), false);
      await access(path.join(fixture.root, 'package.json'));
    } finally {
      await fixture.cleanup();
    }
  });
});
