/** Placeholder the sandbox substitutes for the repository root in command output. */
export const REPOSITORY_PLACEHOLDER = '<repo>';

export interface SourcePosition {
  readonly path: string;
  readonly line: number;
}

export interface TestFailure {
  readonly name: string;
  /** The exact result line, e.g. `not ok 2 - adds numbers`. */
  readonly resultLine: string;
  /** Where the failing assertion was raised: the first stack frame inside the repository. */
  readonly failurePosition?: SourcePosition;
  readonly actual?: string;
  readonly expected?: string;
  /** The `actual !== expected` style comparison line, if the output contains one. */
  readonly comparison?: string;
}

export interface TestRunObservation {
  readonly passed: readonly { readonly name: string; readonly resultLine: string }[];
  readonly failed: readonly TestFailure[];
}

const RESULT_LINE = /^\s*(not ok|ok) \d+ - (.+?)(?:\s+#\s+(?:SKIP|TODO)\b.*)?$/;
const YAML_SCALAR = (key: string) => new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`);
const COMPARISON = /^\s*(.+?) !== (.+?)\s*$/;
const FRAME = /<repo>\/([^\s:'"()]+):(\d+):\d+/g;

/**
 * Parses TAP output (as produced by `node --test`) into passing and failing
 * tests. For a failure it extracts the first in-repository stack frame and the
 * actual/expected values, when present. Unknown formats yield no tests.
 */
export function parseTestOutput(text: string): TestRunObservation {
  const lines = text.split(/\r?\n/);
  const passed: { name: string; resultLine: string }[] = [];
  const failed: TestFailure[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = RESULT_LINE.exec(lines[index] ?? '');
    if (!match) continue;
    const resultLine = (lines[index] ?? '').trim();
    const name = match[2] ?? '';
    if (match[1] === 'ok') {
      passed.push({ name, resultLine });
      continue;
    }
    const block: string[] = [];
    for (let cursor = index + 1; cursor < lines.length && !RESULT_LINE.test(lines[cursor] ?? ''); cursor += 1) {
      if (/^\s*# Subtest:/.test(lines[cursor] ?? '')) break;
      block.push(lines[cursor] ?? '');
    }
    failed.push(describeFailure(name, resultLine, block));
  }
  return { passed, failed };
}

function describeFailure(name: string, resultLine: string, block: readonly string[]): TestFailure {
  const scalar = (key: string) => {
    for (const line of block) {
      const value = YAML_SCALAR(key).exec(line)?.[1];
      if (value !== undefined && value !== '|-' && value !== '|') return unquote(value);
    }
    return undefined;
  };
  const stackStart = block.findIndex((line) => /^\s*stack:/.test(line));
  const frames = stackStart === -1 ? [] : block.slice(stackStart).join('\n').matchAll(FRAME);
  let failurePosition: SourcePosition | undefined;
  for (const frame of frames) {
    const framePath = frame[1] ?? '';
    if (!framePath.split('/').includes('node_modules')) {
      failurePosition = { path: framePath, line: Number(frame[2]) };
      break;
    }
  }
  const comparison = block.map((line) => line.trim()).find((line) => COMPARISON.test(line));
  const actual = scalar('actual');
  const expected = scalar('expected');
  return {
    name,
    resultLine,
    ...(failurePosition ? { failurePosition } : {}),
    ...(actual !== undefined ? { actual } : {}),
    ...(expected !== undefined ? { expected } : {}),
    ...(comparison !== undefined ? { comparison } : {}),
  };
}

function unquote(value: string): string {
  return /^'.*'$|^".*"$/.test(value) ? value.slice(1, -1) : value;
}
