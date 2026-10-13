import path from 'node:path/posix';
import {
  isTestPath,
  parseTestOutput,
  type Evidence,
  type EvidenceId,
  type InvestigationActionRecord,
  type TestFailure,
  type TestRunObservation,
} from '@devpilot/core';
import { evaluateArithmetic } from './analysis/arithmetic.js';
import {
  assertionsIn,
  enclosingFunction,
  findTestBlocks,
  isNumberLiteral,
  isStraightLine,
  localsBefore,
  numberLines,
  numericConstants,
  parseAssertion,
  parseBoundaryConditional,
  parseDeclaration,
  parseLiteralCall,
  replaceBinaryOperator,
  replaceIdentifier,
  returnsLocalAs,
  valueIdentifiers,
  words,
  type Assertion,
  type BoundaryOperator,
  type Declaration,
  type SourceLine,
  type TestBlock,
} from './analysis/source.js';
import type { PlannerContext } from './planner.js';

/** One observation drawn from evidence. `quote` is verbatim text from the first cited evidence item. */
export interface Finding {
  readonly statement: string;
  readonly quote: string;
  readonly evidenceIds: readonly EvidenceId[];
  /** A contradiction that rules the hypothesis out rather than merely weakening it. */
  readonly decisive?: boolean;
}

export type HypothesisKind = 'wrong_input' | 'upstream_value' | 'wrong_constant' | 'wrong_operator';

/** A candidate repair: replace `from` with `to` in the expression on `line` of `path`. */
export interface IdentifierSubstitution {
  readonly path: string;
  readonly line: number;
  readonly from: string;
  readonly to: string;
}

export interface OperatorSubstitution {
  readonly path: string;
  readonly line: number;
  readonly from: '>' | '>=' | '<' | '<=' | '===' | '!==';
  readonly to: '>' | '>=' | '<' | '<=' | '===' | '!==';
}

export interface HypothesisCandidate {
  readonly id: string;
  readonly kind: HypothesisKind;
  readonly statement: string;
  readonly support: readonly Finding[];
  readonly contradiction: readonly Finding[];
  readonly substitution?: IdentifierSubstitution;
  readonly operatorSubstitution?: OperatorSubstitution;
}

export interface Reproduction {
  readonly action: InvestigationActionRecord;
  readonly evidence?: Evidence;
  readonly observation?: TestRunObservation;
  readonly failure?: TestFailure;
}

export interface FailingTest {
  readonly path: string;
  readonly action?: InvestigationActionRecord;
  readonly evidence?: Evidence;
  readonly lines?: readonly SourceLine[];
  readonly block?: TestBlock;
  readonly assertion?: Assertion;
  /** Assertions in the failing test before the failing one; they ran and held. */
  readonly priorAssertions: readonly Assertion[];
  /** Assertions in tests the run reported as passing. */
  readonly passingAssertions: readonly { readonly test: string; readonly assertion: Assertion }[];
  readonly importedPaths: readonly string[];
}

export interface Definition {
  readonly query: string;
  readonly action?: InvestigationActionRecord;
  readonly match?: Evidence;
  /** Why no unique definition was found, once the search has run. */
  readonly problem?: string;
}

export interface Computation {
  readonly path: string;
  readonly action?: InvestigationActionRecord;
  readonly evidence?: Evidence;
  readonly lines?: readonly SourceLine[];
  readonly declaration?: Declaration;
  readonly locals: readonly Declaration[];
  readonly constants: readonly (Declaration & { readonly value: number })[];
}

/** Everything the planner knows, derived only from the context: same context, same analysis. */
export interface InvestigationAnalysis {
  readonly command?: { readonly command: string; readonly args: readonly string[] };
  readonly commandProblem?: string;
  readonly reproduction?: Reproduction;
  readonly failingTest?: FailingTest;
  readonly definition?: Definition;
  readonly computation?: Computation;
  readonly candidates: readonly HypothesisCandidate[];
}

export interface AnalysisOptions {
  /** Also form `wrong_operator` hypotheses at an exact comparison boundary (see `boundaryCandidates`). Off by default. */
  readonly operatorBoundaries?: boolean;
}

