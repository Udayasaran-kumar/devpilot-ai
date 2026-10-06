import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  createReadFileTool,
  createSearchCodeTool,
  SEARCH_CODE_TOOL_NAME,
  type SearchCodeInput,
  type SearchCodeOutput,
  type Tool,
} from '../src/index.js';
import {
  createSandboxFixture,
  expectError,
  expectSuccess,
  OUTSIDE_SECRET,
  runTool,
  toolContext,
  type SandboxFixture,
} from './support/sandbox-fixture.js';

describe('search_code', () => {
  let fixture: SandboxFixture;
  let tool: Tool<SearchCodeInput, SearchCodeOutput>;

  before(async () => {
    fixture = await createSandboxFixture();
    tool = createSearchCodeTool(fixture.sandbox);
  });
  after(async () => {
    await fixture.cleanup();
  });

  it('finds expected matches with correct relative paths, line numbers, and columns', async () => {
    const { output } = expectSuccess(await runTool(tool, { query: 'applyDiscount' }));
    assert.equal(output.path, '.');
    assert.deepEqual(
      output.matches.map(({ path: file, line, column, text }) => ({ file, line, column, text })),
      [
        { file: 'src/checkout.ts', line: 2, column: 10, text: "import { applyDiscount } from './discounts.ts';" },
        {
          file: 'src/checkout.ts',
          line: 32,
          column: 22,
          text: '  const discounted = applyDiscount(subtotal, options.discountCode);',
        },
        {
          file: 'src/discounts.ts',
          line: 13,
          column: 17,
          text: 'export function applyDiscount(subtotal: Cents, code?: string): Cents {',
        },
      ],
    );
    assert.equal(output.truncated, false);
  });

  it('skips binary files, symlinks, .git, and node_modules', async () => {
    const { output } = expectSuccess(await runTool(tool, { query: 'applyDiscount' }));
    const files = new Set(output.matches.map((match) => match.path));
    for (const excluded of ['assets/logo.bin', 'leak.txt', 'src/outside-dir/secret.txt', 'node_modules/dep/index.js', '.git/HEAD']) {
      assert.ok(!files.has(excluded), excluded);
    }
    assert.equal(output.filesSkipped, 1);
  });

  it('never returns content from outside the root', async () => {
    const result = await runTool(tool, { query: OUTSIDE_SECRET });
    assert.deepEqual(expectSuccess(result).output.matches, []);
  });

  it('respects maxResults and reports truncation', async () => {
    const two = expectSuccess(await runTool(tool, { query: 'applyDiscount', maxResults: 2 })).output;
    assert.equal(two.matches.length, 2);
    assert.equal(two.truncated, true);
    assert.deepEqual(
      two.matches.map((match) => `${match.path}:${match.line}`),
      ['src/checkout.ts:2', 'src/checkout.ts:32'],
    );

    const exact = expectSuccess(await runTool(tool, { query: 'applyDiscount', maxResults: 3 })).output;
    assert.equal(exact.matches.length, 3);
    assert.equal(exact.truncated, false);

    const one = expectSuccess(await runTool(tool, { query: 'readonly', maxResults: 1 })).output;
    assert.equal(one.matches.length, 1);
    assert.equal(one.truncated, true);
  });

  it('restricts the search to a scoped directory or file', async () => {
    const directory = expectSuccess(await runTool(tool, { query: 'ChargeRequest', path: 'src/payment' })).output;
    assert.equal(directory.path, 'src/payment');
    assert.ok(directory.matches.length > 0);
    assert.ok(directory.matches.every((match) => match.path.startsWith('src/payment/')));

    const file = expectSuccess(await runTool(tool, { query: 'applyDiscount', path: 'src/checkout.ts' })).output;
    assert.equal(file.path, 'src/checkout.ts');
    assert.deepEqual(
      file.matches.map((match) => match.line),
      [2, 32],
    );
  });

  it('is case-sensitive and returns no matches for absent text', async () => {
    assert.deepEqual(expectSuccess(await runTool(tool, { query: 'applydiscount' })).output.matches, []);
    const none = expectSuccess(await runTool(tool, { query: 'no-such-text-anywhere' })).output;
    assert.deepEqual(none.matches, []);
    assert.equal(none.truncated, false);
  });

  it('produces one grounded evidence item per match', async () => {
    const { output, evidence } = expectSuccess(
      await runTool(tool, { query: 'TAX_RATE' }, toolContext('action-3')),
    );
    assert.equal(evidence.length, output.matches.length);
    for (const [index, match] of output.matches.entries()) {
      const item = evidence[index];
      assert.ok(item);
      assert.equal(match.evidenceId, item.id);
      assert.equal(item.kind, 'search_result');
      assert.equal(item.content, match.text);
      assert.deepEqual(item.location, { type: 'file', path: match.path, startLine: match.line, endLine: match.line });
      assert.deepEqual(item.source, { tool: SEARCH_CODE_TOOL_NAME, actionId: 'action-3' });
    }
  });

  it('produces deterministic evidence IDs for identical observations', async () => {
    const first = expectSuccess(await runTool(tool, { query: 'applyDiscount' }, toolContext('action-1')));
    const second = expectSuccess(
      await runTool(tool, { query: 'applyDiscount' }, toolContext('action-9', '2026-03-03T00:00:00.000Z')),
    );
    assert.deepEqual(
      first.evidence.map((item) => item.id),
      second.evidence.map((item) => item.id),
    );
    assert.equal(new Set(first.evidence.map((item) => item.id)).size, first.evidence.length);
  });

  it('distinguishes its observations from read_file observations of the same line', async () => {
    const search = expectSuccess(await runTool(tool, { query: 'export const TAX_RATE' })).output;
    const match = search.matches[0];
    assert.ok(match);
    const read = expectSuccess(
      await runTool(createReadFileTool(fixture.sandbox), { path: match.path, startLine: match.line, endLine: match.line }),
    ).output;
    assert.equal(read.content, match.text);
    assert.notEqual(read.evidenceIds[0], match.evidenceId);
  });

  describe('rejects unsafe scoped paths', () => {
    for (const unsafe of ['..', '../outside', '../../etc', 'src/../../outside', 'leak.txt', 'src/outside-dir']) {
      it(`rejects ${unsafe}`, async () => {
        expectError(await runTool(tool, { query: 'applyDiscount', path: unsafe }), /outside the repository root/);
      });
    }

    it('rejects absolute scopes outside the root', async () => {
      expectError(await runTool(tool, { query: 'root', path: '/etc' }), /outside the repository root/);
      expectError(await runTool(tool, { query: 'x', path: fixture.outside }), /outside the repository root/);
      expectError(await runTool(tool, { query: 'x', path: fixture.prefixSibling }), /outside the repository root/);
    });

    it('accepts absolute scopes inside the root', async () => {
      const { output } = expectSuccess(
        await runTool(tool, { query: 'applyDiscount', path: path.join(fixture.root, 'src') }),
      );
      assert.equal(output.path, 'src');
      assert.equal(output.matches.length, 3);
    });
  });

  describe('negative paths', () => {
    it('reports missing scopes', async () => {
      expectError(await runTool(tool, { query: 'x', path: 'src/missing' }), /does not exist/);
    });

    it('rejects invalid input at the schema boundary', () => {
      for (const input of [
        {},
        { query: '' },
        { query: 'x', maxResults: 0 },
        { query: 'x', maxResults: 501 },
        { query: 'x', maxResults: 2.5 },
        { query: 'x', path: '' },
        { query: 'x'.repeat(1001) },
      ]) {
        assert.equal(tool.inputSchema.safeParse(input).success, false, JSON.stringify(input).slice(0, 80));
      }
    });
  });
});
