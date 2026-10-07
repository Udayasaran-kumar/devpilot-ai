import type { PatchFileOperation } from '@devpilot/core';

export const MAX_PATCH_FILES = 100;

export type DiffLineKind = ' ' | '-' | '+';

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
}

export interface Hunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: readonly DiffLine[];
  /** The hunk's last old-side line is the end of a file without a trailing newline. */
  readonly oldNoNewlineAtEnd: boolean;
  readonly newNoNewlineAtEnd: boolean;
}

export interface FilePatch {
  /** Path relative to the worktree root, with the `a/` or `b/` prefix removed. Not yet validated. */
  readonly path: string;
  readonly operation: PatchFileOperation;
  readonly hunks: readonly Hunk[];
  readonly additions: number;
  readonly deletions: number;
}

/** A diff the parser refuses: malformed, unsupported, or (for symlink/submodule modes) unsafe. */
export class PatchParseError extends Error {
  override readonly name = 'PatchParseError';
  readonly code: 'invalid_patch' | 'unsafe_path';

  constructor(code: 'invalid_patch' | 'unsafe_path', message: string) {
    super(message);
    this.code = code;
  }
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
const INDEX_HEADER = /^index [0-9a-f]+\.\.[0-9a-f]+(?: (\d+))?$/;
const FILE_MODE_HEADER = /^(new|deleted) file mode (\d+)$/;
const UNSUPPORTED_HEADER =
  /^(old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to) /;
const REGULAR_FILE_MODES = new Set(['100644', '100755']);
const DEV_NULL = '/dev/null';

/**
 * Strict parser for git-style unified diffs: `--- a/<path>` / `+++ b/<path>`
 * (or `/dev/null`) followed by hunks, optionally preceded by `diff --git`,
 * `index`, and `new`/`deleted file mode` lines. Anything else, including
 * binary patches, renames, copies, mode changes, and quoted paths, is refused
 * rather than guessed at. The text is never rewritten.
 */
export function parseUnifiedDiff(text: string): FilePatch[] {
  const reader = new LineReader(text);
  const files: FilePatch[] = [];
  while (!reader.done) {
    files.push(parseFilePatch(reader));
    if (files.length > MAX_PATCH_FILES) {
      throw invalid(`patch changes more than ${MAX_PATCH_FILES} files`);
    }
  }
  if (files.length === 0) {
    throw invalid('patch contains no file changes');
  }
  const seen = new Set<string>();
  for (const file of files) {
    const key = file.path.toLowerCase();
    if (seen.has(key)) {
      throw invalid(`patch changes ${JSON.stringify(file.path)} more than once`);
    }
    seen.add(key);
  }
  return files;
}

function parseFilePatch(reader: LineReader): FilePatch {
  const gitHeader = reader.peek()?.startsWith('diff --git ') ? reader.next() : undefined;
  let declaredMode: { readonly kind: 'new' | 'deleted' } | undefined;

  for (;;) {
    const line = reader.peek();
    if (line === undefined) {
      throw invalid(`line ${reader.lineNumber}: file section has no "---" header or hunks`);
    }
    if (line.startsWith('--- ')) break;
    if (line === 'GIT binary patch' || /^Binary files .* differ$/.test(line)) {
      throw invalid(`line ${reader.lineNumber + 1}: binary patches are not supported`);
    }
    if (UNSUPPORTED_HEADER.test(line)) {
      throw invalid(`line ${reader.lineNumber + 1}: renames, copies, and mode changes are not supported`);
    }
    if (gitHeader === undefined || line.startsWith('diff --git ')) {
      throw invalid(`line ${reader.lineNumber + 1}: expected a "---" file header, got ${excerpt(line)}`);
    }
    const index = INDEX_HEADER.exec(line);
    const fileMode = FILE_MODE_HEADER.exec(line);
    if (index) {
      if (index[1] !== undefined) checkFileMode(index[1], reader.lineNumber + 1);
    } else if (fileMode) {
      checkFileMode(fileMode[2] ?? '', reader.lineNumber + 1);
      declaredMode = { kind: fileMode[1] === 'new' ? 'new' : 'deleted' };
    } else {
      throw invalid(`line ${reader.lineNumber + 1}: unsupported header ${excerpt(line)}`);
    }
    reader.next();
  }

  const oldPath = parseHeaderPath(reader.next() ?? '', '--- ', 'a/', reader.lineNumber);
  const newHeader = reader.next();
  if (newHeader === undefined || !newHeader.startsWith('+++ ')) {
    throw invalid(`line ${reader.lineNumber}: expected "+++" after "---"`);
  }
  const newPath = parseHeaderPath(newHeader, '+++ ', 'b/', reader.lineNumber);

  let operation: PatchFileOperation;
  let path: string;
  if (oldPath === null && newPath === null) {
    throw invalid(`line ${reader.lineNumber}: both sides of a file header are ${DEV_NULL}`);
  } else if (oldPath === null) {
    operation = 'create';
    path = newPath as string;
  } else if (newPath === null) {
    operation = 'delete';
    path = oldPath;
  } else if (oldPath !== newPath) {
    throw invalid(`line ${reader.lineNumber}: renames are not supported (${excerpt(oldPath)} -> ${excerpt(newPath)})`);
  } else {
    operation = 'modify';
    path = newPath;
  }
  if (declaredMode !== undefined && (declaredMode.kind === 'new') !== (operation === 'create')) {
    throw invalid(`file mode header for ${excerpt(path)} contradicts its "---"/"+++" lines`);
  }
  if (operation !== 'modify' && declaredMode === undefined && gitHeader !== undefined) {
    throw invalid(`git diff for ${excerpt(path)} is missing its new/deleted file mode header`);
  }
  if (gitHeader !== undefined && gitHeader !== `diff --git a/${path} b/${path}`) {
    throw invalid(`"diff --git" header does not match the file paths: ${excerpt(gitHeader)}`);
  }

  const hunks: Hunk[] = [];
  while (reader.peek()?.startsWith('@@')) {
    hunks.push(parseHunk(reader, hunks.at(-1)));
  }
  if (hunks.length === 0) {
    throw invalid(`line ${reader.lineNumber + 1}: ${excerpt(path)} has no hunks`);
  }
  const lines = hunks.flatMap((hunk) => hunk.lines);
  if (operation === 'create' && (hunks.length !== 1 || lines.some((line) => line.kind !== '+'))) {
    throw invalid(`new file ${excerpt(path)} must be a single hunk of added lines`);
  }
  if (operation === 'delete' && lines.some((line) => line.kind !== '-')) {
    throw invalid(`deleted file ${excerpt(path)} must contain only removed lines`);
  }
  return {
    path,
    operation,
    hunks,
    additions: lines.filter((line) => line.kind === '+').length,
    deletions: lines.filter((line) => line.kind === '-').length,
  };
}

/** `null` for /dev/null. Absolute paths are returned so path validation can report them as unsafe. */
function parseHeaderPath(line: string, marker: string, prefix: string, lineNumber: number): string | null {
  const field = line.slice(marker.length);
  const tab = field.indexOf('\t');
  const value = tab === -1 ? field : field.slice(0, tab);
  if (value === DEV_NULL) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw invalid(`line ${lineNumber}: control characters in path (CRLF line endings are not supported in headers)`);
  }
  if (value.startsWith('"')) {
    throw invalid(`line ${lineNumber}: quoted paths are not supported`);
  }
  if (value.startsWith('/')) return value;
  if (!value.startsWith(prefix) || value.length === prefix.length) {
    throw invalid(`line ${lineNumber}: paths must use git-style "${prefix}" prefixes, got ${excerpt(value)}`);
  }
  return value.slice(prefix.length);
}

