import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { HypothesisSchema, type Evidence, type Hypothesis, type InvestigationActionRecord } from '@devpilot/core';
import {
  analyzeInvestigation,
  assessHypothesis,
  chooseHypothesis,
  RulePlanner,
  type HypothesisCandidate,
  type PlannerContext,
} from '../src/index.js';

const FIXTURE = new URL('../../../fixtures/shipping-repository/', import.meta.url);
const SOURCE = readFileSync(new URL('src/shipping.ts', FIXTURE), 'utf8');
const TEST = readFileSync(new URL('test/shipping.test.ts', FIXTURE), 'utf8');
const SOURCE_PATH = 'src/shipping.ts';
const TEST_PATH = 'test/shipping.test.ts';
const AT_THRESHOLD = 'ships free exactly at the threshold';
const PASSING = ['charges the flat rate below the threshold', 'ships free above the threshold'];
const BUGGY = '  const shipping = subtotal > freeThreshold ? 0 : flatRate;';
const ELIGIBLE = 'Supported; eligible for selection if no competing hypothesis is as well supported.';

/** `text` with the line `from` replaced; fails if the line is absent, so a variant can never silently equal the fixture. */
function replaceLine(text: string, from: string, to: string): string {
  const lines = text.split('\n');
  const index = lines.indexOf(from);
  assert.notEqual(index, -1, `the text contains ${JSON.stringify(from)}`);
  lines[index] = to;
  return lines.join('\n');
}

function lineOf(text: string, needle: string, after = 0): number {
  const index = text.split('\n').findIndex((line, at) => at + 1 > after && line.includes(needle));
  assert.notEqual(index, -1, `the text contains ${JSON.stringify(needle)}`);
  return index + 1;
}

interface Failing {
  readonly name: string;
  readonly actual?: string;
  readonly expected?: string;
}

/** `node --test --test-reporter=tap` output with the repository root redacted, as the run_command tool records it. */
function tapOutput(test: string, passing: readonly string[], failing: Failing): string {
  const lines = ['TAP version 13'];
  passing.forEach((name, index) => {
    lines.push(`# Subtest: ${name}`, `ok ${index + 1} - ${name}`, '  ---', '  duration_ms: 0.5', "  type: 'test'", '  ...');
  });
  const start = lineOf(test, `test('${failing.name}'`);
  const assertion = lineOf(test, 'assert.', start);
  const compared = failing.actual !== undefined && failing.expected !== undefined;
  lines.push(
    `# Subtest: ${failing.name}`,
    `not ok ${passing.length + 1} - ${failing.name}`,
    '  ---',
    '  duration_ms: 0.5',
    "  type: 'test'",
    `  location: '<repo>/${TEST_PATH}:${start}:1'`,
    "  failureType: 'testCodeFailure'",
    '  error: |-',
    compared ? '    Expected values to be strictly equal:' : '    The expression evaluated to a falsy value',
    ...(compared ? ['    ', `    ${failing.actual} !== ${failing.expected}`, '    '] : []),
    "  code: 'ERR_ASSERTION'",
    "  name: 'AssertionError'",
    ...(failing.expected === undefined ? [] : [`  expected: ${failing.expected}`]),
    ...(failing.actual === undefined ? [] : [`  actual: ${failing.actual}`]),
    '  stack: |-',
    `    TestContext.<anonymous> (file://<repo>/${TEST_PATH}:${assertion}:10)`,
    '  ...',
    `1..${passing.length + 1}`,
  );
  return lines.join('\n');
}

interface Scenario {
  readonly source?: string;
  readonly test?: string;
  readonly passing?: readonly string[];
  readonly failing?: Failing;
  readonly hypotheses?: readonly Hypothesis[];
}

