import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Hypothesis } from '@devpilot/core';
import { buildPatchProposal } from '../src/index.js';
import type { HypothesisCandidate, OperatorSubstitution } from '../src/investigation-analysis.js';
import type { SourceLine } from '../src/analysis/source.js';

const selected: Hypothesis = {
  id: 'hyp-boundary',
  statement: 'The comparison excludes the threshold',
  status: 'selected',
  confidence: 0.75,
  supportingEvidenceIds: [],
  contradictingEvidenceIds: [],
  nextActionReason: 'Selected',
};

const candidate: HypothesisCandidate = {
  id: 'hyp-boundary',
  kind: 'wrong_constant',
  statement: 'The comparison excludes the threshold',
  support: [],
  contradiction: [],
};

const lines: SourceLine[] = [
  { line: 1, text: 'export function shipping(subtotal: number) {' },
  { line: 2, text: '  return subtotal > freeThreshold ? 0 : flatRate;' },
  { line: 3, text: '}' },
];

const verification = {
  commandLine: 'npm test',
  failingTest: 'ships free exactly at the threshold',
};

const BOUNDARY: OperatorSubstitution = { path: 'src/shipping.ts', line: 2, from: '>', to: '>=' };

const withOperator = (operatorSubstitution: OperatorSubstitution): HypothesisCandidate => ({ ...candidate, operatorSubstitution });

/** Lines 1 and 3 of the fixture around `text` as line 2. */
const around = (text: string): SourceLine[] => [lines[0]!, { line: 2, text }, lines[2]!];

