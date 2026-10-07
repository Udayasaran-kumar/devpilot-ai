import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createEvidenceId,
  type Evidence,
  type EvidenceLocation,
  type Hypothesis,
  type PatchProposal,
  type PatchViolationCode,
} from '@devpilot/core';
import { checkPatchPathPolicy, reviewPatchProposal } from '../src/index.js';

const NOW = '2026-01-01T00:00:00.000Z';

function evidence(location: EvidenceLocation, content: string, kind: Evidence['kind'] = 'source_code'): Evidence {
  return {
    id: createEvidenceId({ tool: 'read_file', location, content }),
    kind,
    summary: 'excerpt',
    content,
    location,
    source: { tool: 'read_file', actionId: 'action-1' },
    collectedAt: NOW,
  };
}

const SOURCE = evidence({ type: 'file', path: 'src/pricing.ts', startLine: 1, endLine: 3 }, 'const total = price * qty;');
const TEST = evidence({ type: 'file', path: 'test/pricing.test.ts', startLine: 1, endLine: 2 }, 'assert.equal(total, 10);');
const RUN = evidence({ type: 'command', command: 'npm test', exitCode: 1 }, 'not ok 1 - totals', 'command_output');
const UNRELATED = evidence({ type: 'file', path: 'src/unrelated.ts', startLine: 1, endLine: 1 }, 'export {};');
const ALL_EVIDENCE = [SOURCE, TEST, RUN, UNRELATED];

const SELECTED: Hypothesis = {
  id: 'hyp-total',
  statement: '`total` uses the wrong input',
  status: 'selected',
  confidence: 0.75,
  supportingEvidenceIds: [SOURCE.id, TEST.id, RUN.id],
  contradictingEvidenceIds: [],
  nextActionReason: 'Selected',
};

const diff = (...files: string[]): string =>
  files
    .map((file) => [`--- a/${file}`, `+++ b/${file}`, '@@ -1,1 +1,1 @@', '-old', '+new', ''].join('\n'))
    .join('');

const proposal = (overrides: Partial<PatchProposal> = {}): PatchProposal => ({
  hypothesisId: SELECTED.id,
  rationale: 'Use the right input',
  patch: diff('src/pricing.ts'),
  affectedPaths: ['src/pricing.ts'],
  expectedOutcome: 'npm test exits 0',
  supportingEvidenceIds: [SOURCE.id, TEST.id],
  confidence: 0.75,
  ...overrides,
});

const review = (overrides: Partial<PatchProposal> = {}, hypotheses: Hypothesis[] = [SELECTED]) =>
  reviewPatchProposal(proposal(overrides), { hypotheses, evidence: ALL_EVIDENCE });
const codes = (result: ReturnType<typeof review>) => result.violations.map((violation) => violation.code);
const forPaths = (...paths: string[]) => review({ patch: diff(...paths), affectedPaths: paths });