function parseHunk(reader: LineReader, previous: Hunk | undefined): Hunk {
  const headerLine = reader.lineNumber + 1;
  const match = HUNK_HEADER.exec(reader.next() ?? '');
  if (!match) {
    throw invalid(`line ${headerLine}: malformed hunk header`);
  }
  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  if (oldCount === 0 && newCount === 0) {
    throw invalid(`line ${headerLine}: empty hunk`);
  }
  if ((oldCount > 0 && oldStart === 0) || (newCount > 0 && newStart === 0)) {
    throw invalid(`line ${headerLine}: hunk line numbers start at 1`);
  }
  if (previous !== undefined && oldStart <= previous.oldStart) {
    throw invalid(`line ${headerLine}: hunks must be in ascending order`);
  }

  const lines: DiffLine[] = [];
  let oldSeen = 0;
  let newSeen = 0;
  let oldNoNewlineAtEnd = false;
  let newNoNewlineAtEnd = false;
  const takeMarker = (): void => {
    const last = lines.at(-1);
    const marksOld = last !== undefined && last.kind !== '+';
    const marksNew = last !== undefined && last.kind !== '-';
    if (last === undefined || (marksOld && oldNoNewlineAtEnd) || (marksNew && newNoNewlineAtEnd)) {
      throw invalid(`line ${reader.lineNumber}: misplaced "\\ No newline at end of file" marker`);
    }
    if (marksOld) oldNoNewlineAtEnd = true;
    if (marksNew) newNoNewlineAtEnd = true;
  };

  while (oldSeen < oldCount || newSeen < newCount) {
    const raw = reader.next();
    if (raw === undefined) {
      throw invalid(`hunk at line ${headerLine} ends before the ${oldCount}/${newCount} lines its header declares`);
    }
    if (raw.startsWith('\\')) {
      takeMarker();
      continue;
    }
    if (oldNoNewlineAtEnd || newNoNewlineAtEnd) {
      // Only an add after a removed last line may follow a marker (replacing a final line).
      if (!(oldNoNewlineAtEnd && !newNoNewlineAtEnd && raw.startsWith('+'))) {
        throw invalid(`line ${reader.lineNumber}: lines after "\\ No newline at end of file"`);
      }
    }
    // An empty line is an empty context line whose leading space was stripped, as git accepts.
    const kind = (raw === '' ? ' ' : raw[0]) as string;
    if (kind !== ' ' && kind !== '-' && kind !== '+') {
      throw invalid(`line ${reader.lineNumber}: unexpected line in hunk ${excerpt(raw)}`);
    }
    if (kind !== '+') oldSeen += 1;
    if (kind !== '-') newSeen += 1;
    if (oldSeen > oldCount || newSeen > newCount) {
      throw invalid(`line ${reader.lineNumber}: hunk has more lines than its header declares`);
    }
    lines.push({ kind, text: raw.slice(1) });
  }
  while (reader.peek()?.startsWith('\\')) {
    reader.next();
    takeMarker();
  }
  return { oldStart, oldCount, newStart, newCount, lines, oldNoNewlineAtEnd, newNoNewlineAtEnd };
}

