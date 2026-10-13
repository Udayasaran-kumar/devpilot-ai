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

export type BoundaryOperator = '>' | '>=' | '<' | '<=';

/** `left operator right ? whenTrue : whenFalse`, every operand a plain identifier or number literal. */
export interface BoundaryConditional {
  readonly left: string;
  readonly operator: BoundaryOperator;
  readonly right: string;
  readonly whenTrue: string;
  readonly whenFalse: string;
}

/** A named function declaration whose header is one line: `export function name(a: T, b: T): R {`. */
export interface FunctionHeader {
  readonly line: number;
  readonly name: string;
  readonly parameters: readonly string[];
}

/** `const name = callee(arg, ...)` where every argument is a number literal. */
export interface LiteralCall {
  readonly line: number;
  readonly text: string;
  readonly name: string;
  readonly callee: string;
  readonly args: readonly number[];
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
const SIMPLE_OPERAND = String.raw`[A-Za-z_$][\w$]*|-?\d+(?:\.\d+)?`;
const BOUNDARY_CONDITIONAL = new RegExp(
  String.raw`^(${SIMPLE_OPERAND})\s+(>=|<=|>|<)\s+(${SIMPLE_OPERAND})\s*\?\s*(${SIMPLE_OPERAND})\s*:\s*(${SIMPLE_OPERAND})$`,
);
const FUNCTION_HEADER = /^\s*export\s+function\s+([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*(?::\s*[A-Za-z_$][\w$]*\s*)?\{\s*$/;
const PARAMETER = /^([A-Za-z_$][\w$]*)\s*(?::\s*[A-Za-z_$][\w$]*)?$/;
const LITERAL_CALL = /^const\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\(([^()]*)\);?$/;

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

export function parseBoundaryConditional(expression: string): BoundaryConditional | undefined {
  const match = BOUNDARY_CONDITIONAL.exec(expression.trim());
  if (!match) return undefined;
  const [, left = '', operator = '', right = '', whenTrue = '', whenFalse = ''] = match;
  return { left, operator: operator as BoundaryOperator, right, whenTrue, whenFalse };
}

/**
 * The function enclosing `target`: the nearest function header above it, which
 * must be an exported, named, one-line declaration with plain parameters (no
 * defaults, destructuring, rest, optional, or generic types).
 */
export function enclosingFunction(lines: readonly SourceLine[], target: Declaration): FunctionHeader | undefined {
  const header = lines.filter((line) => line.line < target.line).findLast((line) => FUNCTION_START.test(line.text));
  const match = header && FUNCTION_HEADER.exec(header.text);
  if (!header || !match) return undefined;
  const list = (match[2] ?? '').trim();
  const parameters = list === '' ? [] : list.split(',').map((item) => PARAMETER.exec(item.trim())?.[1]);
  if (parameters.some((name) => name === undefined)) return undefined;
  const names = parameters as string[];
  if (new Set(names).size !== names.length) return undefined;
  return { line: header.line, name: match[1] ?? '', parameters: names };
}

export function parseLiteralCall(line: SourceLine): LiteralCall | undefined {
  const text = line.text.trim();
  const match = LITERAL_CALL.exec(text);
  if (!match) return undefined;
  const list = (match[3] ?? '').trim();
  const args = list === '' ? [] : list.split(',').map((item) => item.trim());
  if (!args.every((item) => NUMBER_LITERAL.test(item))) return undefined;
  return { line: line.line, text, name: match[1] ?? '', callee: match[2] ?? '', args: args.map(Number) };
}

/** A line that neither branches, returns, nor reassigns: blank, a `//` comment, or a `const` declaration. */
export function isStraightLine(line: SourceLine): boolean {
  const text = line.text.trim();
  return text === '' || text.startsWith('//') || (text.startsWith('const ') && parseDeclaration(line) !== undefined);
}

/**
 * Whether `line` is `return { ... }` returning the local `name` under the key
 * `name`, exactly once. Object literals with calls, nesting, spreads, computed
 * keys, or strings are not read.
 */
export function returnsLocalAs(line: SourceLine, name: string): boolean {
  const body = /^\s*return\s*\{([^{}()[\]'"`]*)\}\s*;?\s*$/.exec(line.text)?.[1];
  if (body === undefined || body.includes('...')) return false;
  const entries = body.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  const forName = entries.filter((entry) => new RegExp(`^${escapeRegExp(name)}\\s*(?::|$)`).test(entry));
  return forName.length === 1 && new RegExp(`^${escapeRegExp(name)}(?:\\s*:\\s*${escapeRegExp(name)})?$`).test(forName[0] ?? '');
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

/** Punctuators made only of `<`, `>`, `=`, and `!`, longest first, so `>=` is never read as `>` nor `=>` as `>`. */
const ANGLE_AND_EQUALS_PUNCTUATORS = ['>>>=', '===', '!==', '>>>', '<<=', '>>=', '==', '!=', '>=', '<=', '=>', '<<', '>>', '>', '<', '=', '!'];

/**
 * Replaces the one occurrence of the binary operator `from` on a line with `to`.
 * The line is read on its own: string literals and comments are skipped, and a
 * line that cannot be read without its neighbours or a parser (a template
 * literal, a regular expression or division, a block-comment continuation, an
 * unterminated string) is refused. Returns `undefined` unless `from` occurs
 * exactly once as a whole token, with whitespace and an operand on each side.
 */
export function replaceBinaryOperator(text: string, from: string, to: string): string | undefined {
  if (/^\s*\*/.test(text)) return undefined;
  const found: number[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    if (char === '"' || char === "'") {
      const end = closingQuote(text, index);
      if (end === undefined) return undefined;
      index = end + 1;
    } else if (char === '`') {
      return undefined;
    } else if (char === '/') {
      if (text[index + 1] === '/') break;
      if (text[index + 1] !== '*') return undefined;
      const end = text.indexOf('*/', index + 2);
      if (end === -1) return undefined;
      index = end + 2;
    } else if ('<>=!'.includes(char)) {
      const token = ANGLE_AND_EQUALS_PUNCTUATORS.find((punctuator) => text.startsWith(punctuator, index)) as string;
      if (token === from) found.push(index);
      index += token.length;
    } else {
      index += 1;
    }
  }
  const [at, ...more] = found;
  if (at === undefined || more.length > 0) return undefined;
  const before = text.slice(0, at);
  const after = text.slice(at + from.length);
  if (!/[\w$)\]]\s+$/.test(before) || !/^\s+[\w$(![+~-]/.test(after)) return undefined;
  return `${before}${to}${after}`;
}

function closingQuote(text: string, start: number): number | undefined {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === '\\') index += 1;
    else if (text[index] === quote) return index;
  }
  return undefined;
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
