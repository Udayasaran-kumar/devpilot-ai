import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyHunks, parseUnifiedDiff, PatchParseError, type FilePatch } from '../src/unified-diff.js';

const patch = (...lines: string[]): string => `${lines.join('\n')}\n`;

function parseOne(text: string): FilePatch {
  const files = parseUnifiedDiff(text);
  assert.equal(files.length, 1);
  return files[0] as FilePatch;
}

function expectParseError(text: string, code: 'invalid_patch' | 'unsafe_path', pattern: RegExp): void {
  assert.throws(
    () => parseUnifiedDiff(text),
    (error: unknown) => error instanceof PatchParseError && error.code === code && pattern.test(error.message),
  );
}

function applied(original: string, text: string): string {
  const result = applyHunks(original, parseOne(text));
  assert.ok(result.ok, result.ok ? undefined : result.reason);
  return result.content;
}

const MODIFY = patch(
  'diff --git a/src/a.ts b/src/a.ts',
  'index 0123abc..4567def 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -2,3 +2,3 @@ function header',
  ' two',
  '-three',
  '+THREE',
  ' four',
);
const FILE = 'one\ntwo\nthree\nfour\nfive\n';

describe('parseUnifiedDiff', () => {
  it('parses git-style modify, create, and delete sections', () => {
    const files = parseUnifiedDiff(
      MODIFY +
        patch(
          'diff --git a/new.txt b/new.txt',
          'new file mode 100644',
          'index 0000000..1111111',
          '--- /dev/null',
          '+++ b/new.txt',
          '@@ -0,0 +1,2 @@',
          '+hello',
          '+world',
          'diff --git a/old.txt b/old.txt',
          'deleted file mode 100755',
          'index 1111111..0000000',
          '--- a/old.txt',
          '+++ /dev/null',
          '@@ -1 +0,0 @@',
          '-bye',
        ),
    );
    assert.deepEqual(
      files.map(({ path, operation, additions, deletions }) => ({ path, operation, additions, deletions })),
      [
        { path: 'src/a.ts', operation: 'modify', additions: 1, deletions: 1 },
        { path: 'new.txt', operation: 'create', additions: 2, deletions: 0 },
        { path: 'old.txt', operation: 'delete', additions: 0, deletions: 1 },
      ],
    );
  });

  it('accepts sections without a diff --git header and timestamps after a tab', () => {
    const file = parseOne(patch('--- a/x.txt\t2026-01-01', '+++ b/x.txt\t2026-01-02', '@@ -1 +1 @@', '-a', '+b'));
    assert.equal(file.path, 'x.txt');
  });

  it('returns absolute header paths unchanged so path validation can reject them', () => {
    assert.equal(parseOne(patch('--- /dev/null', '+++ /etc/passwd', '@@ -0,0 +1 @@', '+x')).path, '/etc/passwd');
    assert.equal(parseOne(patch('--- /dev/null', '+++ b/../x', '@@ -0,0 +1 @@', '+x')).path, '../x');
  });

  const malformed: Array<[string, string, RegExp]> = [
    ['a blank line', '\n', /expected a "---" file header/],
    ['prose', 'Here is the fix you asked for\n', /expected a "---" file header/],
    ['missing +++', patch('--- a/x', '@@ -1 +1 @@', '-a', '+b'), /expected "\+\+\+"/],
    ['malformed hunk header', patch('--- a/x', '+++ b/x', '@@ -1 +1', '-a', '+b'), /malformed hunk header/],
    ['no hunks', patch('--- a/x', '+++ b/x'), /has no hunks/],
    ['hunk shorter than declared', patch('--- a/x', '+++ b/x', '@@ -1,3 +1,3 @@', ' a', '-b', '+c'), /ends before/],
    ['hunk longer than declared', patch('--- a/x', '+++ b/x', '@@ -1 +1 @@', '-a', '+b', '+c'), /expected a "---"/],
    ['unexpected hunk line', patch('--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', '*a', '-b', '+c'), /unexpected line/],
    ['empty hunk', patch('--- a/x', '+++ b/x', '@@ -1,0 +1,0 @@'), /empty hunk/],
    ['hunks out of order', patch('--- a/x', '+++ b/x', '@@ -5 +5 @@', '-a', '+b', '@@ -2 +2 @@', '-c', '+d'), /ascending/],
    ['GIT binary patch', patch('diff --git a/x.bin b/x.bin', 'GIT binary patch', 'literal 4'), /binary/],
    ['Binary files differ', patch('diff --git a/x.bin b/x.bin', 'Binary files a/x.bin and b/x.bin differ'), /binary/],
    ['rename headers', patch('diff --git a/x b/y', 'similarity index 90%', 'rename from x', 'rename to y'), /renames/],
    ['mode change', patch('diff --git a/x b/x', 'old mode 100644', 'new mode 100755'), /mode changes/],
    ['implicit rename', patch('--- a/x', '+++ b/y', '@@ -1 +1 @@', '-a', '+b'), /renames are not supported/],
    ['both sides /dev/null', patch('--- /dev/null', '+++ /dev/null', '@@ -0,0 +1 @@', '+a'), /both sides/],
    ['quoted path', patch('--- "a/x y"', '+++ "b/x y"', '@@ -1 +1 @@', '-a', '+b'), /quoted/],
    ['missing a/ prefix', patch('--- x', '+++ x', '@@ -1 +1 @@', '-a', '+b'), /prefixes/],
    ['CRLF header', patch('--- a/x\r', '+++ b/x\r', '@@ -1 +1 @@', '-a', '+b'), /control characters/],
    [
      'diff --git header disagreeing with ---/+++',
      patch('diff --git a/x b/x --unsafe-paths', '--- a/x', '+++ b/x', '@@ -1 +1 @@', '-a', '+b'),
      /does not match/,
    ],
    [
      'same file twice',
      patch('--- a/x', '+++ b/x', '@@ -1 +1 @@', '-a', '+b', '--- a/X', '+++ b/X', '@@ -1 +1 @@', '-b', '+c'),
      /more than once/,
    ],
    ['create with context', patch('--- /dev/null', '+++ b/n', '@@ -1 +1,2 @@', ' a', '+b'), /single hunk of added lines/],
    ['delete with additions', patch('--- a/x', '+++ /dev/null', '@@ -1 +1 @@', '-a', '+b'), /only removed lines/],
    [
      'misplaced no-newline marker',
      patch('--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', ' a', '\\ No newline at end of file', '-b', '+c'),
      /after "\\ No newline/,
    ],
  ];
  for (const [label, text, pattern] of malformed) {
    it(`rejects ${label} as invalid_patch`, () => expectParseError(text, 'invalid_patch', pattern));
  }

  it('rejects symlink and submodule modes as unsafe', () => {
    expectParseError(
      patch('diff --git a/link b/link', 'new file mode 120000', '--- /dev/null', '+++ b/link', '@@ -0,0 +1 @@', '+/etc'),
      'unsafe_path',
      /symlinks/,
    );
    expectParseError(
      patch('diff --git a/sub b/sub', 'index 1111111..2222222 160000', '--- a/sub', '+++ b/sub', '@@ -1 +1 @@', '-a', '+b'),
      'unsafe_path',
      /submodules/,
    );
  });
});

