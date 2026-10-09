import { z } from 'zod';
import {
  EvidenceIdSchema,
  HypothesisSchema,
  MAX_PROPOSAL_TEXT_LENGTH,
  maxEvidenceConfidence,
  PatchProposalSchema,
  type Evidence,
  type Hypothesis,
  type HypothesisStatus,
  type PatchProposal,
} from '@devpilot/core';
import { analyzeInvestigation, chooseHypothesis, PlannerDecisionSchema, type PlannerContext, type PlannerDecision } from '@devpilot/planners';

export const MAX_MODEL_HYPOTHESES = 5;
export const MAX_CITED_EVIDENCE = 8;
export const MAX_STATEMENT_LENGTH = 300;
export const MAX_LINE_TEXT_LENGTH = 500;
/** Prefix of every hypothesis ID derived from a model reply, so they never collide with rule hypotheses. */
export const MODEL_HYPOTHESIS_PREFIX = 'hyp-model-';

const CONTEXT_LINES = 3;
const SINGLE_LINE = /^[^\r\n]*$/;

const KeySchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Keys must be lowercase letters, digits, and hyphens');
const LineTextSchema = z.string().max(MAX_LINE_TEXT_LENGTH).regex(SINGLE_LINE, 'Must be a single line');

const HypothesisDraftSchema = z.strictObject({
  key: KeySchema,
  statement: z.string().trim().min(1).max(MAX_STATEMENT_LENGTH).regex(SINGLE_LINE, 'Must be a single line'),
  supportingEvidenceIds: z.array(EvidenceIdSchema).max(MAX_CITED_EVIDENCE),
  contradictingEvidenceIds: z.array(EvidenceIdSchema).max(MAX_CITED_EVIDENCE),
});

/** A replacement of one line the model quoted from evidence. Never a diff, a command, or a file write. */
const LineEditSchema = z.strictObject({
  hypothesisKey: KeySchema,
  path: z.string().min(1).max(MAX_LINE_TEXT_LENGTH),
  line: z.number().int().positive(),
  originalText: LineTextSchema,
  replacementText: LineTextSchema,
});

/**
 * Everything a model reply may contain. Strict at every level: status,
 * confidence, IDs, diffs, and commands are not part of the reply, because
 * the planner derives the first three and never accepts the last two.
 */
export const ModelAssessmentSchema = z.strictObject({
  hypotheses: z.array(HypothesisDraftSchema).min(1).max(MAX_MODEL_HYPOTHESES),
  edit: LineEditSchema.nullable(),
});
export type ModelAssessment = z.infer<typeof ModelAssessmentSchema>;

/** The decisions an accepted reply turns into, returned to the engine one per step. */
export interface EscalationPlan {
  readonly decisions: readonly PlannerDecision[];
  readonly hypothesisIds: readonly string[];
  readonly selectedHypothesisId: string;
}

export type EscalationPlanResult =
  | { readonly ok: true; readonly plan: EscalationPlan }
  | { readonly ok: false; readonly reason: string };

/**
 * Validates a model reply against the investigation and, only if every check
 * passes, plans: propose the hypotheses, assess them from the evidence they
 * cite, select one by the schema's rules, and propose a patch rendered here
 * from the evidence. Nothing is returned for a partially valid reply.
 */
export function planEscalation(context: PlannerContext, reply: unknown): EscalationPlanResult {
  const parsed = ModelAssessmentSchema.safeParse(reply);
  if (!parsed.success) return refuse(`The model reply does not match the assessment schema: ${z.prettifyError(parsed.error)}`);
  const assessment = parsed.data;

  const keys = assessment.hypotheses.map((draft) => draft.key);
  const repeated = keys.filter((key, index) => keys.indexOf(key) !== index);
  if (repeated.length > 0) return refuse(`The model reply repeats hypothesis keys: ${unique(repeated).join(', ')}`);

  const known = new Set(context.evidence.map((item) => item.id));
  const cited = assessment.hypotheses.flatMap((draft) => [...draft.supportingEvidenceIds, ...draft.contradictingEvidenceIds]);
  const unknown = unique(cited.filter((id) => !known.has(id)));
  if (unknown.length > 0) return refuse(`The model reply cites evidence that was never collected: ${unknown.join(', ')}`);

  const proposed: Hypothesis[] = [];
  const assessed: Hypothesis[] = [];
  for (const draft of assessment.hypotheses) {
    const id = `${MODEL_HYPOTHESIS_PREFIX}${draft.key}`;
    const candidates = [
      {
        id,
        statement: draft.statement,
        status: 'proposed' as const,
        confidence: 0,
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
        nextActionReason: 'Proposed by the model; assess against the evidence it cites.',
      },
      assess(id, draft),
    ];
    for (const candidate of candidates) {
      const checked = HypothesisSchema.safeParse(candidate);
      if (!checked.success) return refuse(`Hypothesis ${id} is invalid: ${z.prettifyError(checked.error)}`);
    }
    proposed.push(candidates[0] as Hypothesis);
    assessed.push(candidates[1] as Hypothesis);
  }

  const selected = chooseHypothesis(assessed);
  if (!selected) return refuse('No model hypothesis is supported well enough by the cited evidence to be selected.');

  const { edit } = assessment;
  if (!edit) return refuse(`The model proposed no edit for ${selected.id}.`);
  if (`${MODEL_HYPOTHESIS_PREFIX}${edit.hypothesisKey}` !== selected.id) {
    return refuse(`The edit is for ${MODEL_HYPOTHESIS_PREFIX}${edit.hypothesisKey}, but the evidence selects ${selected.id}.`);
  }
  if (edit.replacementText === edit.originalText) return refuse('The edit does not change the line.');

  const source = sourceEvidence(context.evidence, selected, edit.path);
  if (!source) {
    return refuse(`${JSON.stringify(edit.path)} is not a file read as supporting evidence for ${selected.id}.`);
  }
  const lines = numberLines(source.content, source.startLine);
  const index = lines.findIndex((line) => line.line === edit.line);
  const original = lines[index];
  if (!original) return refuse(`Line ${edit.line} is not among the lines of ${edit.path} in evidence ${source.evidence.id}.`);
  if (original.text !== edit.originalText) {
    return refuse(`Line ${edit.line} of ${edit.path} in evidence ${source.evidence.id} is not the original text the model quoted.`);
  }

  const proposal = PatchProposalSchema.safeParse(buildProposal(context, selected, edit.path, lines, index, edit.replacementText));
  if (!proposal.success) return refuse(`The patch proposal is invalid: ${z.prettifyError(proposal.error)}`);

  const decisions: PlannerDecision[] = [
    { type: 'update_hypotheses', hypotheses: proposed },
    { type: 'update_hypotheses', hypotheses: assessed },
    { type: 'update_hypotheses', hypotheses: [selected] },
    { type: 'propose_patch', proposal: proposal.data },
  ];
  return {
    ok: true,
    plan: {
      decisions: decisions.map((decision) => PlannerDecisionSchema.parse(decision)),
      hypothesisIds: proposed.map((hypothesis) => hypothesis.id),
      selectedHypothesisId: selected.id,
    },
  };
}

