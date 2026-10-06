import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createEvidenceId } from '@devpilot/core';
import {
  createReadFileTool,
  READ_FILE_TOOL_NAME,
  type ReadFileInput,
  type ReadFileOutput,
  type Tool,
} from '../src/index.js';
import {
  createSandboxFixture,
  expectError,
  expectSuccess,
  FIXTURE_ROOT,
  NOW,
  OUTSIDE_SECRET,
  runTool,
  toolContext,
  type SandboxFixture,
} from './support/sandbox-fixture.js';

describe('read_file', () => {
  let fixture: SandboxFixture;
  let tool: Tool<ReadFileInput, ReadFileOutput>;

  before(async () => {
    fixture = await createSandboxFixture();
    tool = createReadFileTool(fixture.sandbox);
  });
  after(async () => {
    await fixture.cleanup();
  });

  it('reads a valid file with full line information', async () => {
    const expected = (await readFile(path.join(FIXTURE_ROOT, 'src', 'discounts.ts'), 'utf8')).replace(/\n$/, '');
    const { output } = expectSuccess(await runTool(tool, { path: 'src/discounts.ts' }));

    assert.equal(output.path, 'src/discounts.ts');
    assert.equal(output.content, expected);
    assert.equal(output.totalLines, 22);
    assert.deepEqual(output.returnedRange, { startLine: 1, endLine: 22 });
    assert.equal(output.requestedRange, undefined);
  });

  it('supports line ranges', async () => {
    const { output } = expectSuccess(await runTool(tool, { path: 'src/discounts.ts', startLine: 13, endLine: 15 }));
    assert.equal(
      output.content,
      [
        'export function applyDiscount(subtotal: Cents, code?: string): Cents {',
        '  if (code === undefined) {',
        '    return subtotal;',
      ].join('\n'),
    );
    assert.deepEqual(output.requestedRange, { startLine: 13, endLine: 15 });
    assert.deepEqual(output.returnedRange, { startLine: 13, endLine: 15 });
    assert.equal(output.totalLines, 22);
  });

  it('supports open-ended ranges and clamps endLine to the end of the file', async () => {
    const fromLine = expectSuccess(await runTool(tool, { path: 'src/discounts.ts', startLine: 21 })).output;
    assert.equal(fromLine.content, '  return Math.round(subtotal * (1 - discount.percentOff / 100));\n}');
    assert.deepEqual(fromLine.returnedRange, { startLine: 21, endLine: 22 });

    const clamped = expectSuccess(await runTool(tool, { path: 'src/discounts.ts', startLine: 22, endLine: 500 })).output;
    assert.deepEqual(clamped.requestedRange, { startLine: 22, endLine: 500 });
    assert.deepEqual(clamped.returnedRange, { startLine: 22, endLine: 22 });
    assert.equal(clamped.content, '}');

    const toLine = expectSuccess(await runTool(tool, { path: 'src/discounts.ts', endLine: 1 })).output;
    assert.equal(toLine.content, "import type { Cents } from './money.js';");
  });

  it('produces grounded evidence for exactly what was returned', async () => {
    const { output, evidence } = expectSuccess(
      await runTool(tool, { path: 'src/discounts.ts', startLine: 13, endLine: 15 }, toolContext('action-7')),
    );
    assert.equal(evidence.length, 1);
    const [item] = evidence;
    assert.ok(item);
    assert.deepEqual(output.evidenceIds, [item.id]);
    assert.deepEqual(item.location, { type: 'file', path: 'src/discounts.ts', startLine: 13, endLine: 15 });
    assert.equal(item.content, output.content);
    assert.equal(item.kind, 'source_code');
    assert.deepEqual(item.source, { tool: READ_FILE_TOOL_NAME, actionId: 'action-7' });
    assert.equal(item.collectedAt, NOW);
    assert.equal(item.id, createEvidenceId({ tool: READ_FILE_TOOL_NAME, location: item.location, content: output.content }));
  });

  it('gives identical observations the same evidence ID across actions and times', async () => {
    const input = { path: 'src/cart.ts', startLine: 9, endLine: 12 };
    const first = expectSuccess(await runTool(tool, input, toolContext('action-1', NOW)));
    const second = expectSuccess(await runTool(tool, input, toolContext('action-2', '2026-06-01T12:00:00.000Z')));
    assert.deepEqual(first.output.evidenceIds, second.output.evidenceIds);

    const viaAbsolute = expectSuccess(await runTool(tool, { ...input, path: path.join(fixture.root, 'src/cart.ts') }));
    const viaSymlinkTarget = expectSuccess(await runTool(tool, { ...input, path: './src/../src/cart.ts' }));
    assert.deepEqual(viaAbsolute.output.evidenceIds, first.output.evidenceIds);
    assert.deepEqual(viaSymlinkTarget.output.evidenceIds, first.output.evidenceIds);
  });

  it('gives different observations different evidence IDs', async () => {
    const lines1to3 = expectSuccess(await runTool(tool, { path: 'src/money.ts', startLine: 1, endLine: 3 }));
    const lines1to4 = expectSuccess(await runTool(tool, { path: 'src/money.ts', startLine: 1, endLine: 4 }));
    const otherFile = expectSuccess(await runTool(tool, { path: 'src/cart.ts', startLine: 1, endLine: 3 }));
    const ids = new Set([...lines1to3.output.evidenceIds, ...lines1to4.output.evidenceIds, ...otherFile.output.evidenceIds]);
    assert.equal(ids.size, 3);

    const target = path.join(fixture.root, 'src', 'money.ts');
    const original = await readFile(target, 'utf8');
    try {
      await writeFile(target, original.replace('Math.round', 'Math.floor'));
      const changed = expectSuccess(await runTool(tool, { path: 'src/money.ts', startLine: 1, endLine: 4 }));
      assert.notDeepEqual(changed.output.evidenceIds, lines1to4.output.evidenceIds);
    } finally {
      await writeFile(target, original);
    }
  });

  it('reads in-repository symlinks under their canonical path', async () => {
    const { output, evidence } = expectSuccess(await runTool(tool, { path: 'src/money-alias.ts' }));
    assert.equal(output.path, 'src/money.ts');
    assert.equal(evidence[0]?.location.type === 'file' ? evidence[0].location.path : undefined, 'src/money.ts');
  });

  it('returns an empty file with a null range', async () => {
    const { output, evidence } = expectSuccess(await runTool(tool, { path: 'empty.txt' }));
    assert.equal(output.content, '');
    assert.equal(output.totalLines, 0);
    assert.equal(output.returnedRange, null);
    assert.deepEqual(evidence[0]?.location, { type: 'file', path: 'empty.txt' });
  });

  describe('rejects unsafe paths', () => {
    for (const unsafe of ['../outside/secret.txt', '../../etc/passwd', 'src/../../outside/secret.txt']) {
      it(`rejects ../ traversal: ${unsafe}`, async () => {
        expectError(await runTool(tool, { path: unsafe }), /outside the repository root/);
      });
    }

    it('rejects absolute paths outside the root', async () => {
      expectError(await runTool(tool, { path: '/etc/passwd' }), /outside the repository root/);
      expectError(await runTool(tool, { path: path.join(fixture.outside, 'secret.txt') }), /outside the repository root/);
      expectError(
        await runTool(tool, { path: path.join(fixture.prefixSibling, 'secret.txt') }),
        /outside the repository root/,
      );
    });

    it('rejects symlink escapes without leaking content', async () => {
      for (const escaping of ['leak.txt', 'src/outside-dir/secret.txt']) {
        const result = await runTool(tool, { path: escaping });
        expectError(result, /outside the repository root/);
        assert.ok(!JSON.stringify(result).includes(OUTSIDE_SECRET));
      }
    });
  });

  describe('negative paths', () => {
    it('rejects directories', async () => {
      expectError(await runTool(tool, { path: 'src' }), /directory, not a file/);
      expectError(await runTool(tool, { path: '.' }), /directory, not a file/);
    });

    it('rejects missing and binary files', async () => {
      expectError(await runTool(tool, { path: 'src/missing.ts' }), /does not exist/);
      expectError(await runTool(tool, { path: 'assets/logo.bin' }), /binary/);
    });

    it('rejects a startLine beyond the end of the file', async () => {
      expectError(await runTool(tool, { path: 'src/money.ts', startLine: 100 }), /beyond the end of src\/money\.ts \(9 lines\)/);
      expectError(await runTool(tool, { path: 'empty.txt', startLine: 1 }), /beyond the end/);
    });

    it('rejects invalid input at the schema boundary', () => {
      for (const input of [
        {},
        { path: '' },
        { path: 'src/money.ts', startLine: 0 },
        { path: 'src/money.ts', startLine: 1.5 },
        { path: 'src/money.ts', startLine: 5, endLine: 4 },
        { path: 42 },
      ]) {
        assert.equal(tool.inputSchema.safeParse(input).success, false, JSON.stringify(input));
      }
    });
  });
});