const SHELL_SYNTAX = /[;&|<>`$(){}[\]*?!~"'\\]/;

export function analyzeInvestigation(context: PlannerContext, options: AnalysisOptions = {}): InvestigationAnalysis {
  const commandLine = context.signal.command?.trim();
  if (!commandLine) return { commandProblem: 'The signal names no command that reproduces the failure.', candidates: [] };
  const [command, ...args] = commandLine.split(/\s+/);
  if (command === undefined || SHELL_SYNTAX.test(commandLine)) {
    return { commandProblem: `The signal command ${JSON.stringify(commandLine)} is not a plain argv command line.`, candidates: [] };
  }
  const base = { command: { command, args } };

  const reproduction = findReproduction(context, command, args);
  if (!reproduction?.failure?.failurePosition) return { ...base, ...(reproduction ? { reproduction } : {}), candidates: [] };

  const failingTest = readFailingTest(context, reproduction.failure, reproduction.observation);
  if (!failingTest.assertion) return { ...base, reproduction, failingTest, candidates: [] };

  const definition = findDefinition(context, failingTest.assertion.property, failingTest.importedPaths);
  if (!definition.match?.location || definition.match.location.type !== 'file') {
    return { ...base, reproduction, failingTest, definition, candidates: [] };
  }

  const { path: definitionPath, startLine } = definition.match.location;
  const computation = readComputation(context, definitionPath, failingTest.assertion.property, startLine);
  if (!computation.declaration) return { ...base, reproduction, failingTest, definition, computation, candidates: [] };

  return {
    ...base,
    reproduction,
    failingTest,
    definition,
    computation,
    candidates: [
      ...generateCandidates(reproduction, failingTest, definition.match, computation),
      ...(options.operatorBoundaries === true ? boundaryCandidates(reproduction, failingTest, definition.match, computation) : []),
    ],
  };
}

function findReproduction(context: PlannerContext, command: string, args: readonly string[]): Reproduction | undefined {
  const action = latestAction(
    context,
    'run_command',
    (input) => input['command'] === command && JSON.stringify(input['args']) === JSON.stringify(args),
  );
  if (!action) return undefined;
  const evidence = evidenceOf(context, action).find((item) => item.kind === 'command_output');
  if (!evidence?.content) return { action, ...(evidence ? { evidence } : {}) };
  const observation = parseTestOutput(evidence.content);
  const failure = observation.failed.find((item) => item.failurePosition !== undefined) ?? observation.failed[0];
  return { action, evidence, observation, ...(failure ? { failure } : {}) };
}

function readFailingTest(context: PlannerContext, failure: TestFailure, observation: TestRunObservation | undefined): FailingTest {
  const position = failure.failurePosition;
  const testPath = position?.path ?? '';
  const empty = { path: testPath, priorAssertions: [], passingAssertions: [], importedPaths: [] };
  const action = latestAction(context, 'read_file', (input) => input['path'] === testPath);
  const evidence = action && evidenceOf(context, action).find((item) => item.kind === 'source_code');
  if (!action || !evidence?.content || evidence.location.type !== 'file' || !position) {
    return { ...empty, ...(action ? { action } : {}) };
  }

  const lines = numberLines(evidence.content, evidence.location.startLine ?? 1);
  const blocks = findTestBlocks(lines);
  const block =
    blocks.find((item) => item.name === failure.name) ??
    blocks.find((item) => item.startLine <= position.line && position.line <= item.endLine);
  const failingLine = lines.find((line) => line.line === position.line);
  const assertion = failingLine && parseAssertion(failingLine);
  const passingNames = new Set(observation?.passed.map((test) => test.name));

  return {
    path: testPath,
    action,
    evidence,
    lines,
    ...(block ? { block } : {}),
    ...(assertion ? { assertion } : {}),
    priorAssertions: block && assertion ? assertionsIn(lines, block).filter((item) => item.line < assertion.line) : [],
    passingAssertions: blocks
      .filter((item) => passingNames.has(item.name))
      .flatMap((item) => assertionsIn(lines, item).map((found) => ({ test: item.name, assertion: found }))),
    importedPaths: importedPaths(lines, testPath),
  };
}

/** Search query that finds where a value named `name` is assigned. */
export function definitionQuery(name: string): string {
  return `${name} =`;
}

function findDefinition(context: PlannerContext, name: string, preferredPaths: readonly string[]): Definition {
  const query = definitionQuery(name);
  const action = latestAction(context, 'search_code', (input) => input['query'] === query);
  if (!action) return { query };
  const matches = evidenceOf(context, action).filter(
    (item) =>
      item.kind === 'search_result' &&
      item.location.type === 'file' &&
      !isTestPath(item.location.path) &&
      parseDeclaration({ line: item.location.startLine ?? 0, text: item.content ?? '' })?.name === name,
  );
  const preferred = matches.filter((item) => item.location.type === 'file' && preferredPaths.includes(item.location.path));
  const pool = preferred.length > 0 ? preferred : matches;
  if (pool.length !== 1) {
    return {
      query,
      action,
      problem:
        pool.length === 0
          ? `No non-test declaration of \`${name}\` was found.`
          : `\`${name}\` is declared in ${pool.length} places; the planner will not guess which one is wrong.`,
    };
  }
  const [match] = pool;
  return match ? { query, action, match } : { query, action };
}

