import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ClaimSchema,
  createEvidenceId,
  EvidenceLocationSchema,
  EvidenceSchema,
  findDanglingEvidenceIds,
  HypothesisSchema,
  InvestigationActionSchema,
  InvestigationEventSchema,
  ReportSchema,
  SignalSchema,
  VerificationResultSchema,
  type Evidence,
  type Hypothesis,
  type InvestigationEvent,
  type Signal,
} from '../src/index.js';

const NOW = '2026-01-01T00:00:00.000Z';

const signal: Signal = {
  id: 'sig-1',
  kind: 'failing_test',
  title: 'Unit test fails',
  content: 'AssertionError: expected 2 to equal 3',
  repository: { path: '/tmp/repo' },
  command: 'npm test',
  receivedAt: NOW,
};

function makeEvidence(overrides: Partial<Evidence> = {}): Evidence {
  const location = { type: 'file', path: 'src/math.ts', startLine: 10, endLine: 12 } as const;
  return {
    id: createEvidenceId({ tool: 'read_file', location, content: 'return a - b;' }),
    kind: 'source_code',
    summary: 'Function subtracts instead of adding',
    content: 'return a - b;',
    location,
    source: { tool: 'read_file', actionId: 'action-1' },
    collectedAt: NOW,
    ...overrides,
  };
}

describe('core schemas accept valid objects', () => {
  it('accepts a signal', () => {
    assert.deepEqual(SignalSchema.parse(signal), signal);
  });

  it('accepts every evidence location type', () => {
    const locations = [
      { type: 'file', path: 'src/a.ts' },
      { type: 'file', path: 'src/a.ts', startLine: 3, endLine: 3 },
      { type: 'command', command: 'npm test', exitCode: 1 },
      { type: 'signal', signalId: 'sig-1' },
      { type: 'url', url: 'https://example.com/build/42' },
    ];
    for (const location of locations) {
      assert.deepEqual(EvidenceLocationSchema.parse(location), location);
    }
  });

  it('accepts evidence, actions, verifications, and reports', () => {
    const evidence = makeEvidence();
    assert.deepEqual(EvidenceSchema.parse(evidence), evidence);

    const action = {
      id: 'action-1',
      tool: 'read_file',
      input: { path: 'src/math.ts', range: [10, 12] },
      rationale: 'Inspect the function named in the stack trace',
      hypothesisIds: [],
    };
    assert.deepEqual(InvestigationActionSchema.parse(action), action);

    const verification = {
      id: 'ver-1',
      hypothesisId: 'hyp-1',
      status: 'confirmed',
      summary: 'Test fails before fix and passes after',
      command: 'npm test',
      exitCode: 0,
      evidenceIds: [evidence.id],
      completedAt: NOW,
    };
    assert.deepEqual(VerificationResultSchema.parse(verification), verification);

    const report = {
      id: 'rep-1',
      investigationId: 'inv-1',
      signalId: signal.id,
      outcome: 'root_cause_identified',
      summary: 'Addition implemented as subtraction',
      claims: [{ id: 'claim-1', statement: 'add() subtracts its operands', evidenceIds: [evidence.id] }],
      hypotheses: [],
      verifications: [verification],
      createdAt: NOW,
    };
    assert.deepEqual(ReportSchema.parse(report), report);
  });

  it('accepts all four verification statuses', () => {
    for (const status of ['confirmed', 'rejected', 'inconclusive', 'not_run'] as const) {
      const result = VerificationResultSchema.safeParse({
        id: `ver-${status}`,
        status,
        summary: `Verification ${status}`,
        evidenceIds: status === 'confirmed' || status === 'rejected' ? [makeEvidence().id] : [],
      });
      assert.equal(result.success, true, status);
    }
  });
});

