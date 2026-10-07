import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { diffFingerprints, fingerprintTree } from '../src/index.js';

describe('fingerprintTree', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'devpilot-fingerprint-'));
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    await writeFile(path.join(root, 'README.md'), '# fixture\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const changesAfter = async (change: () => Promise<void>) => {
    const before = await fingerprintTree(root);
    await change();
    return diffFingerprints(before, await fingerprintTree(root));
  };

  it('is stable for an unchanged tree', async () => {
    const first = await fingerprintTree(root);
    const second = await fingerprintTree(root);
    assert.equal(first.digest, second.digest);
    assert.deepEqual([...first.entries.keys()], ['README.md', 'src', 'src/a.ts']);
    assert.deepEqual(diffFingerprints(first, second), []);
  });

  it('reports content changes, additions, and deletions', async () => {
    assert.deepEqual(await changesAfter(() => writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 2;\n')), ['src/a.ts']);
    assert.deepEqual(await changesAfter(() => writeFile(path.join(root, 'new.txt'), '')), ['new.txt']);
    assert.deepEqual(await changesAfter(() => rm(path.join(root, 'README.md'))), ['README.md']);
  });

  it('reports executable-bit changes and symlink retargeting without following links', async () => {
    assert.deepEqual(await changesAfter(() => chmod(path.join(root, 'src', 'a.ts'), 0o755)), ['src/a.ts']);
    await symlink('src/a.ts', path.join(root, 'link'));
    const before = await fingerprintTree(root);
    assert.equal(before.entries.get('link'), 'symlink src/a.ts');
    await rm(path.join(root, 'link'));
    await symlink('README.md', path.join(root, 'link'));
    assert.deepEqual(diffFingerprints(before, await fingerprintTree(root)), ['link']);
  });

  it('skips .git, .devpilot, and node_modules at any depth', async () => {
    const changes = await changesAfter(async () => {
      for (const directory of ['.git', '.devpilot', 'node_modules', path.join('src', 'node_modules')]) {
        await mkdir(path.join(root, directory), { recursive: true });
        await writeFile(path.join(root, directory, 'file'), 'ignored\n');
      }
    });
    assert.deepEqual(changes, []);
  });
});