function readComputation(context: PlannerContext, filePath: string, name: string, line: number | undefined): Computation {
  const empty = { path: filePath, locals: [], constants: [] };
  const action = latestAction(context, 'read_file', (input) => input['path'] === filePath);
  const evidence = action && evidenceOf(context, action).find((item) => item.kind === 'source_code');
  if (!action || !evidence?.content || evidence.location.type !== 'file') return { ...empty, ...(action ? { action } : {}) };

  const lines = numberLines(evidence.content, evidence.location.startLine ?? 1);
  const declaration = lines
    .flatMap((line) => parseDeclaration(line) ?? [])
    .find((item) => item.name === name && item.line === line && item.indent > 0);
  return {
    path: filePath,
    action,
    evidence,
    lines,
    ...(declaration ? { declaration } : {}),
    locals: declaration ? localsBefore(lines, declaration) : [],
    constants: numericConstants(lines),
  };
}

/**
 * Competing explanations for why `target` has the wrong value, generated from
 * the shape of its computation rather than from any known incident:
 * - wrong_input: the expression uses an input where a value derived from that input exists.
 * - upstream_value: an input of the computation (or a value the test checks first) is itself wrong.
 * - wrong_constant: a numeric constant used by the computation is wrong.
 */
function generateCandidates(
  reproduction: Reproduction,
  test: FailingTest,
  match: Evidence,
  computation: Computation,
): HypothesisCandidate[] {
  const declaration = computation.declaration;
  const assertion = test.assertion;
  const failure = reproduction.failure;
  if (!declaration || !assertion || !failure || !reproduction.evidence || !test.evidence || !computation.evidence) return [];
  const run = reproduction.evidence;
  const testEvidence = test.evidence;
  const sourceEvidence = computation.evidence;

  const target = declaration.name;
  const operands = valueIdentifiers(declaration.expression);
  const localByName = new Map(computation.locals.map((local) => [local.name, local]));
  const constantByName = new Map(computation.constants.map((constant) => [constant.name, constant]));
  const knownValues = new Map<string, number>();
  for (const prior of test.priorAssertions) {
    if (isNumberLiteral(prior.expected)) knownValues.set(prior.property, Number(prior.expected));
  }
  const values = new Map([...computation.constants.map((c) => [c.name, c.value] as const), ...knownValues]);
  const expected = isNumberLiteral(assertion.expected) ? Number(assertion.expected) : undefined;

  const candidates: HypothesisCandidate[] = [];

  for (const operand of operands) {
    const input = localByName.get(operand);
    if (!input) continue;
    for (const derived of computation.locals) {
      if (derived.line <= input.line || derived.name === target || !valueIdentifiers(derived.expression).includes(operand)) {
        continue;
      }
      const support: Finding[] = [
        {
          statement: `\`${target}\` is computed as \`${declaration.expression}\` from \`${operand}\`, although \`${derived.name}\` is derived from \`${operand}\` on line ${derived.line} of the same function.`,
          quote: declaration.text,
          evidenceIds: unique([sourceEvidence.id, match.id]),
        },
      ];
      const contradiction: Finding[] = [];
      const nameWords = words(derived.name);
      const testWords = new Set(words(failure.name));
      if (nameWords.length > 0 && nameWords.every((word) => testWords.has(word))) {
        support.push({
          statement: `The failing test's name, "${failure.name}", refers to \`${derived.name}\`.`,
          quote: failure.resultLine,
          evidenceIds: [run.id],
        });
      }
      const substituted = replaceIdentifier(declaration.expression, operand, derived.name);
      const derivedValue = knownValues.get(derived.name);
      const result = evaluateArithmetic(substituted, values);
      const prior = test.priorAssertions.find((item) => item.property === derived.name);
      if (expected !== undefined && derivedValue !== undefined && result !== undefined && prior) {
        const finding: Finding = {
          statement: `With \`${derived.name}\` = ${derivedValue} (asserted earlier in the failing test)${describeConstants(substituted, computation)}, \`${substituted}\` evaluates to ${result}; the failing assertion expects ${expected}.`,
          quote: prior.text,
          evidenceIds: unique([testEvidence.id, sourceEvidence.id]),
        };
        if (sameNumber(result, expected)) support.push(finding);
        else contradiction.push({ ...finding, decisive: true });
      }
      candidates.push({
        id: hypothesisId('input', target, operand, derived.name),
        kind: 'wrong_input',
        statement: `\`${target}\` uses \`${operand}\` where it should use \`${derived.name}\`.`,
        support,
        contradiction,
        substitution: { path: computation.path, line: declaration.line, from: operand, to: derived.name },
      });
    }
  }

  const upstream = unique([
    ...operands.filter((name) => localByName.has(name)),
    ...test.priorAssertions.map((item) => item.property).filter((name) => localByName.has(name) && name !== target),
  ]);
  for (const name of upstream) {
    const contradiction: Finding[] = [];
    for (const prior of test.priorAssertions.filter((item) => item.property === name)) {
      contradiction.push({
        statement: `\`${prior.subject}\` is asserted to equal ${prior.expected} on line ${prior.line}, before the failing assertion on line ${assertion.line} of the same test, and that assertion held.`,
        quote: prior.text,
        evidenceIds: unique([testEvidence.id, run.id]),
      });
    }
    for (const passing of test.passingAssertions.filter((item) => item.assertion.property === name)) {
      contradiction.push({
        statement: `Test "${passing.test}" reported ok while asserting that \`${passing.assertion.subject}\` equals ${passing.assertion.expected}.`,
        quote: passing.assertion.text,
        evidenceIds: unique([testEvidence.id, run.id]),
      });
    }
    candidates.push({
      id: hypothesisId('value', name),
      kind: 'upstream_value',
      statement: `\`${name}\` is computed incorrectly, so \`${target}\` inherits a wrong value.`,
      support: [],
      contradiction,
    });
  }

  for (const name of operands.filter((operand) => constantByName.has(operand))) {
    const constant = constantByName.get(name);
    if (!constant) continue;
    const contradiction = test.passingAssertions
      .filter((item) => item.assertion.property === target)
      .map((passing) => ({
        statement: `Test "${passing.test}" reported ok while asserting that \`${passing.assertion.subject}\`, which is computed with \`${name}\`, equals ${passing.assertion.expected}.`,
        quote: passing.assertion.text,
        evidenceIds: unique([testEvidence.id, run.id]),
      }));
    candidates.push({
      id: hypothesisId('constant', name),
      kind: 'wrong_constant',
      statement: `The constant \`${name}\` (${constant.expression}) has the wrong value for \`${target}\`.`,
      support: [],
      contradiction,
    });
  }

  return candidates;
}

