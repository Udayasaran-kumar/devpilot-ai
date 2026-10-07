import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkExclusiveSelection, HypothesisSchema, maxEvidenceConfidence, type Hypothesis } from '../src/index.js';

const ev = (n: number) => `ev-${n.toString(16).padStart(16, '0')}`;
const hypothesis = (overrides: Partial<Hypothesis> = {}): Hypothesis => ({
  id: 'hyp-1',
  statement: 'The value uses the wrong input',
  status: 'supported',
  confidence: 0.5,
  supportingEvidenceIds: [ev(1)],
  contradictingEvidenceIds: [],
  nextActionReason: 'Gather more evidence',
  ...overrides,
});
const valid = (overrides: Partial<Hypothesis>) => HypothesisSchema.safeParse(hypothesis(overrides)).success;

describe('evidence-bounded hypothesis confidence', () => {
  it('derives an upper bound from distinct supporting and contradicting evidence that never reaches 1', () => {
    assert.equal(maxEvidenceConfidence(0, 0), 0);
    assert.equal(maxEvidenceConfidence(1, 0), 0.5);
    assert.equal(maxEvidenceConfidence(4, 0), 0.8);
    assert.equal(maxEvidenceConfidence(2, 1), 0.5);
    assert.ok(maxEvidenceConfidence(1000, 0) < 1);
  });

  it('refuses confidence the evidence does not allow, counting duplicate IDs once', () => {
    assert.equal(valid({ confidence: 0.5 }), true);
    assert.equal(valid({ confidence: 0.51 }), false);
    assert.equal(valid({ confidence: 0.99, supportingEvidenceIds: [ev(1), ev(1), ev(1)] }), false);
    assert.equal(valid({ status: 'proposed', confidence: 0.1, supportingEvidenceIds: [] }), false);
  });

  it('ties each status to the evidence it requires', () => {
    assert.equal(valid({ status: 'supported', supportingEvidenceIds: [], confidence: 0 }), false);
    assert.equal(valid({ status: 'weakened', confidence: 0 }), false);
    assert.equal(valid({ status: 'weakened', confidence: 0.33, contradictingEvidenceIds: [ev(2)] }), true);
    assert.equal(valid({ status: 'rejected', confidence: 0, supportingEvidenceIds: [], contradictingEvidenceIds: [ev(2)] }), true);
    const single = HypothesisSchema.safeParse(hypothesis({ status: 'selected', confidence: 0.5 }));
    assert.equal(single.success, false);
    assert.match(single.error?.message ?? '', /at least 2 distinct supporting evidence items/);
    assert.equal(valid({ status: 'selected', confidence: 0.66, supportingEvidenceIds: [ev(1), ev(2)] }), true);
    assert.equal(
      valid({ status: 'selected', confidence: 0.4, supportingEvidenceIds: [ev(1), ev(2)], contradictingEvidenceIds: [ev(3), ev(4)] }),
      false,
    );
    for (const status of ['confirmed', 'contradicted', 'likely']) {
      assert.equal(HypothesisSchema.safeParse({ ...hypothesis(), status }).success, false, status);
    }
  });

  it('refuses repeated evidence IDs, so one item cannot be counted twice towards selection', () => {
    const repeated = HypothesisSchema.safeParse(hypothesis({ status: 'selected', confidence: 0.5, supportingEvidenceIds: [ev(1), ev(1)] }));
    assert.equal(repeated.success, false);
    assert.match(repeated.error?.message ?? '', /listed more than once/);
    assert.match(repeated.error?.message ?? '', /at least 2 distinct supporting evidence items/);
    assert.equal(valid({ status: 'weakened', confidence: 0, supportingEvidenceIds: [], contradictingEvidenceIds: [ev(2), ev(2)] }), false);
  });

  it('refuses evidence cited as both supporting and contradicting the same hypothesis', () => {
    const both = HypothesisSchema.safeParse(
      hypothesis({ status: 'selected', confidence: 0.6, supportingEvidenceIds: [ev(1), ev(2), ev(3)], contradictingEvidenceIds: [ev(3)] }),
    );
    assert.equal(both.success, false);
    assert.match(both.error?.message ?? '', /cannot both support and contradict/);
  });

  it('requires a selected hypothesis to be strictly more confident than every rival', () => {
    const selected = hypothesis({ status: 'selected', confidence: 0.66, supportingEvidenceIds: [ev(1), ev(2)] });
    assert.equal(checkExclusiveSelection(selected, [selected, hypothesis({ id: 'hyp-2', confidence: 0.5 })]), undefined);
    assert.match(
      checkExclusiveSelection(selected, [selected, hypothesis({ id: 'hyp-2', confidence: 0.66, supportingEvidenceIds: [ev(3), ev(4)] })]) ?? '',
      /not more confident than hyp-2/,
    );
  });
});
