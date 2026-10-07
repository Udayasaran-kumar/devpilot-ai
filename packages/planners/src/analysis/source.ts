/**
 * Line-oriented reading of JavaScript/TypeScript source. Deliberately shallow:
 * it recognises a few common shapes (assertions, test declarations, `const`
 * declarations) and reports nothing for anything else, so the planner falls
 * back to finishing without a proposal rather than guessing.
 */

export interface SourceLine {
  readonly line: number;
  readonly text: string;
}

export interface Assertion {
  readonly line: number;
  readonly text: string;
  /** The expression under test, e.g. `invoice.fee`. */
  readonly subject: string;
  /** The final identifier of the subject, e.g. `fee`. */
  readonly property: string;
  /** The expected value as written, e.g. `180`. */
  readonly expected: string;
}

export interface TestBlock {
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface Declaration {
  readonly line: number;
  readonly text: string;
  readonly name: string;
  readonly expression: string;
  /** Leading whitespace width; 0 for module-level declarations. */
  readonly indent: number;
}

const ASSERT_CALL =
  /^\s*assert(?:\.strict)?\.(?:equal|strictEqual|deepEqual|deepStrictEqual)\(\s*([A-Za-z_$][\w$.]*)\s*,\s*([^,]+?)\s*(?:,.*)?\)\s*;?\s*$/;
const EXPECT_CALL = /^\s*expect\(\s*([A-Za-z_$][\w$.]*)\s*\)\.(?:toBe|toEqual|toStrictEqual)\(\s*([^,]+?)\s*\)\s*;?\s*$/;
const TEST_DECLARATION = /^\s*(?:test|it)\(\s*(['"`])(.+?)\1\s*,/;
const DECLARATION = /^(\s*)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(.+?);?\s*$/;
const FUNCTION_START = /\bfunction\b|=>\s*\{\s*$/;
const NUMBER_LITERAL = /^-?\d+(?:\.\d+)?$/;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
const GLOBALS = new Set(['Math', 'Number', 'JSON', 'Object', 'Array', 'String', 'Boolean', 'undefined', 'null', 'true', 'false']);

/** Numbers the lines of read_file content, which starts at `startLine`. */
export function numberLines(content: string, startLine = 1): SourceLine[] {
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.map((text, index) => ({ line: startLine + index, text }));
}

export function parseAssertion(line: SourceLine): Assertion | undefined {
  const match = ASSERT_CALL.exec(line.text) ?? EXPECT_CALL.exec(line.text);
  if (!match) return undefined;
  const subject = match[1] ?? '';
  return {
    line: line.line,
    text: line.text.trim(),
    subject,
    property: subject.slice(subject.lastIndexOf('.') + 1),
    expected: match[2] ?? '',
  };
}

/** Test declarations in order; each block ends where the next one starts. */
export function findTestBlocks(lines: readonly SourceLine[]): TestBlock[] {
  const starts = lines.flatMap((line) => {
    const name = TEST_DECLARATION.exec(line.text)?.[2];
    return name === undefined ? [] : [{ name, startLine: line.line }];
  });
  const last = lines.at(-1)?.line ?? 0;
  return starts.map((start, index) => ({ ...start, endLine: (starts[index + 1]?.startLine ?? last + 1) - 1 }));
}

export function assertionsIn(lines: readonly SourceLine[], block: TestBlock): Assertion[] {
  return lines
    .filter((line) => line.line >= block.startLine && line.line <= block.endLine)
    .flatMap((line) => parseAssertion(line) ?? []);
}

export function parseDeclaration(line: SourceLine): Declaration | undefined {
  const match = DECLARATION.exec(line.text);
  if (!match) return undefined;
  return {
    line: line.line,
    text: line.text.trim(),
    name: match[2] ?? '',
    expression: (match[3] ?? '').trim(),
    indent: (match[1] ?? '').length,
  };
}

/**
 * Declarations in the same function as `target` that precede it: from the
 * nearest enclosing function header down to the line before `target`.
 */
export function localsBefore(lines: readonly SourceLine[], target: Declaration): Declaration[] {
  const before = lines.filter((line) => line.line < target.line);
  let start = 0;
  for (let index = before.length - 1; index >= 0; index -= 1) {
    if (FUNCTION_START.test(before[index]?.text ?? '')) {
      start = index + 1;
      break;
    }
  }
  return before
    .slice(start)
    .flatMap((line) => parseDeclaration(line) ?? [])
    .filter((declaration) => declaration.indent === target.indent);
}

/** Module-level declarations initialised with a number literal. */
export function numericConstants(lines: readonly SourceLine[]): (Declaration & { readonly value: number })[] {
  return lines.flatMap((line) => {
    const declaration = parseDeclaration(line);
    if (!declaration || declaration.indent !== 0 || !NUMBER_LITERAL.test(declaration.expression)) return [];
    return [{ ...declaration, value: Number(declaration.expression) }];
  });
}

/**
 * Identifiers an expression reads as values: not property names (`.round`),
 * not called functions (`convert(`), and not well-known globals.
 */
export function valueIdentifiers(expression: string): string[] {
  const found: string[] = [];
  for (const match of expression.matchAll(IDENTIFIER)) {
    const name = match[0];
    const index = match.index ?? 0;
    const previous = expression.slice(0, index).trimEnd().at(-1);
    const following = expression.slice(index + name.length).trimStart()[0];
    if (previous === '.' || following === '(' || GLOBALS.has(name) || /^\d/.test(name)) continue;
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/** Replaces whole-identifier uses of `from` (never property names) with `to`. */
export function replaceIdentifier(expression: string, from: string, to: string): string {
  return expression.replace(new RegExp(`(?<![\\w$.])${escapeRegExp(from)}(?![\\w$])`, 'g'), to);
}

export function isNumberLiteral(text: string): boolean {
  return NUMBER_LITERAL.test(text.trim());
}

/** Lowercase words of an identifier or sentence: `adjustedTotal` -> `adjusted`, `total`. */
export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
