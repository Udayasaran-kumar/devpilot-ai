import path from 'node:path/posix';
import { isTestPath, type Evidence, type EvidenceId, type InvestigationActionRecord } from '@devpilot/core';
import { evaluateArithmetic } from './analysis/arithmetic.js';
import {
  assertionsIn,
  findTestBlocks,
  isNumberLiteral,
  localsBefore,
  numberLines,
  numericConstants,
  parseAssertion,
  parseDeclaration,
  replaceIdentifier,
  valueIdentifiers,
  words,
  type Assertion,
  type Declaration,
  type SourceLine,
  type TestBlock,
} from './analysis/source.js';
import { parseTestOutput, type TestFailure, type TestRunObservation } from './analysis/test-output.js';
import type { PlannerContext } from './planner.js';

/** One observation drawn from evidence. `quote` is verbatim text from the first cited evidence item. */
export interface Finding {
  readonly statement: string;
  readonly quote: string;
  readonly evidenceIds: readonly EvidenceId[];
  /** A contradiction that rules the hypothesis out rather than merely weakening it. */
  readonly decisive?: boolean;
}

export type HypothesisKind = 'wrong_input' | 'upstream_value' | 'wrong_constant';

/** A candidate repair: replace `from` with `to` in the expression on `line` of `path`. */
export interface IdentifierSubstitution {
  readonly path: string;
  readonly line: number;
  readonly from: string;
  readonly to: string;
}

export interface HypothesisCandidate {
  readonly id: string;
  readonly kind: HypothesisKind;
  readonly statement: string;
  readonly support: readonly Finding[];
  readonly contradiction: readonly Finding[];
  readonly substitution?: IdentifierSubstitution;
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

const SHELL_SYNTAX = /[;&|<>`$(){}[\]*?!~"'\\]/;

export function analyzeInvestigation(context: PlannerContext): InvestigationAnalysis {
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
    candidates: generateCandidates(reproduction, failingTest, definition.match, computation),
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