describe('patch safety policy', () => {
  const refused: [string, string, PatchViolationCode][] = [
    ['G', 'test/pricing.test.ts', 'test_file'],
    ['G', 'src/__tests__/pricing.ts', 'test_file'],
    ['G', 'src/pricing.spec.ts', 'test_file'],
    ['H', 'package.json', 'package_manifest'],
    ['H', 'packages/app/package.json', 'package_manifest'],
    ['H', 'requirements-dev.txt', 'package_manifest'],
    ['I', 'package-lock.json', 'lockfile'],
    ['I', 'yarn.lock', 'lockfile'],
    ['I', 'pnpm-lock.yaml', 'lockfile'],
    ['J', '.github/workflows/ci.yml', 'ci_config'],
    ['J', '.gitlab-ci.yml', 'ci_config'],
    ['J', 'Jenkinsfile', 'ci_config'],
    ['K', '.env', 'credential_file'],
    ['K', 'config/.env.production', 'credential_file'],
    ['K', '.npmrc', 'credential_file'],
    ['K', 'deploy/id_rsa', 'credential_file'],
    ['K', '.aws/config', 'credential_file'],
    ['K', 'config/secrets.json', 'credential_file'],
    ['-', '.git/config', 'protected_path'],
    ['-', '.devpilot/worktrees/x/src/a.ts', 'protected_path'],
    ['-', '../outside.ts', 'outside_repository'],
    ['-', '/etc/passwd', 'outside_repository'],
  ];
  for (const [label, filePath, code] of refused) {
    it(`${label}: refuses ${filePath} as ${code}`, () => {
      assert.ok(
        checkPatchPathPolicy(filePath).some((violation) => violation.code === code),
        JSON.stringify(checkPatchPathPolicy(filePath)),
      );
    });
  }

  it('allows ordinary source files and .env.example', () => {
    for (const filePath of ['src/pricing.ts', 'lib/tax/rates.py', 'src/testing-utils.ts', '.env.example', 'src/config.ts', 'src/make-file.ts']) {
      assert.deepEqual(checkPatchPathPolicy(filePath), [], filePath);
    }
  });

  it('I: refuses configuration that decides what the verification command runs', () => {
    const configs: [string, PatchViolationCode][] = [
      ['jest.config.js', 'test_config'],
      ['packages/app/vitest.config.mts', 'test_config'],
      ['vite.config.ts', 'test_config'],
      ['jest.setup.ts', 'test_config'],
      ['playwright.config.ts', 'test_config'],
      ['karma.conf.js', 'test_config'],
      ['.mocharc.yml', 'test_config'],
      ['.c8rc.json', 'test_config'],
      ['.nycrc', 'test_config'],
      ['babel.config.cjs', 'test_config'],
      ['.babelrc', 'test_config'],
      ['tsconfig.json', 'test_config'],
      ['tsconfig.build.json', 'test_config'],
      ['pytest.ini', 'test_config'],
      ['tox.ini', 'test_config'],
      ['src/conftest.py', 'test_config'],
      ['Makefile', 'test_config'],
      ['justfile', 'test_config'],
      ['Taskfile.yml', 'test_config'],
      ['.nvmrc', 'test_config'],
      ['.yarnrc.yml', 'package_manifest'],
      ['.pnpmfile.cjs', 'package_manifest'],
      ['node_modules/assert/index.js', 'dependency_directory'],
      ['vendor/lib/tax.go', 'dependency_directory'],
      ['.venv/lib/site.py', 'dependency_directory'],
    ];
    for (const [filePath, code] of configs) {
      assert.ok(checkPatchPathPolicy(filePath).some((violation) => violation.code === code), `${filePath}: ${JSON.stringify(checkPatchPathPolicy(filePath))}`);
    }
  });

  it('matches names case-insensitively, since case-insensitive file systems alias them', () => {
    const variants: [string, PatchViolationCode][] = [
      ['Package.JSON', 'package_manifest'],
      ['PACKAGE-LOCK.JSON', 'lockfile'],
      ['Yarn.Lock', 'lockfile'],
      ['.GIT/config', 'protected_path'],
      ['.DevPilot/state', 'protected_path'],
      ['Test/pricing.ts', 'test_file'],
      ['.ENV', 'credential_file'],
      ['.GitHub/workflows/ci.yml', 'ci_config'],
      ['JEST.CONFIG.JS', 'test_config'],
      ['Node_Modules/x/index.js', 'dependency_directory'],
    ];
    for (const [filePath, code] of variants) {
      assert.ok(checkPatchPathPolicy(filePath).some((violation) => violation.code === code), `${filePath}: ${JSON.stringify(checkPatchPathPolicy(filePath))}`);
    }
  });

  it('refuses path normalisation tricks rather than normalising them', () => {
    for (const filePath of ['./src/pricing.ts', 'src//pricing.ts', 'src/./pricing.ts', 'src/../src/pricing.ts', 'src\\pricing.ts', 'src/pricing.ts\u0000', 'C:/src/pricing.ts']) {
      const violations = checkPatchPathPolicy(filePath);
      assert.ok(
        violations.some((violation) => violation.code === 'unsafe_path' || violation.code === 'outside_repository'),
        `${JSON.stringify(filePath)}: ${JSON.stringify(violations)}`,
      );
    }
  });
});