describe('invalid evidence is rejected', () => {
  const cases: Array<[string, unknown]> = [
    ['missing location', { ...makeEvidence(), location: undefined }],
    ['missing source', { ...makeEvidence(), source: undefined }],
    ['malformed id', makeEvidence({ id: 'not-an-evidence-id' })],
    ['file location without path', { ...makeEvidence(), location: { type: 'file' } }],
    ['unknown location type', { ...makeEvidence(), location: { type: 'memory', address: '0x0' } }],
    [
      'inverted line range',
      { ...makeEvidence(), location: { type: 'file', path: 'src/a.ts', startLine: 9, endLine: 2 } },
    ],
    ['empty summary', makeEvidence({ summary: '' })],
    ['non-ISO timestamp', makeEvidence({ collectedAt: 'yesterday' })],
  ];

  for (const [name, candidate] of cases) {
    it(`rejects ${name}`, () => {
      assert.equal(EvidenceSchema.safeParse(candidate).success, false);
    });
  }

  it('rejects confirmed or rejected verifications that cite no evidence', () => {
    for (const status of ['confirmed', 'rejected']) {
      const result = VerificationResultSchema.safeParse({ id: 'ver-1', status, summary: 'x', evidenceIds: [] });
      assert.equal(result.success, false, status);
    }
  });

  it('rejects report claims without evidence', () => {
    assert.equal(ClaimSchema.safeParse({ id: 'claim-1', statement: 'Ungrounded', evidenceIds: [] }).success, false);
  });
});

describe('evidence IDs', () => {
  it('are stable for identical observations and differ otherwise', () => {
    const location = { type: 'command', command: 'npm test', exitCode: 1 } as const;
    const a = createEvidenceId({ tool: 'run_command', location, content: 'FAIL' });
    const b = createEvidenceId({ tool: 'run_command', location: { exitCode: 1, command: 'npm test', type: 'command' }, content: 'FAIL' });
    const c = createEvidenceId({ tool: 'run_command', location, content: 'PASS' });
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^ev-[0-9a-f]{16}$/);
  });
});

describe('hypotheses reference evidence IDs', () => {
  const supporting = makeEvidence();
  const contradicting = makeEvidence({
    id: createEvidenceId({ tool: 'run_command', location: { type: 'command', command: 'npm test' }, content: 'ok' }),
    kind: 'test_output',
    location: { type: 'command', command: 'npm test' },
  });

  const hypothesis: Hypothesis = {
    id: 'hyp-1',
    statement: 'add() uses the wrong operator',
    status: 'supported',
    confidence: 0.7,
    supportingEvidenceIds: [supporting.id],
    contradictingEvidenceIds: [contradicting.id],
  };

  it('accepts evidence ID references', () => {
    const parsed = HypothesisSchema.parse(hypothesis);
    assert.deepEqual(parsed.supportingEvidenceIds, [supporting.id]);
    assert.deepEqual(parsed.contradictingEvidenceIds, [contradicting.id]);
  });

  it('rejects malformed evidence references', () => {
    assert.equal(HypothesisSchema.safeParse({ ...hypothesis, supportingEvidenceIds: ['src/math.ts:10'] }).success, false);
  });

  it('detects references to evidence that was never collected', () => {
    const referenced = [...hypothesis.supportingEvidenceIds, ...hypothesis.contradictingEvidenceIds, 'ev-missing'];
    assert.deepEqual(findDanglingEvidenceIds(referenced, [supporting, contradicting]), ['ev-missing']);
    assert.deepEqual(findDanglingEvidenceIds(hypothesis.supportingEvidenceIds, [supporting]), []);
  });
});

describe('investigation events', () => {
  it('survive a JSON round trip', () => {
    const events: InvestigationEvent[] = [
      {
        type: 'investigation_started',
        investigationId: 'inv-1',
        sequence: 0,
        timestamp: NOW,
        signal,
        budget: { maxSteps: 5, maxDurationMs: 1000 },
      },
      {
        type: 'action_completed',
        investigationId: 'inv-1',
        sequence: 1,
        timestamp: NOW,
        actionId: 'action-1',
        output: { matches: 1 },
        evidence: [makeEvidence()],
      },
      {
        type: 'investigation_completed',
        investigationId: 'inv-1',
        sequence: 2,
        timestamp: NOW,
        status: 'completed',
        reason: 'done',
      },
    ];
    for (const event of events) {
      const roundTripped = InvestigationEventSchema.parse(JSON.parse(JSON.stringify(event)));
      assert.deepEqual(roundTripped, event);
    }
  });

  it('rejects unknown event types', () => {
    const result = InvestigationEventSchema.safeParse({
      type: 'something_else',
      investigationId: 'inv-1',
      sequence: 0,
      timestamp: NOW,
    });
    assert.equal(result.success, false);
  });
});
