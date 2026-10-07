/** Placeholder the sandbox substitutes for the repository root in command output. */
export const REPOSITORY_PLACEHOLDER = '<repo>';

export interface SourcePosition {
  readonly path: string;
  readonly line: number;
}

/**
 * How a TAP test point ended. `skipped` and `todo` come from the `# SKIP` and
 * `# TODO` directives: a skipped test did not run, and a todo test's failure
 * does not fail the run, so neither counts as a pass.
 */
export type TestOutcome = 'passed' | 'failed' | 'skipped' | 'todo';

export interface TestResult {
  readonly name: string;
  /** Names of the enclosing suites and parent tests, outermost first. */
  readonly ancestors: readonly string[];
  readonly outcome: TestOutcome;
  /** The exact result line, e.g. `not ok 2 - adds numbers`. */
  readonly resultLine: string;
  /** Where the test is declared (the YAML `location`); `node --test` reports it for failures only. */
  readonly location?: SourcePosition;
  /** `node --test`'s `failureType`, e.g. `testCodeFailure` or `subtestsFailed`. */
  readonly failureType?: string;
}

export interface TestFailure extends TestResult {
  /** Where the failing assertion was raised: the first stack frame inside the repository. */
  readonly failurePosition?: SourcePosition;
  /** The reported error, such as the assertion message. */
  readonly error?: string;
  readonly actual?: string;
  readonly expected?: string;
  /** The `actual !== expected` style comparison line, if the error contains one. */
  readonly comparison?: string;
}

export interface TestRunObservation {
  /** Every test point, nested ones included, in output order. */
  readonly results: readonly (TestResult | TestFailure)[];
  readonly passed: readonly { readonly name: string; readonly resultLine: string }[];
  readonly failed: readonly TestFailure[];
  /** The top-level plan `1..N`; null when the output has none, as when the runner stopped before finishing. */
  readonly plan: number | null;
  /** Tests whose `# Subtest:` header appeared without a matching result: started, never reported finished. */
  readonly unfinished: readonly { readonly name: string; readonly ancestors: readonly string[] }[];
}