/** The context the rule planner has once it has run the tests, read the failing test, searched for the value, and read its source. */
function contextFor({ source = SOURCE, test = TEST, passing = PASSING, failing = { name: AT_THRESHOLD, actual: '500', expected: '0' }, hypotheses = [] }: Scenario = {}): PlannerContext {
  const actions: InvestigationActionRecord[] = [];
  const evidence: Evidence[] = [];
  const record = (tool: string, input: Record<string, unknown>, items: readonly Omit<Evidence, 'source' | 'collectedAt' | 'summary'>[]) => {
    const id = `act-${actions.length + 1}`;
    actions.push({ id, tool, input: input as InvestigationActionRecord['input'], rationale: 'r', expectedEvidence: 'e', hypothesisIds: [], status: 'completed', resultingEvidenceIds: items.map((item) => item.id) });
    for (const item of items) evidence.push({ ...item, summary: 's', source: { tool, actionId: id }, collectedAt: '2026-01-01T00:00:00.000Z' });
  };
  record('run_command', { command: 'npm', args: ['test'] }, [
    { id: 'ev-run', kind: 'command_output', content: tapOutput(test, passing, failing), location: { type: 'command', command: 'npm test', exitCode: 1 } },
  ]);
  record('read_file', { path: TEST_PATH }, [{ id: 'ev-test', kind: 'source_code', content: test, location: { type: 'file', path: TEST_PATH, startLine: 1 } }]);
  record(
    'search_code',
    { query: 'shipping =' },
    source
      .split('\n')
      .flatMap((text, index) => (text.includes('shipping =') ? [{ text, line: index + 1 }] : []))
      .map(({ text, line }) => ({ id: `ev-hit-${line}`, kind: 'search_result' as const, content: text, location: { type: 'file' as const, path: SOURCE_PATH, startLine: line, endLine: line } })),
  );
  record('read_file', { path: SOURCE_PATH }, [{ id: 'ev-source', kind: 'source_code', content: source, location: { type: 'file', path: SOURCE_PATH, startLine: 1 } }]);
  return {
    investigationId: 'inv-boundary',
    signal: { id: 'sig-boundary', kind: 'failing_test', title: 'Shipping', content: `not ok 3 - ${AT_THRESHOLD}`, command: 'npm test', receivedAt: '2026-01-01T00:00:00.000Z' },
    stepCount: actions.length,
    remainingSteps: 10,
    actions,
    evidence,
    hypotheses: [...hypotheses],
    verifications: [],
    patchProposals: [],
    tools: ['read_file', 'search_code', 'list_files', 'run_command'].map((name) => ({ name, description: name })),
  };
}

const boundaryCandidates = (scenario: Scenario = {}) =>
  analyzeInvestigation(contextFor(scenario), { operatorBoundaries: true }).candidates.filter((item) => item.kind === 'wrong_operator');

function onlyCandidate(scenario: Scenario = {}): HypothesisCandidate {
  const candidates = boundaryCandidates(scenario);
  assert.equal(candidates.length, 1, JSON.stringify(candidates.map((item) => item.id)));
  return candidates[0] as HypothesisCandidate;
}

