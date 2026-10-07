import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createEvidenceId,
  type Evidence,
  type EvidenceLocation,
  type Hypothesis,
  type InvestigationEvent,
  type PatchProposal,
} from '@devpilot/core';
import { InvestigationStateError, replayInvestigation } from '../src/index.js';

const NOW = '2026-01-01T00:00:00.000Z';

type Payload = InvestigationEvent extends infer E
  ? E extends unknown
    ? Omit<E, 'investigationId' | 'sequence' | 'timestamp'>
    : never
  : never;

const item = (location: EvidenceLocation, content: string): Evidence => ({
  id: createEvidenceId({ tool: 'read_file', location, content }),
  kind: 'source_code',
  summary: 'excerpt',
  content,
  location,
  source: { tool: 'read_file', actionId: 'action-1' },
  collectedAt: NOW,
});
const SOURCE = item({ type: 'file', path: 'src/a.ts', startLine: 1, endLine: 1 }, 'const x = y;');
const TEST = item({ type: 'file', path: 'test/a.test.ts', startLine: 1, endLine: 1 }, 'assert.equal(x, 1);');

const hypothesis = (id: string, overrides: Partial<Hypothesis> = {}): Hypothesis => ({
  id,
  statement: `${id} explains the failure`,
  status: 'supported',
  confidence: 0.66,
  supportingEvidenceIds: [SOURCE.id, TEST.id],
  contradictingEvidenceIds: [],
  nextActionReason: 'Assessed',
  ...overrides,
});
const SELECTED = hypothesis('hyp-a', { status: 'selected' });

const PROPOSAL: PatchProposal = {
  hypothesisId: 'hyp-a',
  rationale: 'Use the right input',
  patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const x = y;\n+const x = z;\n',
  affectedPaths: ['src/a.ts'],
  expectedOutcome: 'npm test exits 0',
  supportingEvidenceIds: [SOURCE.id],
  confidence: 0.5,
};

const BASE: readonly Payload[] = [
  {
    type: 'investigation_started',
    signal: { id: 'sig-1', kind: 'failing_test', title: 'Failing test', content: 'not ok', receivedAt: NOW },
    budget: { maxSteps: 10, maxDurationMs: 60_000 },
  },
  {
    type: 'action_planned',
    action: { id: 'action-1', tool: 'read_file', input: { path: 'src/a.ts' }, rationale: 'Read', expectedEvidence: 'Source', hypothesisIds: [] },
  },
  { type: 'action_completed', actionId: 'action-1', output: {}, evidence: [SOURCE, TEST] },
  { type: 'hypotheses_updated', hypotheses: [SELECTED, hypothesis('hyp-b', { confidence: 0.33, supportingEvidenceIds: [SOURCE.id] })] },
];
const proposed = (proposal: PatchProposal = PROPOSAL, proposalId = 'proposal-1'): Payload => ({ type: 'patch_proposed', proposalId, proposal });
const accepted = (proposalId = 'proposal-1'): Payload => ({ type: 'patch_reviewed', proposalId, status: 'awaiting_verification', violations: [] });

function replay(payloads: readonly Payload[]) {
  return replayInvestigation(
    payloads.map((payload, sequence) => ({ ...payload, investigationId: 'inv-1', sequence, timestamp: NOW }) as InvestigationEvent),
  );
}