function checkFileMode(mode: string, lineNumber: number): void {
  if (mode === '120000' || mode === '160000') {
    throw new PatchParseError('unsafe_path', `line ${lineNumber}: symlinks and submodules cannot be patched`);
  }
  if (!REGULAR_FILE_MODES.has(mode)) {
    throw invalid(`line ${lineNumber}: unsupported file mode ${mode}`);
  }
}

export type HunkApplication =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Applies a file's hunks to its current content in memory. Context must match
 * exactly; a hunk may be found at a different line than its header says (as
 * with `patch` and `git apply`), searching outward from the stated line.
 */
export function applyHunks(original: string, file: FilePatch): HunkApplication {
  const { lines, finalNewline: originalFinalNewline } = splitContent(original);
  const result: string[] = [];
  let cursor = 0;
  let finalNewline = originalFinalNewline;

  for (const [index, hunk] of file.hunks.entries()) {
    const label = `hunk ${index + 1} of ${file.path}`;
    const oldLines = hunk.lines.filter((line) => line.kind !== '+').map((line) => line.text);
    const newLines = hunk.lines.filter((line) => line.kind !== '-').map((line) => line.text);
    const expected = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    const position = locate(lines, oldLines, expected, cursor);
    if (position === undefined) {
      return { ok: false, reason: `${label} does not match the current file contents` };
    }
    const atEnd = position + oldLines.length === lines.length;
    if (hunk.oldNoNewlineAtEnd && !(atEnd && !originalFinalNewline)) {
      return { ok: false, reason: `${label} expects the file to end without a newline` };
    }
    if (atEnd && oldLines.length > 0 && !originalFinalNewline && !hunk.oldNoNewlineAtEnd) {
      return { ok: false, reason: `${label} expects a newline at the end of the file` };
    }
    if (hunk.newNoNewlineAtEnd && !atEnd) {
      return { ok: false, reason: `${label} removes the final newline but does not reach the end of the file` };
    }
    if (atEnd) {
      finalNewline = newLines.length > 0 ? !hunk.newNoNewlineAtEnd : true;
    }
    result.push(...lines.slice(cursor, position), ...newLines);
    cursor = position + oldLines.length;
  }
  result.push(...lines.slice(cursor));

  if (file.operation === 'delete' && result.length > 0) {
    return { ok: false, reason: `deletion of ${file.path} does not remove the whole file` };
  }
  return { ok: true, content: result.length === 0 ? '' : result.join('\n') + (finalNewline ? '\n' : '') };
}

function locate(lines: readonly string[], oldLines: readonly string[], expected: number, cursor: number): number | undefined {
  const last = lines.length - oldLines.length;
  if (oldLines.length === 0) {
    return expected >= cursor && expected <= lines.length ? expected : undefined;
  }
  for (let distance = 0; distance <= lines.length; distance += 1) {
    for (const candidate of distance === 0 ? [expected] : [expected - distance, expected + distance]) {
      if (candidate >= cursor && candidate <= last && matchesAt(lines, oldLines, candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function matchesAt(lines: readonly string[], oldLines: readonly string[], position: number): boolean {
  return oldLines.every((line, offset) => lines[position + offset] === line);
}

function splitContent(content: string): { lines: string[]; finalNewline: boolean } {
  if (content === '') return { lines: [], finalNewline: true };
  const finalNewline = content.endsWith('\n');
  return { lines: (finalNewline ? content.slice(0, -1) : content).split('\n'), finalNewline };
}

class LineReader {
  readonly #lines: readonly string[];
  #index = 0;

  constructor(text: string) {
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    this.#lines = lines;
  }

  get done(): boolean {
    return this.#index >= this.#lines.length;
  }

  /** 1-based number of the last line returned by `next`. */
  get lineNumber(): number {
    return this.#index;
  }

  peek(): string | undefined {
    return this.#lines[this.#index];
  }

  next(): string | undefined {
    const line = this.#lines[this.#index];
    if (line !== undefined) this.#index += 1;
    return line;
  }
}

function invalid(message: string): PatchParseError {
  return new PatchParseError('invalid_patch', message);
}

function excerpt(value: string): string {
  return JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}...` : value);
}