describe('patch proposal generation', () => {
  it('refuses a candidate without a supported repair operation', () => {
    assert.equal(
      buildPatchProposal(candidate, selected, lines, verification),
      undefined,
    );
  });

  it('refuses an unselected hypothesis', () => {
    assert.equal(
      buildPatchProposal(candidate, { ...selected, status: 'supported' }, lines, verification),
      undefined,
    );
  });

  it('generates a diff for an explicit operator substitution', () => {
    const operatorCandidate: HypothesisCandidate = {
      ...candidate,
      operatorSubstitution: {
        path: 'src/shipping.ts',
        line: 2,
        from: '>',
        to: '>=',
      },
    };

    const proposal = buildPatchProposal(
      operatorCandidate,
      selected,
      lines,
      verification,
    );

    assert.ok(proposal);
    assert.match(proposal.patch, /-  return subtotal > freeThreshold \? 0 : flatRate;/);
    assert.match(proposal.patch, /\+  return subtotal >= freeThreshold \? 0 : flatRate;/);
    assert.deepEqual(proposal.affectedPaths, ['src/shipping.ts']);
  });

  it('refuses an operator substitution when the source operator does not match', () => {
    const operatorCandidate: HypothesisCandidate = {
      ...candidate,
      operatorSubstitution: {
        path: 'src/shipping.ts',
        line: 2,
        from: '>',
        to: '>=',
      },
    };

    const changedLines = [
      lines[0]!,
      { line: 2, text: '  return subtotal < freeThreshold ? 0 : flatRate;' },
      lines[2]!,
    ];

    assert.equal(
      buildPatchProposal(operatorCandidate, selected, changedLines, verification),
      undefined,
    );
  });

  it('refuses unsupported operator substitutions', () => {
    const operatorCandidate: HypothesisCandidate = {
      ...candidate,
      operatorSubstitution: {
        path: 'src/shipping.ts',
        line: 2,
        from: '>',
        to: '===',
      },
    };

    assert.equal(
      buildPatchProposal(operatorCandidate, selected, lines, verification),
      undefined,
    );
  });

  describe('operator substitutions', () => {
    it('build the same unified diff and proposal as any one-line substitution, and only propose', () => {
      const before = structuredClone(lines);
      const proposal = buildPatchProposal(withOperator(BOUNDARY), { ...selected, supportingEvidenceIds: ['ev-src', 'ev-run'] }, lines, verification);
      assert.deepEqual(proposal, {
        hypothesisId: 'hyp-boundary',
        rationale: 'The comparison excludes the threshold ',
        patch: [
          '--- a/src/shipping.ts',
          '+++ b/src/shipping.ts',
          '@@ -1,2 +1,2 @@',
          ' export function shipping(subtotal: number) {',
          '-  return subtotal > freeThreshold ? 0 : flatRate;',
          '+  return subtotal >= freeThreshold ? 0 : flatRate;',
          '',
        ].join('\n'),
        affectedPaths: ['src/shipping.ts'],
        expectedOutcome: 'If the hypothesis holds, `npm test` exits 0 and "ships free exactly at the threshold" no longer fails.',
        supportingEvidenceIds: ['ev-src', 'ev-run'],
        confidence: 0.75,
      });
      assert.deepEqual(lines, before, 'the source lines are not changed');
    });

    it('replace only the operator itself, never one inside a string or a comment, an arrow, or an assignment', () => {
      const cases: Array<[string, OperatorSubstitution, string, string]> = [
        [
          'in a string and a comment',
          BOUNDARY,
          "  return subtotal > freeThreshold ? '>' : \"a > b\"; // > threshold",
          "  return subtotal >= freeThreshold ? '>' : \"a > b\"; // > threshold",
        ],
        ['after an arrow', BOUNDARY, '  const free = (subtotal) => subtotal > freeThreshold;', '  const free = (subtotal) => subtotal >= freeThreshold;'],
        ['beside an assignment', { ...BOUNDARY, from: '===', to: '!==' }, '  let free = subtotal === freeThreshold;', '  let free = subtotal !== freeThreshold;'],
        ['in a block comment before it', { ...BOUNDARY, from: '<=', to: '<' }, '  /* a <= b */ if (count <= limit) {', '  /* a <= b */ if (count < limit) {'],
      ];
      for (const [name, substitution, text, expected] of cases) {
        const proposal = buildPatchProposal(withOperator(substitution), selected, around(text), verification);
        assert.ok(proposal, name);
        assert.ok(proposal.patch.includes(`\n-${text}\n+${expected}\n`), name);
      }
    });

    it('refuse a line where the operator is ambiguous, absent as a whole token, or not a binary comparison', () => {
      const cases: Array<[string, OperatorSubstitution, string]> = [
        ['two comparisons', BOUNDARY, '  return a > b && c > d ? 0 : 1;'],
        ['a generic beside the comparison', BOUNDARY, '  const free: Array<number> = subtotal > freeThreshold ? [] : [flatRate];'],
        ['only a generic', { ...BOUNDARY, from: '<', to: '<=' }, '  const amounts: Array<number> = [];'],
        ['only a longer operator', BOUNDARY, '  return subtotal >= freeThreshold ? 0 : flatRate;'],
        ['only an arrow', BOUNDARY, '  const free = () => 0;'],
        ['only inside a string', BOUNDARY, "  const label = 'a > b';"],
        ['only inside a comment', BOUNDARY, '  return 0; // a > b'],
        ['no spacing', BOUNDARY, '  return subtotal>freeThreshold ? 0 : flatRate;'],
        ['no operand after it', BOUNDARY, '  return subtotal > ;'],
      ];
      for (const [name, substitution, text] of cases) {
        assert.equal(buildPatchProposal(withOperator(substitution), selected, around(text), verification), undefined, name);
      }
    });

    it('refuse a line that cannot be read on its own', () => {
      const cases: Array<[string, string]> = [
        ['a template literal', '  return `${subtotal > freeThreshold}`;'],
        ['a regular expression', '  return /a>b/.test(name) && subtotal > freeThreshold;'],
        ['a division', '  return subtotal / 2 > freeThreshold;'],
        ['a block-comment continuation', ' * subtotal > freeThreshold'],
        ['an unterminated block comment', '  /* subtotal > freeThreshold'],
        ['an unterminated string', "  return 'subtotal > freeThreshold;"],
      ];
      for (const [name, text] of cases) {
        assert.equal(buildPatchProposal(withOperator(BOUNDARY), selected, around(text), verification), undefined, name);
      }
    });

    it('refuse a missing line, an invalid path, or an operator change outside its family', () => {
      const refused: Array<[string, OperatorSubstitution]> = [
        ['a line that was not read', { ...BOUNDARY, line: 9 }],
        ['a line number that is not a positive integer', { ...BOUNDARY, line: 1.5 }],
        ['an absolute path', { ...BOUNDARY, path: '/src/shipping.ts' }],
        ['a parent path', { ...BOUNDARY, path: '../src/shipping.ts' }],
        ['a "./" path', { ...BOUNDARY, path: './src/shipping.ts' }],
        ['a backslash path', { ...BOUNDARY, path: 'src\\shipping.ts' }],
        ['an empty path', { ...BOUNDARY, path: '' }],
        ['the same operator', { ...BOUNDARY, to: '>' }],
        ['equality for ordering', { ...BOUNDARY, to: '!==' }],
      ];
      for (const [name, substitution] of refused) {
        assert.equal(buildPatchProposal(withOperator(substitution), selected, lines, verification), undefined, name);
      }
    });

    it('refuse operators outside the typed set when a substitution arrives untyped', () => {
      for (const [from, to] of [['>>', '>>='], ['==', '!='], ['=', '>='], ['>', '=>']]) {
        const untyped = { ...BOUNDARY, from, to } as unknown as OperatorSubstitution;
        assert.equal(buildPatchProposal(withOperator(untyped), selected, around('  return a >> b == c = d > e;'), verification), undefined, `${from} -> ${to}`);
      }
    });

    it('refuse a candidate that is not the selected hypothesis, or that carries both repair operations', () => {
      assert.equal(buildPatchProposal({ ...withOperator(BOUNDARY), id: 'hyp-other' }, selected, lines, verification), undefined);
      assert.equal(buildPatchProposal(withOperator(BOUNDARY), { ...selected, status: 'supported' }, lines, verification), undefined);
      const both: HypothesisCandidate = {
        ...withOperator(BOUNDARY),
        substitution: { path: 'src/shipping.ts', line: 2, from: 'freeThreshold', to: 'limit' },
      };
      assert.equal(buildPatchProposal(both, selected, lines, verification), undefined);
    });
  });
});
