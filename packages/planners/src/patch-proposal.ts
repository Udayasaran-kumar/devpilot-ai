import { MAX_PROPOSAL_TEXT_LENGTH, type Hypothesis, type PatchProposal } from '@devpilot/core';
import { replaceIdentifier, type SourceLine } from './analysis/source.js';
import type { HypothesisCandidate } from './investigation-analysis.js';

const CONTEXT_LINES = 3;

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
  const substitution = candidate.substitution;
  if (!substitution || hypothesis.id !== candidate.id || hypothesis.status !== 'selected') return undefined;
  const index = lines.findIndex((line) => line.line === substitution.line);
  const original = lines[index];
  if (!original) return undefined;

  const equals = original.text.indexOf('=');
  if (equals === -1) return undefined;
  const replaced = original.text.slice(0, equals) + replaceIdentifier(original.text.slice(equals), substitution.from, substitution.to);
  if (replaced === original.text) return undefined;

  // Trailing context stops before the last line read, so the hunk never depends on how the file ends.
  const before = lines.slice(Math.max(0, index - CONTEXT_LINES), index);
  const after = lines.slice(index + 1, Math.min(lines.length - 1, index + 1 + CONTEXT_LINES));
  const count = before.length + 1 + after.length;
  const start = before[0]?.line ?? original.line;
  const patch = [
    `--- a/${substitution.path}`,
    `+++ b/${substitution.path}`,
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
    affectedPaths: [substitution.path],
    expectedOutcome: `If the hypothesis holds, \`${verification.commandLine}\` exits 0 and "${verification.failingTest}" no longer fails.`,
    supportingEvidenceIds: [...hypothesis.supportingEvidenceIds],
    confidence: hypothesis.confidence,
  };
}