describe('patch proposal review', () => {
  it('accepts a proposal for the selected hypothesis that touches only the file its evidence names', () => {
    assert.deepEqual(review(), { status: 'awaiting_verification', violations: [] });
  });

  it('G-K: rejects proposals that touch tests, manifests, lockfiles, CI, or credentials, with structured reasons', () => {
    const cases: [string, PatchViolationCode][] = [
      ['test/pricing.test.ts', 'test_file'],
      ['package.json', 'package_manifest'],
      ['package-lock.json', 'lockfile'],
      ['.github/workflows/ci.yml', 'ci_config'],
      ['.env', 'credential_file'],
    ];
    for (const [filePath, code] of cases) {
      const result = forPaths('src/pricing.ts', filePath);
      assert.equal(result.status, 'patch_rejected', filePath);
      const violation = result.violations.find((item) => item.code === code);
      assert.equal(violation?.path, filePath);
      assert.match(violation?.message ?? '', /refused/);
    }
  });

  it('L: rejects a source file the selected hypothesis is not grounded in', () => {
    const result = forPaths('src/unrelated.ts');
    assert.equal(result.status, 'patch_rejected');
    assert.deepEqual(codes(result), ['unrelated_file']);
    assert.deepEqual(codes(forPaths('src/pricing.ts', 'src/unrelated.ts')), ['unrelated_file', 'too_many_files']);
  });

  it('M: rejects a proposal without supporting evidence', () => {
    const result = review({ supportingEvidenceIds: [] });
    assert.equal(result.status, 'patch_rejected');
    assert.deepEqual(codes(result), ['missing_supporting_evidence']);
  });

  it('rejects evidence that was never collected or does not support the hypothesis', () => {
    assert.deepEqual(codes(review({ supportingEvidenceIds: ['ev-0000000000000000'] })), ['unknown_evidence']);
    assert.deepEqual(codes(review({ supportingEvidenceIds: [UNRELATED.id] })), ['evidence_not_supporting_hypothesis']);
  });

  it('rejects a proposal whose hypothesis is not selected, or claims more confidence than it', () => {
    assert.deepEqual(codes(review({}, [{ ...SELECTED, status: 'supported' }])), ['hypothesis_not_selected']);
    assert.deepEqual(codes(review({ hypothesisId: 'hyp-missing' })), ['hypothesis_not_selected']);
    assert.deepEqual(codes(review({ confidence: 0.9 })), ['confidence_exceeds_hypothesis']);
  });

  it('validates syntax with the apply_patch parser and never rewrites the patch', () => {
    assert.deepEqual(codes(review({ patch: 'not a diff\n' })), ['invalid_patch']);
    assert.deepEqual(codes(review({ affectedPaths: ['src/other.ts'] })), [
      'affected_paths_mismatch',
      'unrelated_file',
      'too_many_files',
    ]);
    const original = proposal({ patch: diff('src/pricing.ts', 'package.json'), affectedPaths: ['src/pricing.ts', 'package.json'] });
    const snapshot = structuredClone(original);
    reviewPatchProposal(original, { hypotheses: [SELECTED], evidence: ALL_EVIDENCE });
    assert.deepEqual(original, snapshot);
  });

  it('B14: rejects duplicate affected paths instead of de-duplicating them', () => {
    assert.deepEqual(codes(review({ affectedPaths: ['src/pricing.ts', 'src/pricing.ts'] })), ['affected_paths_mismatch']);
  });

  it('B15: rejects diffs and declarations that name a file through a non-canonical path', () => {
    const tricky = review({ patch: diff('./src/pricing.ts'), affectedPaths: ['./src/pricing.ts'] });
    assert.equal(tricky.status, 'patch_rejected');
    assert.ok(codes(tricky).includes('invalid_patch') || codes(tricky).includes('unsafe_path'), codes(tricky).join(','));
    const upper = review({ patch: diff('SRC/Pricing.ts'), affectedPaths: ['SRC/Pricing.ts'] });
    assert.deepEqual(codes(upper), ['unrelated_file'], 'evidence names src/pricing.ts, not a case variant');
  });

  it('B2/C: evidence from another investigation is unknown here, however it was produced', () => {
    const elsewhere = evidence({ type: 'file', path: 'src/pricing.ts', startLine: 1, endLine: 3 }, 'const total = price * qty * 2;');
    const hypothesis = { ...SELECTED, supportingEvidenceIds: [...SELECTED.supportingEvidenceIds, elsewhere.id] };
    assert.deepEqual(codes(review({ supportingEvidenceIds: [elsewhere.id] }, [hypothesis])), ['unknown_evidence']);
  });

  it('B16: scopes a patch to the files its evidence names; a test-file read never makes tests patchable', () => {
    const testOnly = { ...SELECTED, supportingEvidenceIds: [TEST.id, RUN.id], confidence: 0.66 };
    const result = review({ patch: diff('test/pricing.test.ts'), affectedPaths: ['test/pricing.test.ts'], supportingEvidenceIds: [TEST.id], confidence: 0.5 }, [testOnly]);
    assert.deepEqual(codes(result), ['test_file', 'too_many_files']);
  });
});
