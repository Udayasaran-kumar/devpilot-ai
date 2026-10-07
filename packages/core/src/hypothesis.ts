import { z } from 'zod';
import { IdSchema } from './common.js';
import { EvidenceIdSchema } from './evidence.js';

/**
 * - `proposed`: generated, not yet assessed against evidence.
 * - `supported`: more supporting than contradicting evidence.
 * - `weakened`: contradicting evidence at least balances the support.
 * - `rejected`: a decisive contradiction (for example, a computed value that disagrees with the test).
 * - `selected`: the single hypothesis chosen to drive a patch proposal. Selection is not verification.
 */
export const HypothesisStatusSchema = z.enum(['proposed', 'supported', 'weakened', 'rejected', 'selected']);
export type HypothesisStatus = z.infer<typeof HypothesisStatusSchema>;

/** A hypothesis can be selected only with at least this many distinct supporting evidence items. */
export const MIN_SELECTION_SUPPORT = 2;
/** ...and at least this confidence. */
export const MIN_SELECTION_CONFIDENCE = 0.6;

/**
 * Upper bound on confidence given distinct supporting and contradicting
 * evidence counts: `s / (s + c + 1)`, rounded down to two decimals. It is 0
 * without support and never reaches 1, so no amount of evidence collected by
 * an investigation claims certainty.
 */
export function maxEvidenceConfidence(supporting: number, contradicting: number): number {
  if (supporting <= 0) return 0;
  return Math.floor((supporting / (supporting + Math.max(0, contradicting) + 1)) * 100) / 100;
}

export const HypothesisSchema = z
  .object({
    id: IdSchema,
    statement: z.string().min(1),
    status: HypothesisStatusSchema,
    confidence: z.number().min(0).max(1),
    supportingEvidenceIds: z.array(EvidenceIdSchema),
    contradictingEvidenceIds: z.array(EvidenceIdSchema),
    /** Why the hypothesis is in its current state and what would change it next. */
    nextActionReason: z.string().min(1),
  })
  .superRefine((hypothesis, ctx) => {
    for (const key of ['supportingEvidenceIds', 'contradictingEvidenceIds'] as const) {
      const ids = hypothesis[key];
      const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
      if (repeated.length > 0) {
        ctx.addIssue({ code: 'custom', path: [key], message: `Evidence ${[...new Set(repeated)].join(', ')} is listed more than once` });
      }
    }
    const both = hypothesis.supportingEvidenceIds.filter((id) => hypothesis.contradictingEvidenceIds.includes(id));
    if (both.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['contradictingEvidenceIds'],
        message: `Evidence ${[...new Set(both)].join(', ')} cannot both support and contradict the same hypothesis`,
      });
    }
    const supporting = new Set(hypothesis.supportingEvidenceIds).size;
    const contradicting = new Set(hypothesis.contradictingEvidenceIds).size;
    const bound = maxEvidenceConfidence(supporting, contradicting);
    if (hypothesis.confidence > bound) {
      ctx.addIssue({
        code: 'custom',
        path: ['confidence'],
        message: `Confidence ${hypothesis.confidence} exceeds ${bound}, the most that ${supporting} supporting and ${contradicting} contradicting evidence items allow`,
      });
    }
    const requirement = statusRequirement(hypothesis.status, supporting, contradicting, hypothesis.confidence);
    if (requirement) {
      ctx.addIssue({ code: 'custom', path: ['status'], message: requirement });
    }
  });
export type Hypothesis = z.infer<typeof HypothesisSchema>;

function statusRequirement(
  status: HypothesisStatus,
  supporting: number,
  contradicting: number,
  confidence: number,
): string | undefined {
  switch (status) {
    case 'proposed':
      return undefined;
    case 'supported':
      return supporting > contradicting ? undefined : 'A supported hypothesis needs more supporting than contradicting evidence';
    case 'weakened':
    case 'rejected':
      return contradicting > 0 ? undefined : `A ${status} hypothesis must cite contradicting evidence`;
    case 'selected':
      if (supporting < MIN_SELECTION_SUPPORT) {
        return `A selected hypothesis needs at least ${MIN_SELECTION_SUPPORT} distinct supporting evidence items`;
      }
      if (contradicting >= supporting) return 'A selected hypothesis needs more supporting than contradicting evidence';
      if (confidence < MIN_SELECTION_CONFIDENCE) {
        return `A selected hypothesis needs confidence of at least ${MIN_SELECTION_CONFIDENCE}`;
      }
      return undefined;
  }
}

/**
 * Selection is exclusive: the selected hypothesis must be strictly more
 * confident than every other one. Returns why `selected` is not allowed, or
 * undefined. Schema rules (support count, confidence) are checked separately.
 */
export function checkExclusiveSelection(selected: Hypothesis, all: readonly Hypothesis[]): string | undefined {
  const rival = all.find((other) => other.id !== selected.id && other.confidence >= selected.confidence);
  if (rival) {
    return `Hypothesis ${selected.id} (confidence ${selected.confidence}) is not more confident than ${rival.id} (${rival.confidence})`;
  }
  const otherSelected = all.find((other) => other.id !== selected.id && other.status === 'selected');
  if (otherSelected) {
    return `Hypothesis ${otherSelected.id} is already selected`;
  }
  return undefined;
}