describe('operator-boundary hypotheses', () => {
  it('derives `>` -> `>=` from the source, the failing call on the boundary, and the reported values', () => {
    const context = contextFor();
    const candidate = onlyCandidate();
    assert.equal(candidate.id, 'hyp-boundary-shipping');
    assert.equal(candidate.kind, 'wrong_operator');
    assert.deepEqual(candidate.operatorSubstitution, { path: SOURCE_PATH, line: 9, from: '>', to: '>=' });
    assert.equal(candidate.substitution, undefined);
    assert.deepEqual(candidate.contradiction, []);
    assert.deepEqual(
      candidate.support.map((finding) => finding.evidenceIds),
      [['ev-source', 'ev-hit-9'], ['ev-test', 'ev-source'], ['ev-run']],
    );
    assert.equal(
      candidate.support[1]?.statement,
      'The failing test calls `const quote = quoteShipping(5000, 5000, 500);`, so `subtotal` = 5000 and `freeThreshold` = 5000, exactly the boundary: `subtotal > freeThreshold` gives 500, while `subtotal >= freeThreshold` gives 0, the value the failing assertion on `quote.shipping` expects.',
    );
    for (const finding of candidate.support) {
      const cited = context.evidence.find((item) => item.id === finding.evidenceIds[0]);
      assert.ok(cited?.content?.includes(finding.quote), `"${finding.quote}" is verbatim in ${cited?.id}`);
    }
  });

  it('is assessed as supported and eligible, and selected when it is the only candidate', () => {
    const assessed = assessHypothesis(onlyCandidate());
    HypothesisSchema.parse(assessed);
    assert.equal(assessed.status, 'supported');
    assert.equal(assessed.confidence, 0.8);
    assert.deepEqual(assessed.supportingEvidenceIds, ['ev-source', 'ev-hit-9', 'ev-test', 'ev-run']);
    assert.equal(assessed.nextActionReason, ELIGIBLE);
    assert.equal(chooseHypothesis([assessed])?.id, 'hyp-boundary-shipping');

    const { operatorSubstitution: _, ...withoutRepair } = onlyCandidate();
    assert.equal(assessHypothesis(withoutRepair).nextActionReason, 'Supported, but no repair can be derived from the evidence for this kind of hypothesis.');
  });

  it('derives the other direction, `<=` -> `<`, from the same kind of evidence', () => {
    const source = replaceLine(SOURCE, BUGGY, '  const shipping = subtotal <= freeThreshold ? flatRate : 0;');
    assert.deepEqual(onlyCandidate({ source }).operatorSubstitution, { path: SOURCE_PATH, line: 9, from: '<=', to: '<' });
  });

  it('reads module-level numeric constants as operands', () => {
    const source = replaceLine(
      replaceLine(SOURCE, BUGGY, '  const shipping = subtotal > FREE_THRESHOLD ? 0 : flatRate;'),
      '/** Orders at or above the threshold ship free; smaller orders pay the flat rate. */',
      'const FREE_THRESHOLD = 5000;',
    ).replace('quoteShipping(subtotal: number, freeThreshold: number, flatRate: number)', 'quoteShipping(subtotal: number, flatRate: number)');
    const test = TEST.replace('quoteShipping(5000, 5000, 500)', 'quoteShipping(5000, 500)')
      .replace('quoteShipping(4000, 5000, 500)', 'quoteShipping(4000, 500)')
      .replace('quoteShipping(6000, 5000, 500)', 'quoteShipping(6000, 500)');
    assert.deepEqual(onlyCandidate({ source, test }).operatorSubstitution, { path: SOURCE_PATH, line: 9, from: '>', to: '>=' });
  });

  describe('is off unless asked for', () => {
    it('forms no boundary hypothesis in the default analysis', () => {
      assert.deepEqual(analyzeInvestigation(contextFor()).candidates, []);
      assert.deepEqual(analyzeInvestigation(contextFor(), {}).candidates, []);
      assert.deepEqual(analyzeInvestigation(contextFor(), { operatorBoundaries: false }).candidates, []);
    });

    it('leaves the default rule planner unable to explain the incident', async () => {
      const reason = `No competing hypotheses could be formed from \`${BUGGY.trim()}\`.`;
      for (const planner of [new RulePlanner(), new RulePlanner({}), new RulePlanner({ operatorBoundaries: false })]) {
        assert.deepEqual(await planner.next(contextFor()), { type: 'finish', reason });
      }
    });

    it('lets the opted-in rule planner propose, select, and patch the boundary hypothesis', async () => {
      const planner = new RulePlanner({ operatorBoundaries: true });
      const proposed = await planner.next(contextFor());
      assert.equal(proposed.type, 'update_hypotheses');
      assert.deepEqual(proposed.type === 'update_hypotheses' && proposed.hypotheses.map((item) => [item.id, item.status]), [['hyp-boundary-shipping', 'proposed']]);

      const assessed = assessHypothesis(onlyCandidate());
      const selected = chooseHypothesis([assessed]);
      assert.ok(selected);
      assert.deepEqual(await planner.next(contextFor({ hypotheses: [assessed] })), { type: 'update_hypotheses', hypotheses: [selected] });

      const decision = await planner.next(contextFor({ hypotheses: [selected] }));
      assert.equal(decision.type, 'propose_patch');
      const proposal = decision.type === 'propose_patch' ? decision.proposal : undefined;
      assert.equal(proposal?.hypothesisId, 'hyp-boundary-shipping');
      assert.deepEqual(proposal?.affectedPaths, [SOURCE_PATH]);
      assert.deepEqual(proposal?.supportingEvidenceIds, ['ev-source', 'ev-hit-9', 'ev-test', 'ev-run']);
      assert.ok(proposal?.patch.includes(`\n-${BUGGY}\n+  const shipping = subtotal >= freeThreshold ? 0 : flatRate;\n`), proposal?.patch);
    });
  });

  describe('forms no hypothesis without sufficient evidence', () => {
    it('when the failing call is not on the boundary, whatever the test is called', () => {
      const test = TEST.replace('quoteShipping(5000, 5000, 500)', 'quoteShipping(4999, 5000, 500)');
      assert.deepEqual(boundaryCandidates({ test }), []);
    });

    it('when the arguments are not number literals', () => {
      const test = TEST.replace('  const quote = quoteShipping(5000, 5000, 500);', '  const threshold = 5000;\n  const quote = quoteShipping(threshold, threshold, 500);');
      assert.deepEqual(boundaryCandidates({ test }), []);
    });

    it('when the run reports no actual value', () => {
      assert.deepEqual(boundaryCandidates({ failing: { name: AT_THRESHOLD } }), []);
      assert.deepEqual(boundaryCandidates({ failing: { name: AT_THRESHOLD, expected: '0' } }), []);
    });

    it('when the other operator would not give the expected value either', () => {
      const test = TEST.replace('assert.equal(quote.shipping, 0);', 'assert.equal(quote.shipping, 250);');
      assert.deepEqual(boundaryCandidates({ test, failing: { name: AT_THRESHOLD, actual: '500', expected: '250' } }), []);
    });

    it('when the current operator already gives the expected value', () => {
      const test = TEST.replace('assert.equal(quote.shipping, 0);', 'assert.equal(quote.shipping, 500);');
      assert.deepEqual(boundaryCandidates({ test, failing: { name: AT_THRESHOLD, actual: '500', expected: '500' } }), []);
    });

    it('when the failing test does not import the function from the file that computes the value', () => {
      for (const test of [
        TEST.replace("import { quoteShipping } from '../src/shipping.ts';", "import { quoteShipping } from '../src/other.ts';"),
        TEST.replace("import { quoteShipping } from '../src/shipping.ts';", "import { quoteShipping as quoteShipping } from '../src/shipping.ts';"),
      ]) {
        assert.deepEqual(boundaryCandidates({ test }), []);
      }
    });

    it('when a passing test calls the function in a way that cannot be evaluated', () => {
      const test = TEST.replace('  const quote = quoteShipping(6000, 5000, 500);', '  const quote = quoteShipping(...[6000, 5000, 500]);');
      assert.deepEqual(boundaryCandidates({ test }), []);
    });
  });

  describe('rejects the hypothesis when evidence contradicts it', () => {
    /** Rejected, never selectable, and valid for the engine: no evidence both supports and contradicts it. */
    function assertRejected(candidate: HypothesisCandidate): Hypothesis {
      const assessed = assessHypothesis(candidate);
      assert.equal(assessed.status, 'rejected');
      assert.equal(assessed.confidence, 0);
      assert.equal(chooseHypothesis([assessed]), undefined);
      HypothesisSchema.parse(assessed);
      return assessed;
    }

    it('when the run reports a value the source does not compute', () => {
      const candidate = onlyCandidate({ failing: { name: AT_THRESHOLD, actual: '450', expected: '0' } });
      assert.deepEqual(
        candidate.contradiction.map((finding) => [finding.quote, finding.evidenceIds, finding.decisive]),
        [['450 !== 0', ['ev-run', 'ev-source'], true]],
      );
      assert.deepEqual(assertRejected(candidate).supportingEvidenceIds, []);
    });

    it('when the run reports a different expected value than the assertion', () => {
      assertRejected(onlyCandidate({ failing: { name: AT_THRESHOLD, actual: '500', expected: '1' } }));
    });

    it('when a passing test calls the function on the same boundary', () => {
      const test = `${TEST}\ntest('charges a small order exactly at its threshold', () => {\n  const quote = quoteShipping(3000, 3000, 250);\n  assert.equal(quote.total, 3250);\n});\n`;
      const candidate = onlyCandidate({ test, passing: [...PASSING, 'charges a small order exactly at its threshold'] });
      assert.deepEqual(
        candidate.contradiction.map((finding) => [finding.quote, finding.evidenceIds, finding.decisive]),
        [['const quote = quoteShipping(3000, 3000, 250);', ['ev-test', 'ev-run'], true]],
      );
      const assessed = assertRejected(candidate);
      assert.deepEqual(assessed.supportingEvidenceIds, ['ev-source', 'ev-hit-9']);
      assert.deepEqual(assessed.contradictingEvidenceIds, ['ev-test', 'ev-run']);
    });

    it('but not when the passing boundary call gives the same value either way', () => {
      const test = `${TEST}\ntest('zero rate at the threshold', () => {\n  const quote = quoteShipping(3000, 3000, 0);\n  assert.equal(quote.total, 3000);\n});\n`;
      const candidate = onlyCandidate({ test, passing: [...PASSING, 'zero rate at the threshold'] });
      assert.deepEqual(candidate.contradiction, []);
      assert.equal(assessHypothesis(candidate).status, 'supported');
    });
  });

  describe('forms no hypothesis from expressions or functions it cannot read exactly', () => {
    for (const line of [
      '  const shipping = subtotal > freeThreshold && flatRate > 0 ? 0 : flatRate;',
      '  const shipping = subtotal > freeThreshold ? 0 : subtotal > 0 ? flatRate : 0;',
      '  const shipping = (subtotal > freeThreshold) ? 0 : flatRate;',
      '  const shipping = subtotal>freeThreshold ? 0 : flatRate;',
      '  const shipping = subtotal + 1 > freeThreshold ? 0 : flatRate;',
      '  const shipping = Math.max(subtotal, 0) > freeThreshold ? 0 : flatRate;',
      '  const shipping = subtotal === freeThreshold ? 0 : flatRate;',
      '  const shipping = subtotal > freeThreshold ? 0 : flatRate; // a > b',
      '  let shipping = subtotal > freeThreshold ? 0 : flatRate;',
      '  const shipping = subtotal > unknownLimit ? 0 : flatRate;',
    ]) {
      it(line.trim(), () => {
        assert.deepEqual(boundaryCandidates({ source: replaceLine(SOURCE, BUGGY, line) }), []);
      });
    }

    it('a parameter with a default value', () => {
      const source = SOURCE.replace('freeThreshold: number,', 'freeThreshold = 5000,');
      assert.notEqual(source, SOURCE);
      assert.deepEqual(boundaryCandidates({ source }), []);
    });

    it('a function that is not an exported one-line declaration', () => {
      const source = SOURCE.replace(
        'export function quoteShipping(subtotal: number, freeThreshold: number, flatRate: number): ShippingQuote {',
        'export const quoteShipping = (subtotal: number, freeThreshold: number, flatRate: number): ShippingQuote => {',
      );
      assert.notEqual(source, SOURCE);
      assert.deepEqual(boundaryCandidates({ source }), []);
    });

    it('a branch, early return, or reassignment before the comparison', () => {
      for (const statement of ['  if (subtotal === freeThreshold) return { subtotal, shipping: 0, total: subtotal };', '  subtotal = Math.round(subtotal);']) {
        const source = replaceLine(SOURCE, BUGGY, `${statement}\n${BUGGY}`);
        assert.deepEqual(boundaryCandidates({ source }), []);
      }
    });

    it('an operand that is a local value rather than a parameter or constant', () => {
      const source = replaceLine(SOURCE, BUGGY, '  const limit = freeThreshold;\n  const shipping = subtotal > limit ? 0 : flatRate;');
      assert.deepEqual(boundaryCandidates({ source }), []);
    });

    it('a return that does not return the computed value under its own name', () => {
      for (const statement of ['  return { subtotal, shipping: flatRate, total: subtotal + shipping };', '  return { subtotal, ...{ shipping }, total: subtotal + shipping };']) {
        const source = replaceLine(SOURCE, '  return { subtotal, shipping, total: subtotal + shipping };', statement);
        assert.deepEqual(boundaryCandidates({ source }), []);
      }
    });
  });
});