function describeConstants(expression: string, computation: Computation): string {
  const used = computation.constants.filter((constant) => valueIdentifiers(expression).includes(constant.name));
  return used.map((constant) => ` and \`${constant.name}\` = ${constant.value}`).join('');
}

const BOUNDARY_TWIN: Readonly<Record<BoundaryOperator, BoundaryOperator>> = { '>': '>=', '>=': '>', '<': '<=', '<=': '<' };

function holds(operator: BoundaryOperator, left: number, right: number): boolean {
  switch (operator) {
    case '>':
      return left > right;
    case '>=':
      return left >= right;
    case '<':
      return left < right;
    case '<=':
      return left <= right;
  }
}

/**
 * wrong_operator: `target` is `a OP b ? x : y` with OP one of `>`, `>=`, `<`,
 * `<=`, and the failing test calls the enclosing function with number literals
 * that put `a` exactly on `b`, where OP and its boundary twin (`>` and `>=`,
 * `<` and `<=`) disagree. Formed only when, for those literals, OP gives the
 * value the run reported and the twin gives the value the failing assertion
 * expects. Names (of tests, variables, or the incident) are never read as
 * evidence. Any shape that is not read exactly, or any value that is not
 * known, yields no candidate; a run reporting other values, or a passing test
 * that also calls the function on the boundary, rejects it.
 */