const SUBTEST = /^( *)# Subtest: (.*)$/;
const RESULT_LINE = /^( *)(not ok|ok) \d+ - (.*)$/;
const DIRECTIVE = /^(.*?)\s+#\s*(SKIP|TODO)\b.*$/i;
const PLAN = /^1\.\.(\d+)\s*$/;
const YAML_KEY = /^([A-Za-z_]+):(?: (.*))?$/;
const COMPARISON = /^\s*(.+?) !== (.+?)\s*$/;
const FRAME = /<repo>\/([^\s:'"()]+):(\d+):\d+/g;
const LOCATION = /^<repo>\/(.+):(\d+):\d+$/;

/**
 * Parses TAP output (as produced by `node --test`) into structured test
 * results. Nesting comes from indentation and `# Subtest:` headers; each
 * result's YAML block is read only between its `---` and `...` markers, so
 * text inside an error message is never taken for a result. Anything a test
 * prints is a `#` comment in node's TAP and is ignored. Unknown formats yield
 * no results and no plan.
 */
export function parseTestOutput(text: string): TestRunObservation {
  const lines = text.split(/\r?\n/);
  const results: (TestResult | TestFailure)[] = [];
  const unfinished: { name: string; ancestors: string[] }[] = [];
  const open: { name: string; indent: number }[] = [];
  let plan: number | null = null;
  const abandon = (indent: number) => {
    while ((open.at(-1)?.indent ?? -1) >= indent) {
      const entry = open.pop();
      if (entry) unfinished.push({ name: entry.name, ancestors: open.map((item) => item.name) });
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const subtest = SUBTEST.exec(line);
    if (subtest) {
      const indent = subtest[1]?.length ?? 0;
      abandon(indent);
      open.push({ name: unescapeName(subtest[2] ?? ''), indent });
      continue;
    }
    const result = RESULT_LINE.exec(line);
    if (result) {
      const indent = result[1]?.length ?? 0;
      const directive = DIRECTIVE.exec(result[3] ?? '');
      const name = unescapeName(directive ? (directive[1] ?? '') : (result[3] ?? ''));
      abandon(indent + 1);
      const header = open.at(-1);
      if (header?.indent === indent) {
        open.pop();
        if (header.name !== name) unfinished.push({ name: header.name, ancestors: open.map((item) => item.name) });
      }
      const block = yamlBlock(lines, index + 1, indent + 2);
      if (block) index = block.end;
      const outcome = outcomeOf(result[2] === 'ok', directive?.[2]?.toUpperCase());
      results.push(
        describeResult(
          { name, ancestors: open.map((item) => item.name), outcome, resultLine: line.trim() },
          result[2] === 'not ok',
          block?.fields ?? new Map(),
        ),
      );
      continue;
    }
    const planned = PLAN.exec(line);
    if (planned) plan = Number(planned[1]);
  }
  abandon(0);

  return {
    results,
    passed: results.filter((item) => item.outcome === 'passed').map(({ name, resultLine }) => ({ name, resultLine })),
    failed: results.filter((item) => item.outcome === 'failed'),
    plan,
    unfinished,
  };
}

function outcomeOf(ok: boolean, directive: string | undefined): TestOutcome {
  if (directive === 'SKIP') return 'skipped';
  if (directive === 'TODO') return 'todo';
  return ok ? 'passed' : 'failed';
}

/** TAP escapes `#` and `\` in descriptions. */
function unescapeName(text: string): string {
  return text.trim().replace(/\\([\\#])/g, '$1');
}

/**
 * The YAML block that follows a result, if any: `---` at `indent`, keys at
 * `indent`, multi-line values indented further, closed by `...` at `indent`.
 * `end` is the index of the closing `...`; an unclosed block (truncated
 * output) runs to the last line, so its text is never read as results.
 */
function yamlBlock(lines: readonly string[], start: number, indent: number): { end: number; fields: Map<string, string> } | undefined {
  const pad = ' '.repeat(indent);
  if (lines[start] !== `${pad}---`) return undefined;
  const fields = new Map<string, string>();
  let key: string | undefined;
  let multiline: string[] | undefined;
  const flush = () => {
    if (key !== undefined && multiline !== undefined) fields.set(key, multiline.join('\n').trimEnd());
    multiline = undefined;
  };
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line === `${pad}...`) {
      flush();
      return { end: index, fields };
    }
    const entry = line.startsWith(pad) && line[indent] !== ' ' ? YAML_KEY.exec(line.slice(indent)) : null;
    if (entry) {
      flush();
      key = entry[1] ?? '';
      const value = entry[2] ?? '';
      if (/^[|>][-+]?$/.test(value)) multiline = [];
      else fields.set(key, scalar(value));
      continue;
    }
    multiline?.push(line.startsWith(`${pad}  `) ? line.slice(indent + 2) : line.trim());
  }
  flush();
  return { end: lines.length - 1, fields };
}

function scalar(value: string): string {
  if (/^'.*'$/.test(value)) return value.slice(1, -1).replaceAll("''", "'");
  if (/^".*"$/.test(value)) return value.slice(1, -1);
  return value;
}

function describeResult(base: TestResult, notOk: boolean, fields: ReadonlyMap<string, string>): TestResult | TestFailure {
  const located = LOCATION.exec(fields.get('location') ?? '');
  const failureType = fields.get('failureType');
  const result: TestResult = {
    ...base,
    ...(located ? { location: { path: located[1] ?? '', line: Number(located[2]) } } : {}),
    ...(failureType !== undefined ? { failureType } : {}),
  };
  if (!notOk) return result;

  let failurePosition: SourcePosition | undefined;
  for (const frame of (fields.get('stack') ?? '').matchAll(FRAME)) {
    const framePath = frame[1] ?? '';
    if (!framePath.split('/').includes('node_modules')) {
      failurePosition = { path: framePath, line: Number(frame[2]) };
      break;
    }
  }
  const error = fields.get('error');
  const comparison = error?.split('\n').map((line) => line.trim()).find((line) => COMPARISON.test(line));
  const actual = fields.get('actual');
  const expected = fields.get('expected');
  return {
    ...result,
    ...(failurePosition ? { failurePosition } : {}),
    ...(error !== undefined && error.length > 0 ? { error } : {}),
    ...(actual !== undefined && actual !== '~' ? { actual } : {}),
    ...(expected !== undefined && expected !== '~' ? { expected } : {}),
    ...(comparison !== undefined ? { comparison } : {}),
  };
}
