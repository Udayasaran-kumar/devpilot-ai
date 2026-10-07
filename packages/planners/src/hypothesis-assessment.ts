import {
  checkExclusiveSelection,
  HypothesisSchema,
  maxEvidenceConfidence,
  type Hypothesis,
  type HypothesisStatus,
} from '@devpilot/core';
import type { HypothesisCandidate } from './investigation-analysis.js';

/** A freshly generated hypothesis: no evidence assessed yet, so no confidence. */
export function proposeHypothesis(candidate: HypothesisCandidate): Hypothesis {
  return {
    id: candidate.id,
    statement: candidate.statement,
    status: 'proposed',
    confidence: 0,
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    nextActionReason: 'Assess against the reproduction output, the failing test, and the source that computes the value.',
  };
}

/**
 * Status and confidence follow from the findings alone: confidence is the
 * evidence bound `s / (s + c + 1)` over distinct evidence IDs, and the status
 * compares support with contradiction. A decisive contradiction rejects.
 */
export function assessHypothesis(candidate: HypothesisCandidate): Hypothesis {
  const supportingEvidenceIds = unique(candidate.support.flatMap((finding) => finding.evidenceIds));
  const contradictingEvidenceIds = unique(candidate.contradiction.flatMap((finding) => finding.evidenceIds));
  const s = supportingEvidenceIds.length;
  const c = contradictingEvidenceIds.length;
  const decisive = candidate.contradiction.some((finding) => finding.decisive === true);
  const status: HypothesisStatus = decisive ? 'rejected' : s === 0 && c === 0 ? 'proposed' : s > c ? 'supported' : 'weakened';
  return {
    id: candidate.id,
    statement: candidate.statement,
    status,
    confidence: decisive ? 0 : maxEvidenceConfidence(s, c),
    supportingEvidenceIds,
    contradictingEvidenceIds,
    nextActionReason: nextActionReason(status, candidate),
  };
}

/**
 * The assessed hypothesis that may be selected: the most confident supported
 * one, provided it meets the schema's selection rules and no rival is as
 * confident. Undefined when nothing is sufficiently supported.
 */
export function chooseHypothesis(assessed: readonly Hypothesis[]): Hypothesis | undefined {
  const ranked = assessed.filter((item) => item.status === 'supported').sort((a, b) => b.confidence - a.confidence);
  const best = ranked[0];
  if (!best) return undefined;
  const selected: Hypothesis = {
    ...best,
    status: 'selected',
    nextActionReason: 'Selected as the best-supported hypothesis; propose a patch for the repair workflow to verify.',
  };
  if (!HypothesisSchema.safeParse(selected).success) return undefined;
  if (checkExclusiveSelection(selected, assessed.map((item) => (item.id === best.id ? selected : item))) !== undefined) {
    return undefined;
  }
  return selected;
}

function nextActionReason(status: HypothesisStatus, candidate: HypothesisCandidate): string {
  switch (status) {
    case 'proposed':
      return 'No collected evidence bears on this hypothesis yet.';
    case 'supported':
      return candidate.substitution
        ? 'Supported; eligible for selection if no competing hypothesis is as well supported.'
        : 'Supported, but no repair can be derived from the evidence for this kind of hypothesis.';
    case 'weakened':
      return `Weakened by ${candidate.contradiction.length} contradicting finding(s); not pursued while better-supported hypotheses exist.`;
    case 'rejected':
      return 'Rejected: a value computed from the evidence contradicts the failing assertion.';
    case 'selected':
      return 'Selected.';
  }
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}