function boundaryCandidates(
  reproduction: Reproduction,
  test: FailingTest,
  match: Evidence,
  computation: Computation,
): HypothesisCandidate[] {
  const { declaration, lines } = computation;
  const { assertion, block, lines: testLines } = test;
  const failure = reproduction.failure;
  const run = reproduction.evidence;
  const testEvidence = test.evidence;
  const sourceEvidence = computation.evidence;
  if (!declaration || !lines || !assertion || !block || !testLines || !failure || !run || !testEvidence || !sourceEvidence) return [];

  const target = declaration.name;
  const conditional = parseBoundaryConditional(declaration.expression);
  const fn = enclosingFunction(lines, declaration);
  if (!conditional || !fn || !declaration.text.startsWith('const ')) return [];
  if (lines.some((line) => line.line > fn.line && line.line < declaration.line && !isStraightLine(line))) return [];
  const exit = lines.find((line) => line.line > declaration.line && !isStraightLine(line));
  if (!exit || !returnsLocalAs(exit, target)) return [];

  const [object, property, ...rest] = assertion.subject.split('.');
  if (object === undefined || property !== target || rest.length > 0) return [];
  if (!isNumberLiteral(assertion.expected) || failure.actual === undefined || !isNumberLiteral(failure.actual)) return [];
  const expected = Number(assertion.expected);
  const actual = Number(failure.actual);
  if (!importsName(testLines, test.path, fn.name, computation.path)) return [];

  const callPattern = new RegExp(`(?<![\\w$.])${fn.name.replace(/\$/g, '\\$')}\\s*\\(`);
  const callsIn = (from: number, to: number) =>
    testLines.filter((line) => line.line >= from && line.line <= to && callPattern.test(line.text));
  const subjectCalls = testLines
    .filter((line) => line.line >= block.startLine && line.line < assertion.line)
    .flatMap((line) => parseLiteralCall(line) ?? [])
    .filter((call) => call.name === object);
  const [call, ...otherCalls] = subjectCalls;
  if (!call || otherCalls.length > 0 || call.callee !== fn.name || call.args.length !== fn.parameters.length) return [];

  const localNames = new Set(computation.locals.map((local) => local.name));
  const constants = new Map(computation.constants.map((constant) => [constant.name, constant.value]));
  const evaluate = (args: readonly number[]) => {
    const value = (operand: string): number | undefined => {
      if (isNumberLiteral(operand)) return Number(operand);
      const index = fn.parameters.indexOf(operand);
      if (index >= 0) return args[index];
      return localNames.has(operand) ? undefined : constants.get(operand);
    };
    const [left, right, whenTrue, whenFalse] = [conditional.left, conditional.right, conditional.whenTrue, conditional.whenFalse].map(value);
    if (left === undefined || right === undefined || whenTrue === undefined || whenFalse === undefined) return undefined;
    const pick = (operator: BoundaryOperator) => (holds(operator, left, right) ? whenTrue : whenFalse);
    return { left, right, current: pick(conditional.operator), twin: pick(BOUNDARY_TWIN[conditional.operator]) };
  };

  const failing = evaluate(call.args);
  if (!failing || !sameNumber(failing.left, failing.right)) return [];
  if (sameNumber(failing.current, expected) || !sameNumber(failing.twin, expected)) return [];
  const twin = BOUNDARY_TWIN[conditional.operator];
  const sourceLine = lines.find((line) => line.line === declaration.line);
  if (!sourceLine || replaceBinaryOperator(sourceLine.text, conditional.operator, twin) === undefined) return [];

  const comparison = `${conditional.left} ${conditional.operator} ${conditional.right}`;
  const fixed = `${conditional.left} ${twin} ${conditional.right}`;
  const reported = failure.comparison ?? failure.resultLine;
  const support: Finding[] = [
    {
      statement: `\`${target}\` is computed as \`${declaration.expression}\` in \`${fn.name}(${fn.parameters.join(', ')})\`, which returns it as \`${target}\`.`,
      quote: declaration.text,
      evidenceIds: unique([sourceEvidence.id, match.id]),
    },
    {
      statement: `The failing test calls \`${call.text}\`, so \`${conditional.left}\` = ${failing.left} and \`${conditional.right}\` = ${failing.right}, exactly the boundary: \`${comparison}\` gives ${failing.current}, while \`${fixed}\` gives ${failing.twin}, the value the failing assertion on \`${assertion.subject}\` expects.`,
      quote: call.text,
      evidenceIds: unique([testEvidence.id, sourceEvidence.id]),
    },
  ];
  const contradiction: Finding[] = [];

  const reportsComputedValues =
    sameNumber(actual, failing.current) && (failure.expected === undefined || (isNumberLiteral(failure.expected) && sameNumber(Number(failure.expected), expected)));
  if (reportsComputedValues) {
    support.push({
      statement: `The run reports \`${assertion.subject}\` as ${actual} where ${expected} was expected, which is what \`${comparison}\` gives on the boundary.`,
      quote: reported,
      evidenceIds: [run.id],
    });
  } else {
    contradiction.push({
      statement: `The run reports \`${assertion.subject}\` as ${failure.actual}${failure.expected === undefined ? '' : ` where ${failure.expected} was expected`}, but \`${declaration.expression}\` gives ${failing.current} for the failing test's arguments, so this computation does not explain the failure.`,
      quote: reported,
      evidenceIds: unique([run.id, sourceEvidence.id]),
      decisive: true,
    });
  }

  const passed = new Set(reproduction.observation?.passed.map((item) => item.name));
  for (const other of findTestBlocks(testLines).filter((item) => passed.has(item.name) && item.name !== failure.name)) {
    for (const line of callsIn(other.startLine, other.endLine)) {
      const otherCall = parseLiteralCall(line);
      if (!otherCall || otherCall.callee !== fn.name || otherCall.args.length !== fn.parameters.length) return [];
      const values = evaluate(otherCall.args);
      if (!values) return [];
      if (sameNumber(values.left, values.right) && !sameNumber(values.current, values.twin)) {
        contradiction.push({
          statement: `Test "${other.name}" reported ok while calling \`${otherCall.text}\` on the same boundary, where \`${fixed}\` would change \`${target}\` from ${values.current} to ${values.twin}.`,
          quote: otherCall.text,
          evidenceIds: unique([testEvidence.id, run.id]),
          decisive: true,
        });
      }
    }
  }

  const contradicting = new Set(contradiction.flatMap((finding) => finding.evidenceIds));
  return [
    {
      id: hypothesisId('boundary', target),
      kind: 'wrong_operator',
      statement: `\`${target}\` compares \`${comparison}\` where the failing test needs \`${fixed}\`: it calls \`${fn.name}\` exactly on that boundary.`,
      support: support.filter((finding) => !finding.evidenceIds.some((id) => contradicting.has(id))),
      contradiction,
      operatorSubstitution: { path: computation.path, line: declaration.line, from: conditional.operator, to: twin },
    },
  ];
}