describe('applyHunks', () => {
  it('applies a hunk at its stated position', () => {
    assert.equal(applied(FILE, MODIFY), 'one\ntwo\nTHREE\nfour\nfive\n');
  });

  it('finds a hunk whose line numbers are off', () => {
    assert.equal(applied(`zero\nminus\n${FILE}`, MODIFY), 'zero\nminus\none\ntwo\nTHREE\nfour\nfive\n');
  });

  it('refuses a hunk whose context does not match', () => {
    const result = applyHunks('one\ntwo\n3\nfour\n', parseOne(MODIFY));
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /hunk 1 of src\/a\.ts does not match/);
  });

  it('treats an empty patch line as empty context, as git does', () => {
    const text = patch('--- a/x', '+++ b/x', '@@ -1,3 +1,3 @@', ' a', '', '-c', '+C');
    assert.equal(applied('a\n\nc\n', text), 'a\n\nC\n');
  });

  it('handles files without a trailing newline', () => {
    const replaceLast = patch(
      '--- a/x',
      '+++ b/x',
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '\\ No newline at end of file',
      '+B',
      '\\ No newline at end of file',
    );
    assert.equal(applied('a\nb', replaceLast), 'a\nB');
    const addNewline = patch('--- a/x', '+++ b/x', '@@ -1 +1 @@', '-b', '\\ No newline at end of file', '+b');
    assert.equal(applied('b', addNewline), 'b\n');
    const dropNewline = patch('--- a/x', '+++ b/x', '@@ -1 +1 @@', '-b', '+b', '\\ No newline at end of file');
    assert.equal(applied('b\n', dropNewline), 'b');
    assert.equal(applyHunks('a\nb\n', parseOne(replaceLast)).ok, false, 'marker requires a missing newline');
    assert.equal(applyHunks('b', parseOne(dropNewline)).ok, false, 'unmarked hunk requires a newline');
  });

  it('creates and deletes whole files only', () => {
    const create = patch('--- /dev/null', '+++ b/n.txt', '@@ -0,0 +1,2 @@', '+x', '+y');
    assert.equal(applied('', create), 'x\ny\n');
    const remove = patch('--- a/d.txt', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-x', '-y');
    assert.equal(applied('x\ny\n', remove), '');
    const partial = applyHunks('x\ny\nz\n', parseOne(remove));
    assert.equal(partial.ok, false);
    assert.match(partial.ok ? '' : partial.reason, /does not remove the whole file/);
  });

  it('applies several hunks in order', () => {
    const text = patch('--- a/x', '+++ b/x', '@@ -1 +1 @@', '-one', '+ONE', '@@ -5 +5 @@', '-five', '+FIVE');
    assert.equal(applied(FILE, text), 'ONE\ntwo\nthree\nfour\nFIVE\n');
  });
});
