import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Hypothesis } from '@devpilot/core';
import { chooseHypothesis, evaluateArithmetic, parseTestOutput } from '../src/index.js';

const TAP = [
  'TAP version 13',
  '# Subtest: adds numbers',
  'ok 1 - adds numbers',
  '  ---',
  '  duration_ms: 0.5',
  '  ...',
  '# Subtest: multiplies numbers',
  'not ok 2 - multiplies numbers',
  '  ---',
  "  location: '<repo>/test/math.test.ts:9:1'",
  '  error: |-',
  '    Expected values to be strictly equal:',
  '    ',
  '    7 !== 12',
  '    ',
  '  expected: 12',
  '  actual: 7',
  '  stack: |-',
  '    TestContext.<anonymous> (file://<repo>/node_modules/helper/index.js:1:1)',
  '    TestContext.<anonymous> (file://<repo>/test/math.test.ts:11:10)',
  '  ...',
  '1..2',
].join('\n');

describe('test output parsing', () => {
  it('extracts passing tests, the failing test, its in-repository location, and the compared values', () => {
    assert.deepEqual(parseTestOutput(TAP), {
      passed: [{ name: 'adds numbers', resultLine: 'ok 1 - adds numbers' }],
      failed: [
        {
          name: 'multiplies numbers',
          resultLine: 'not ok 2 - multiplies numbers',
          failurePosition: { path: 'test/math.test.ts', line: 11 },
          actual: '7',
          expected: '12',
          comparison: '7 !== 12',
        },
      ],
    });
  });

  it('reports nothing for output it does not recognise', () => {
    assert.deepEqual(parseTestOutput('FAIL src/math.test.js\n  Expected: 12'), { passed: [], failed: [] });
  });
});

describe('arithmetic evaluation', () => {
  const values = new Map([
    ['price', 2250],
    ['RATE', 0.08],
  ]);

  it('evaluates the supported subset', () => {
    assert.equal(evaluateArithmetic('Math.round(price * RATE)', values), 180);
    assert.equal(evaluateArithmetic('-(price - 250) / 2 + Math.max(1, 3)', values), -997);
  });

  it('refuses unbound names, calls, and anything outside the subset instead of guessing', () => {
    for (const expression of ['price * unknown', 'applyDiscount(price)', 'price.toFixed(2)', 'process.exit(1)', 'price; 1', '`${price}`', 'price ** 2']) {
      assert.equal(evaluateArithmetic(expression, values), undefined, expression);
    }
  });
});

describe('hypothesis selection', () => {
  const ev = (n: number) => `ev-${n.toString(16).padStart(16, '0')}`;
  const supported = (id: string, evidence: number[], confidence: number): Hypothesis => ({
    id,
    statement: id,
    status: 'supported',
    confidence,
    supportingEvidenceIds: evidence.map(ev),
    contradictingEvidenceIds: [],
    nextActionReason: 'Assessed',
  });

  it('selects the single best-supported hypothesis', () => {
    const chosen = chooseHypothesis([supported('hyp-a', [1, 2, 3], 0.75), supported('hyp-b', [4], 0.5)]);
    assert.equal(chosen?.id, 'hyp-a');
    assert.equal(chosen?.status, 'selected');
  });

  it('selects nothing when the best hypothesis is too weakly supported or tied', () => {
    assert.equal(chooseHypothesis([supported('hyp-a', [1], 0.5)]), undefined);
    assert.equal(chooseHypothesis([supported('hyp-a', [1, 2], 0.66), supported('hyp-b', [3, 4], 0.66)]), undefined);
    assert.equal(chooseHypothesis([]), undefined);
  });
});