/** Status and confidence follow from the cited evidence alone, exactly as the schema bounds them. */
function assess(id: string, draft: ModelAssessment['hypotheses'][number]): Hypothesis {
  const supporting = draft.supportingEvidenceIds.length;
  const contradicting = draft.contradictingEvidenceIds.length;
  const status: HypothesisStatus = supporting > contradicting ? 'supported' : contradicting > 0 ? 'weakened' : 'proposed';
  return {
    id,
    statement: draft.statement,
    status,
    confidence: maxEvidenceConfidence(supporting, contradicting),
    supportingEvidenceIds: [...draft.supportingEvidenceIds],
    contradictingEvidenceIds: [...draft.contradictingEvidenceIds],
    nextActionReason:
      status === 'supported'
        ? 'Supported by the evidence the model cites; eligible for selection if no rival is as well supported.'
        : status === 'weakened'
          ? 'Weakened: the evidence the model cites contradicts it at least as much as it supports it.'
          : 'The model cites no evidence for or against it.',
  };
}

interface SourceEvidence {
  readonly evidence: Evidence;
  readonly content: string;
  readonly startLine: number;
}

/** File content the selected hypothesis rests on: read with read_file, cited as support, at exactly this path. */
function sourceEvidence(evidence: readonly Evidence[], selected: Hypothesis, filePath: string): SourceEvidence | undefined {
  const support = new Set(selected.supportingEvidenceIds);
  for (const item of evidence) {
    const { location, content } = item;
    if (support.has(item.id) && item.kind === 'source_code' && location.type === 'file' && location.path === filePath && content !== undefined) {
      return { evidence: item, content, startLine: location.startLine ?? 1 };
    }
  }
  return undefined;
}

interface SourceLine {
  readonly line: number;
  readonly text: string;
}

/** Numbers read_file content, which starts at `startLine`. */
function numberLines(content: string, startLine: number): SourceLine[] {
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.map((text, index) => ({ line: startLine + index, text }));
}

/** A one-line unified diff built from the file content in evidence; the model never supplies diff text. */
function buildProposal(
  context: PlannerContext,
  selected: Hypothesis,
  filePath: string,
  lines: readonly SourceLine[],
  index: number,
  replacement: string,
): PatchProposal {
  const original = lines[index] as SourceLine;
  // Trailing context stops before the last line read, so the hunk never depends on how the file ends.
  const before = lines.slice(Math.max(0, index - CONTEXT_LINES), index);
  const after = lines.slice(index + 1, Math.min(lines.length - 1, index + 1 + CONTEXT_LINES));
  const count = before.length + 1 + after.length;
  const start = before[0]?.line ?? original.line;
  const patch = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${start},${count} +${start},${count} @@`,
    ...before.map((line) => ` ${line.text}`),
    `-${original.text}`,
    `+${replacement}`,
    ...after.map((line) => ` ${line.text}`),
    '',
  ].join('\n');

  const command = context.signal.command;
  const failingTest = analyzeInvestigation(context).reproduction?.failure?.name;
  const expectedOutcome =
    command === undefined
      ? 'If the hypothesis holds, the reproduction command exits 0.'
      : `If the hypothesis holds, \`${command}\` exits 0${failingTest ? ` and "${failingTest}" no longer fails` : ''}.`;
  return {
    hypothesisId: selected.id,
    rationale: selected.statement.slice(0, MAX_PROPOSAL_TEXT_LENGTH),
    patch,
    affectedPaths: [filePath],
    expectedOutcome: expectedOutcome.slice(0, MAX_PROPOSAL_TEXT_LENGTH),
    supportingEvidenceIds: [...selected.supportingEvidenceIds],
    confidence: selected.confidence,
  };
}

function refuse(reason: string): EscalationPlanResult {
  return { ok: false, reason };
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}
