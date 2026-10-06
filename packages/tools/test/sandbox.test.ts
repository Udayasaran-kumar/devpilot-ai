import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { RepositorySandbox, SandboxError, type SandboxErrorCode } from '../src/index.js';
import { createSandboxFixture, OUTSIDE_SECRET, type SandboxFixture } from './support/sandbox-fixture.js';

async function assertSandboxError(promise: Promise<unknown>, code: SandboxErrorCode): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof SandboxError, `expected SandboxError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    assert.ok(!error.message.includes(OUTSIDE_SECRET));
    return true;
  });
}

describe('RepositorySandbox', () => {
  let fixture: SandboxFixture;
  before(async () => {
    fixture = await createSandboxFixture();
  });
  after(async () => {
    await fixture.cleanup();
  });

  describe('resolveSafePath', () => {
    it('resolves relative paths to canonical repository-relative paths', async () => {
      const resolved = await fixture.sandbox.resolveSafePath('src/cart.ts');
      assert.equal(resolved.relativePath, 'src/cart.ts');
      assert.equal(resolved.type, 'file');
      assert.equal(resolved.absolutePath, path.join(fixture.sandbox.root, 'src', 'cart.ts'));
    });

    it('normalizes in-repository dot segments', async () => {
      assert.equal((await fixture.sandbox.resolveSafePath('src/../src/./cart.ts')).relativePath, 'src/cart.ts');
      const root = await fixture.sandbox.resolveSafePath('.');
      assert.equal(root.relativePath, '.');
      assert.equal(root.type, 'directory');
    });

    it('accepts absolute paths inside the root via both the configured and canonical root', async () => {
      const viaConfigured = await fixture.sandbox.resolveSafePath(path.join(fixture.root, 'src', 'cart.ts'));
      const viaCanonical = await fixture.sandbox.resolveSafePath(path.join(fixture.sandbox.root, 'src', 'cart.ts'));
      assert.equal(viaConfigured.relativePath, 'src/cart.ts');
      assert.equal(viaCanonical.relativePath, 'src/cart.ts');
    });

    for (const unsafe of [
      '..',
      '../outside/secret.txt',
      '../../etc/passwd',
      '../../../../../../../../etc/passwd',
      'src/../../outside/secret.txt',
      'src/payment/../../../outside',
      '../repo-evil/secret.txt',
    ]) {
      it(`rejects ../ traversal: ${unsafe}`, async () => {
        await assertSandboxError(fixture.sandbox.resolveSafePath(unsafe), 'outside_root');
      });
    }

    it('rejects absolute paths outside the root', async () => {
      await assertSandboxError(fixture.sandbox.resolveSafePath('/etc/passwd'), 'outside_root');
      await assertSandboxError(
        fixture.sandbox.resolveSafePath(path.join(fixture.outside, 'secret.txt')),
        'outside_root',
      );
      await assertSandboxError(fixture.sandbox.resolveSafePath(fixture.base), 'outside_root');
    });

    it('rejects sibling directories that share the root as a string prefix', async () => {
      assert.ok(fixture.prefixSibling.startsWith(fixture.root));
      await assertSandboxError(
        fixture.sandbox.resolveSafePath(path.join(fixture.prefixSibling, 'secret.txt')),
        'outside_root',
      );
    });

    it('rejects a file symlink that escapes the root', async () => {
      await assertSandboxError(fixture.sandbox.resolveSafePath('leak.txt'), 'outside_root');
      await assertSandboxError(fixture.sandbox.resolveSafePath(path.join(fixture.root, 'leak.txt')), 'outside_root');
    });

    it('rejects a directory symlink that escapes the root, and paths through it', async () => {
      await assertSandboxError(fixture.sandbox.resolveSafePath('src/outside-dir'), 'outside_root');
      await assertSandboxError(fixture.sandbox.resolveSafePath('src/outside-dir/secret.txt'), 'outside_root');
    });

    it('does not reveal whether files exist outside the root', async () => {
      await assertSandboxError(fixture.sandbox.resolveSafePath('src/outside-dir/does-not-exist.txt'), 'outside_root');
      await assertSandboxError(fixture.sandbox.resolveSafePath('../does-not-exist.txt'), 'outside_root');
      await assertSandboxError(fixture.sandbox.resolveSafePath('/definitely/not/here'), 'outside_root');
    });

    it('follows in-repository symlinks to their canonical path', async () => {
      const resolved = await fixture.sandbox.resolveSafePath('src/money-alias.ts');
      assert.equal(resolved.relativePath, 'src/money.ts');
    });

    it('reports missing paths inside the root as not_found', async () => {
      await assertSandboxError(fixture.sandbox.resolveSafePath('src/missing.ts'), 'not_found');
      await assertSandboxError(fixture.sandbox.resolveSafePath('src/cart.ts/child'), 'not_found');
    });

    it('rejects empty paths and paths containing NUL bytes', async () => {
      await assertSandboxError(fixture.sandbox.resolveSafePath(''), 'invalid_path');
      await assertSandboxError(fixture.sandbox.resolveSafePath('src/cart.ts\0.png'), 'invalid_path');
    });
  });

  describe('readFile', () => {
    it('reads UTF-8 text with a canonical path', async () => {
      const file = await fixture.sandbox.readFile('src/money.ts');
      assert.equal(file.path, 'src/money.ts');
      assert.match(file.content, /export function toCents/);
      assert.equal(file.sizeBytes, Buffer.byteLength(file.content));
    });

    it('rejects directories, binary files, and escaping symlinks', async () => {
      await assertSandboxError(fixture.sandbox.readFile('src'), 'not_a_file');
      await assertSandboxError(fixture.sandbox.readFile('assets/logo.bin'), 'not_text');
      await assertSandboxError(fixture.sandbox.readFile('leak.txt'), 'outside_root');
    });

    it('rejects invalid UTF-8', async () => {
      await writeFile(path.join(fixture.root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
      try {
        await assertSandboxError(fixture.sandbox.readFile('latin1.txt'), 'not_text');
      } finally {
        await rm(path.join(fixture.root, 'latin1.txt'));
      }
    });

    it('enforces the file size limit', async () => {
      const small = await RepositorySandbox.create(fixture.root, { maxFileBytes: 16 });
      await assertSandboxError(small.readFile('src/checkout.ts'), 'file_too_large');
    });
  });

  describe('search and listFiles argument validation', () => {
    it('rejects empty queries and non-positive limits', async () => {
      await assertSandboxError(fixture.sandbox.search(''), 'invalid_argument');
      await assertSandboxError(fixture.sandbox.search('x', { maxResults: 0 }), 'invalid_argument');
      await assertSandboxError(fixture.sandbox.listFiles({ maxResults: 1.5 }), 'invalid_argument');
    });

    it('caps oversized limits instead of failing', async () => {
      const result = await fixture.sandbox.listFiles({ maxResults: 1_000_000 });
      assert.equal(result.truncated, false);
    });

    it('never yields content from outside the root', async () => {
      const result = await fixture.sandbox.search(OUTSIDE_SECRET);
      assert.deepEqual(result.matches, []);
      const listing = await fixture.sandbox.listFiles();
      assert.ok(listing.entries.every((entry) => !entry.path.startsWith('src/outside-dir/')));
    });
  });

  describe('create', () => {
    it('rejects missing roots and roots that are files', async () => {
      await assertSandboxError(RepositorySandbox.create(path.join(fixture.base, 'nope')), 'not_found');
      await assertSandboxError(RepositorySandbox.create(path.join(fixture.root, 'package.json')), 'not_a_directory');
      await assertSandboxError(RepositorySandbox.create(fixture.root, { maxFileBytes: 0 }), 'invalid_argument');
    });

    it('stores the canonical root', async () => {
      assert.equal(path.isAbsolute(fixture.sandbox.root), true);
      assert.equal((await RepositorySandbox.create(fixture.sandbox.root)).root, fixture.sandbox.root);
    });
  });

  it('rejects symlink loops', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'devpilot-loop-'));
    try {
      await symlink('loop-b', path.join(base, 'loop-a'));
      await symlink('loop-a', path.join(base, 'loop-b'));
      const sandbox = await RepositorySandbox.create(base);
      await assertSandboxError(sandbox.resolveSafePath('loop-a'), 'invalid_path');
      const listing = await sandbox.listFiles();
      assert.deepEqual(listing.entries, [
        { path: 'loop-a', type: 'symlink' },
        { path: 'loop-b', type: 'symlink' },
      ]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