describe('reducer: hypotheses and patch proposals', () => {
  it('records actions with their outcome and resulting evidence', () => {
    const state = replay(BASE);
    assert.deepEqual(state.actions[0]?.status, 'completed');
    assert.deepEqual(state.actions[0]?.resultingEvidenceIds, [SOURCE.id, TEST.id]);
  });

  it('records an accepted proposal as awaiting verification', () => {
    const state = replay([...BASE, proposed(), accepted()]);
    assert.deepEqual(
      state.patchProposals.map((record) => [record.id, record.status]),
      [['proposal-1', 'awaiting_verification']],
    );
  });

  it('refuses a review that does not match a replayed review of the proposal', () => {
    const toTest = { ...PROPOSAL, patch: PROPOSAL.patch.replaceAll('src/a.ts', 'test/a.test.ts'), affectedPaths: ['test/a.test.ts'] };
    assert.throws(() => replay([...BASE, proposed(toTest), accepted()]), /does not match its review/);
    assert.throws(() => replay([...BASE, proposed({ ...PROPOSAL, supportingEvidenceIds: [] }), accepted()]), /does not match its review/);
    assert.throws(
      () =>
        replay([
          ...BASE,
          proposed(),
          { type: 'patch_reviewed', proposalId: 'proposal-1', status: 'patch_rejected', violations: [{ code: 'test_file', message: 'forged' }] },
        ]),
      /does not match its review/,
    );
  });

  it('refuses reviews of unknown proposals and a second open proposal', () => {
    assert.throws(() => replay([...BASE, accepted()]), /awaiting review/);
    assert.throws(() => replay([...BASE, proposed(), proposed(PROPOSAL, 'proposal-2')]), /only one proposal can be open/);
    assert.throws(() => replay([...BASE, proposed(), accepted(), proposed(PROPOSAL, 'proposal-2')]), /awaiting_verification/);
  });

  it('refuses non-exclusive selection, unknown evidence, and hypothesis changes once a proposal awaits verification', () => {
    const rival = hypothesis('hyp-b');
    assert.throws(() => replay([...BASE, { type: 'hypotheses_updated', hypotheses: [rival] }]), InvestigationStateError);
    assert.throws(
      () => replay([...BASE, { type: 'hypotheses_updated', hypotheses: [hypothesis('hyp-c', { supportingEvidenceIds: ['ev-0000000000000000'], confidence: 0.5 })] }]),
      /unknown evidence/,
    );
    assert.throws(
      () => replay([...BASE, proposed(), accepted(), { type: 'hypotheses_updated', hypotheses: [hypothesis('hyp-a')] }]),
      /fixed while proposal proposal-1 awaits verification/,
    );
  });

  const NEW = { ...item({ type: 'file', path: 'src/b.ts', startLine: 1, endLine: 1 }, 'const y = 2;'), source: { tool: 'read_file', actionId: 'action-2' } };
  const readMore = (evidence: Evidence[] = [NEW]): Payload[] => [
    {
      type: 'action_planned',
      action: { id: 'action-2', tool: 'read_file', input: { path: 'src/b.ts' }, rationale: 'Read', expectedEvidence: 'Source', hypothesisIds: [] },
    },
    { type: 'action_completed', actionId: 'action-2', output: {}, evidence },
  ];
  const contradicted = hypothesis('hyp-a', { status: 'weakened', confidence: 0.33, contradictingEvidenceIds: [NEW.id] });

  it('L: an accepted proposal freezes the investigation: no new evidence, hypothesis changes, or proposals', () => {
    const open = [...BASE, proposed(), accepted()];
    assert.throws(() => replay([...open, ...readMore()]), /awaiting_verification; .*not action_planned/);
    assert.throws(() => replay([...open, { type: 'hypotheses_updated', hypotheses: [contradicted] }]), /fixed while proposal proposal-1 awaits verification/);
    const done = replay([...open, { type: 'investigation_completed', status: 'completed', reason: 'done' }]);
    assert.equal(done.patchProposals[0]?.status, 'awaiting_verification');
  });

  it('L: a proposal awaiting review freezes the investigation until it is reviewed', () => {
    assert.throws(() => replay([...BASE, proposed(), ...readMore()]), /patch_proposed; .*not action_planned/);
    assert.throws(() => replay([...BASE, proposed(), { type: 'hypotheses_updated', hypotheses: [contradicted] }]), /fixed while proposal proposal-1 awaits review/);
  });

  it('A/L: a proposal is refused while evidence collected after the last assessment is unassessed', () => {
    assert.throws(() => replay([...BASE, ...readMore(), proposed()]), /Proposal proposal-1 is stale: evidence .* after the hypotheses were last assessed/);
    const reassessed = replay([...BASE, ...readMore(), { type: 'hypotheses_updated', hypotheses: [SELECTED] }, proposed(), accepted()]);
    assert.equal(reassessed.patchProposals[0]?.status, 'awaiting_verification');
  });

  it('A: once contradicting evidence weakens the selected hypothesis, a proposal for it is rejected', () => {
    const state = replay([
      ...BASE,
      ...readMore(),
      { type: 'hypotheses_updated', hypotheses: [contradicted] },
      proposed(),
      { type: 'patch_reviewed', proposalId: 'proposal-1', status: 'patch_rejected', violations: [{ code: 'hypothesis_not_selected', message: 'Hypothesis hyp-a is weakened, not selected' }] },
    ]);
    assert.equal(state.patchProposals[0]?.status, 'patch_rejected');
  });

  it('refuses a proposal while an action is still running', () => {
    const [planned] = readMore();
    assert.ok(planned);
    assert.throws(() => replay([...BASE, planned, proposed()]), /action action-2 is still running/);
  });

  it('A/C: an evidence ID names one observation; it cannot be re-recorded with different content', () => {
    const swapped = { ...SOURCE, content: 'const x = z;', source: { tool: 'read_file', actionId: 'action-2' } };
    assert.throws(() => replay([...BASE, ...readMore([swapped])]), /already recorded with a different observation/);
    const relocated = { ...SOURCE, location: { type: 'file' as const, path: 'src/other.ts', startLine: 1, endLine: 1 }, source: { tool: 'read_file', actionId: 'action-2' } };
    assert.throws(() => replay([...BASE, ...readMore([relocated])]), /different observation/);
    const again = replay([...BASE, ...readMore([{ ...SOURCE, source: { tool: 'read_file', actionId: 'action-2' } }])]);
    assert.equal(again.evidence.find((evidence) => evidence.id === SOURCE.id)?.content, SOURCE.content, 're-reading the same text is fine');
  });

  it('N: replay schema-checks every event, so a raw log cannot assert an impossible hypothesis or proposal', () => {
    const inflated = { ...SELECTED, confidence: 0.99, supportingEvidenceIds: [SOURCE.id] };
    assert.throws(() => replay([...BASE.slice(0, 3), { type: 'hypotheses_updated', hypotheses: [inflated] }]), /Malformed hypotheses_updated/);
    const repeated = { ...SELECTED, supportingEvidenceIds: [SOURCE.id, SOURCE.id] };
    assert.throws(() => replay([...BASE.slice(0, 3), { type: 'hypotheses_updated', hypotheses: [repeated] }]), /Malformed hypotheses_updated/);
    const claimsRepaired = { ...PROPOSAL, status: 'repaired' } as PatchProposal;
    assert.throws(() => replay([...BASE, proposed(claimsRepaired)]), /Malformed patch_proposed/);
  });
});
