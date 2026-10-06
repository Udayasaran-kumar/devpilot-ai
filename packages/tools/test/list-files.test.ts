import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createListFilesTool, type ListFilesInput, type ListFilesOutput, type Tool } from '../src/index.js';
import {
  createSandboxFixture,
  expectError,
  expectSuccess,
  runTool,
  type SandboxFixture,
} from './support/sandbox-fixture.js';

const EXPECTED_ROOT_LISTING = [
  { path: 'README.md', type: 'file' },
  { path: 'assets', type: 'directory' },
  { path: 'assets/logo.bin', type: 'file' },
  { path: 'empty.txt', type: 'file' },
  { path: 'leak.txt', type: 'symlink' },
  { path: 'package.json', type: 'file' },
  { path: 'src', type: 'directory' },
  { path: 'src/cart.ts', type: 'file' },
  { path: 'src/checkout.ts', type: 'file' },
  { path: 'src/discounts.ts', type: 'file' },
  { path: 'src/index.ts', type: 'file' },
  { path: 'src/money-alias.ts', type: 'symlink' },
  { path: 'src/money.ts', type: 'file' },
  { path: 'src/outside-dir', type: 'symlink' },
  { path: 'src/payment', type: 'directory' },
  { path: 'src/payment/fake-gateway.ts', type: 'file' },
  { path: 'src/payment/gateway.ts', type: 'file' },
  { path: 'test', type: 'directory' },
  { path: 'test/checkout.test.ts', type: 'file' },
];

describe('list_files', () => {
  let fixture: SandboxFixture;
  let tool: Tool<ListFilesInput, ListFilesOutput>;

  before(async () => {
    fixture = await createSandboxFixture();
    tool = createListFilesTool(fixture.sandbox);
  });
  after(async () => {
    await fixture.cleanup();
  });

  it('returns deterministic, sorted, repository-relative paths', async () => {
    const first = expectSuccess(await runTool(tool, {}));
    const second = expectSuccess(await runTool(tool, { path: '.' }));
    assert.equal(first.output.path, '.');
    assert.deepEqual(first.output.entries, EXPECTED_ROOT_LISTING);
    assert.deepEqual(second.output, first.output);
    assert.equal(first.output.truncated, false);
    assert.deepEqual(first.evidence, []);
  });

  it('lists symlinks without following them and skips .git and node_modules', async () => {
    const { output } = expectSuccess(await runTool(tool, {}));
    const paths = output.entries.map((entry) => entry.path);
    assert.ok(paths.every((entry) => !entry.startsWith('src/outside-dir/')));
    assert.ok(paths.every((entry) => !entry.startsWith('.git') && !entry.startsWith('node_modules')));
  });

  it('respects maxResults and reports truncation', async () => {
    const three = expectSuccess(await runTool(tool, { maxResults: 3 })).output;
    assert.deepEqual(three.entries, EXPECTED_ROOT_LISTING.slice(0, 3));
    assert.equal(three.truncated, true);

    const exact = expectSuccess(await runTool(tool, { maxResults: EXPECTED_ROOT_LISTING.length })).output;
    assert.equal(exact.entries.length, EXPECTED_ROOT_LISTING.length);
    assert.equal(exact.truncated, false);
  });

  it('scopes the listing to a subdirectory with root-relative paths', async () => {
    const { output } = expectSuccess(await runTool(tool, { path: 'src/payment' }));
    assert.equal(output.path, 'src/payment');
    assert.deepEqual(output.entries, [
      { path: 'src/payment/fake-gateway.ts', type: 'file' },
      { path: 'src/payment/gateway.ts', type: 'file' },
    ]);
  });

  it('allows explicitly listing an ignored directory', async () => {
    const { output } = expectSuccess(await runTool(tool, { path: 'node_modules' }));
    assert.deepEqual(output.entries, [
      { path: 'node_modules/dep', type: 'directory' },
      { path: 'node_modules/dep/index.js', type: 'file' },
    ]);
  });

  describe('rejects unsafe paths', () => {
    for (const unsafe of ['..', '../outside', '../../etc', 'src/../..', 'src/outside-dir', '/etc']) {
      it(`rejects ${unsafe}`, async () => {
        expectError(await runTool(tool, { path: unsafe }), /outside the repository root/);
      });
    }

    it('rejects outside absolute paths and prefix siblings', async () => {
      expectError(await runTool(tool, { path: fixture.outside }), /outside the repository root/);
      expectError(await runTool(tool, { path: fixture.prefixSibling }), /outside the repository root/);
    });
  });

  describe('negative paths', () => {
    it('rejects files and missing directories', async () => {
      expectError(await runTool(tool, { path: 'src/cart.ts' }), /file, not a directory/);
      expectError(await runTool(tool, { path: 'src/missing' }), /does not exist/);
    });

    it('rejects invalid input at the schema boundary', () => {
      for (const input of [{ path: '' }, { maxResults: 0 }, { maxResults: 2001 }, { maxResults: -1 }]) {
        assert.equal(tool.inputSchema.safeParse(input).success, false, JSON.stringify(input));
      }
    });
  });
});