/** Whether a line of `fromPath` is `import { ..., name, ... } from '<relative path to modulePath>'`. */
function importsName(lines: readonly SourceLine[], fromPath: string, name: string, modulePath: string): boolean {
  const directory = path.dirname(fromPath);
  return lines.some((line) => {
    const found = /^\s*import\s*\{([^}]*)\}\s*from\s*['"](\.{1,2}\/[^'"]+)['"]\s*;?\s*$/.exec(line.text);
    if (!found) return false;
    const names = (found[1] ?? '').split(',').map((item) => item.trim());
    return names.includes(name) && path.normalize(path.join(directory, found[2] ?? '')) === modulePath;
  });
}

function sameNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

function hypothesisId(...parts: string[]): string {
  return `hyp-${parts.map((part) => part.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-')).join('-')}`;
}

/** The most recent action of `tool` whose input satisfies `matches`. */
export function latestAction(
  context: PlannerContext,
  tool: string,
  matches: (input: Readonly<Record<string, unknown>>) => boolean,
): InvestigationActionRecord | undefined {
  return context.actions.findLast((action) => action.tool === tool && matches(action.input));
}

function evidenceOf(context: PlannerContext, action: InvestigationActionRecord): Evidence[] {
  const ids = new Set(action.resultingEvidenceIds);
  return context.evidence.filter((item) => ids.has(item.id));
}

function importedPaths(lines: readonly SourceLine[], fromPath: string): string[] {
  const directory = path.dirname(fromPath);
  return lines.flatMap((line) => {
    const specifier = /\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/.exec(line.text)?.[1];
    return specifier === undefined ? [] : [path.normalize(path.join(directory, specifier))];
  });
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}
