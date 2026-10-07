import type {
  Evidence,
  Hypothesis,
  PatchProposal,
  PatchReviewStatus,
  PatchViolation,
} from '@devpilot/core';
import { parseUnifiedDiff, PatchParseError } from '@devpilot/tools';
import { checkPatchPathPolicy } from './patch-policy.js';

export interface PatchReviewContext {
  readonly hypotheses: readonly Hypothesis[];
  readonly evidence: readonly Evidence[];
}

export interface PatchReview {
  readonly status: PatchReviewStatus;
  readonly violations: readonly PatchViolation[];
}

/**
 * Deterministic review of a proposal before it may reach the repair workflow:
 * the diff must parse with the same parser `apply_patch` uses, every path must
 * pass the safety policy, the proposal must belong to the selected hypothesis
 * and cite that hypothesis's supporting evidence, and it may only touch files
 * that evidence points at. The proposal is judged as given; it is never
 * rewritten to make it pass. Pure, so the reducer can replay it.
 */
export function reviewPatchProposal(proposal: PatchProposal, context: PatchReviewContext): PatchReview {
  const violations: PatchViolation[] = [];

  let diffPaths: string[] | undefined;
  try {
    diffPaths = unique(parseUnifiedDiff(proposal.patch).map((file) => file.path));
  } catch (error) {
    if (!(error instanceof PatchParseError)) throw error;
    violations.push({ code: error.code, message: `The patch does not parse: ${error.message}` });
  }

  const declaredPaths = unique(proposal.affectedPaths);
  if (declaredPaths.length !== proposal.affectedPaths.length) {
    violations.push({ code: 'affected_paths_mismatch', message: 'affectedPaths lists a path more than once' });
  }
  if (diffPaths && !sameMembers(diffPaths, declaredPaths)) {
    violations.push({
      code: 'affected_paths_mismatch',
      message: `affectedPaths [${declaredPaths.join(', ')}] differ from the paths in the diff [${diffPaths.join(', ')}]`,
    });
  }
  const paths = unique([...(diffPaths ?? []), ...declaredPaths]);
  for (const filePath of paths) {
    violations.push(...checkPatchPathPolicy(filePath));
  }

  const hypothesis = context.hypotheses.find((item) => item.id === proposal.hypothesisId);
  if (hypothesis?.status !== 'selected') {
    violations.push({
      code: 'hypothesis_not_selected',
      message: hypothesis
        ? `Hypothesis ${hypothesis.id} is ${hypothesis.status}, not selected`
        : `Hypothesis ${proposal.hypothesisId} does not exist`,
    });
  }

  const known = new Set(context.evidence.map((item) => item.id));
  const cited = unique(proposal.supportingEvidenceIds);
  if (cited.length === 0) {
    violations.push({ code: 'missing_supporting_evidence', message: 'The proposal cites no supporting evidence' });
  }
  const unknown = cited.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    violations.push({ code: 'unknown_evidence', message: `The proposal cites evidence that was never collected: ${unknown.join(', ')}` });
  }

  if (hypothesis?.status === 'selected') {
    const support = new Set(hypothesis.supportingEvidenceIds);
    const unrelated = cited.filter((id) => known.has(id) && !support.has(id));
    if (unrelated.length > 0) {
      violations.push({
        code: 'evidence_not_supporting_hypothesis',
        message: `Evidence ${unrelated.join(', ')} does not support hypothesis ${hypothesis.id}`,
      });
    }
    if (proposal.confidence > hypothesis.confidence) {
      violations.push({
        code: 'confidence_exceeds_hypothesis',
        message: `Proposal confidence ${proposal.confidence} exceeds hypothesis confidence ${hypothesis.confidence}`,
      });
    }
    violations.push(...checkRelevance(paths, hypothesis, context.evidence));
  }

  return { status: violations.length === 0 ? 'awaiting_verification' : 'patch_rejected', violations };
}

/**
 * The files a hypothesis is about are the files its supporting evidence was
 * read from, minus anything the policy refuses (the failing test, typically).
 * A patch may change only those files, and no more of them than there are.
 */
function checkRelevance(paths: readonly string[], hypothesis: Hypothesis, evidence: readonly Evidence[]): PatchViolation[] {
  const support = new Set(hypothesis.supportingEvidenceIds);
  const relevant = new Set<string>();
  for (const item of evidence) {
    if (support.has(item.id) && item.location.type === 'file' && checkPatchPathPolicy(item.location.path).length === 0) {
      relevant.add(item.location.path);
    }
  }

  const violations: PatchViolation[] = [];
  for (const filePath of paths) {
    if (!relevant.has(filePath) && checkPatchPathPolicy(filePath).length === 0) {
      violations.push({
        code: 'unrelated_file',
        path: filePath,
        message: `${filePath} is not a file that the evidence for hypothesis ${hypothesis.id} points at`,
      });
    }
  }
  if (paths.length > relevant.size) {
    violations.push({
      code: 'too_many_files',
      message: `The patch changes ${paths.length} files; hypothesis ${hypothesis.id} is grounded in ${relevant.size}`,
    });
  }
  return violations;
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)].sort();
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
