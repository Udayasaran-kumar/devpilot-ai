import { MAX_PROPOSAL_TEXT_LENGTH, type Hypothesis, type PatchProposal } from '@devpilot/core';
import { replaceBinaryOperator, replaceIdentifier, type SourceLine } from './analysis/source.js';
import type { HypothesisCandidate, OperatorSubstitution } from './investigation-analysis.js';

const CONTEXT_LINES = 3;

/** An operator may only be replaced by another of its own family: an ordering comparison by an ordering comparison, strict equality by strict inequality. */
const OPERATOR_FAMILIES: readonly (readonly OperatorSubstitution['from'][])[] = [
  ['>', '>=', '<', '<='],
  ['===', '!=='],
];

interface LineEdit {
  readonly path: string;
  /** Position in `lines` of the line replaced. */
  readonly index: number;
  readonly replaced: string;
}

/**
 * Turns the selected hypothesis's substitution into a one-line unified diff
 * built from the file content in evidence. It never touches the file; the
 * repair workflow applies and verifies it in an isolated worktree.
 */
export function buildPatchProposal(
  candidate: HypothesisCandidate,
  hypothesis: Hypothesis,
  lines: readonly SourceLine[],
  verification: { readonly commandLine: string; readonly failingTest: string },
): PatchProposal | undefined {
  if (hypothesis.id !== candidate.id || hypothesis.status !== 'selected') return undefined;
  const edit = lineEdit(candidate, lines);
  const original = edit ? lines[edit.index] : undefined;
  if (!edit || !original || edit.replaced === original.text) return undefined;
  const { index, path, replaced } = edit;

  // Trailing context stops before the last line read, so the hunk never depends on how the file ends.
  const before = lines.slice(Math.max(0, index - CONTEXT_LINES), index);
  const after = lines.slice(index + 1, Math.min(lines.length - 1, index + 1 + CONTEXT_LINES));
  const count = before.length + 1 + after.length;
  const start = before[0]?.line ?? original.line;
  const patch = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${start},${count} +${start},${count} @@`,
    ...before.map((line) => ` ${line.text}`),
    `-${original.text}`,
    `+${replaced}`,
    ...after.map((line) => ` ${line.text}`),
    '',
  ].join('\n');

  return {
    hypothesisId: hypothesis.id,
    rationale: `${hypothesis.statement} ${candidate.support.map((finding) => finding.statement).join(' ')}`.slice(
      0,
      MAX_PROPOSAL_TEXT_LENGTH,
    ),
    patch,
    affectedPaths: [path],
    expectedOutcome: `If the hypothesis holds, \`${verification.commandLine}\` exits 0 and "${verification.failingTest}" no longer fails.`,
    supportingEvidenceIds: [...hypothesis.supportingEvidenceIds],
    confidence: hypothesis.confidence,
  };
}

/** The one line a candidate's repair operation changes; a candidate with both operations is ambiguous. */
function lineEdit(candidate: HypothesisCandidate, lines: readonly SourceLine[]): LineEdit | undefined {
  const { substitution, operatorSubstitution } = candidate;
  if (substitution && operatorSubstitution) return undefined;

  if (substitution) {
    const index = lines.findIndex((line) => line.line === substitution.line);
    const original = lines[index];
    if (!original) return undefined;
    const equals = original.text.indexOf('=');
    if (equals === -1) return undefined;
    const replaced = original.text.slice(0, equals) + replaceIdentifier(original.text.slice(equals), substitution.from, substitution.to);
    return { path: substitution.path, index, replaced };
  }

  if (operatorSubstitution) {
    const { path, line, from, to } = operatorSubstitution;
    if (!isSupportedOperatorChange(from, to) || !isRepositoryPath(path) || !Number.isInteger(line) || line < 1) return undefined;
    const index = lines.findIndex((item) => item.line === line);
    const original = lines[index];
    if (!original) return undefined;
    const replaced = replaceBinaryOperator(original.text, from, to);
    return replaced === undefined ? undefined : { path, index, replaced };
  }

  return undefined;
}

function isSupportedOperatorChange(from: OperatorSubstitution['from'], to: OperatorSubstitution['to']): boolean {
  return from !== to && OPERATOR_FAMILIES.some((family) => family.includes(from) && family.includes(to));
}

/** A repository-relative path written plainly: no leading `/`, `./`, or `..`, no empty segment, no backslash. */
function isRepositoryPath(path: string): boolean {
  return path.length > 0 && !path.includes('\\') && !path.includes('\0') && path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}
