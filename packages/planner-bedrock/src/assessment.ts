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

/** The check that refused a reply, in the order `planEscalation` applies them. Fixed names that carry no model text. */
export const REFUSAL_STAGES = [
  'schema',
  'duplicate_key',
  'unknown_evidence',
  'invalid_hypothesis',
  'no_supported_hypothesis',
  'below_selection_threshold',
  'no_exclusive_winner',
  'missing_edit',
  'edit_hypothesis_mismatch',
  'edit_unchanged',
  'edit_source_not_cited',
  'edit_path_unknown',
  'edit_line_not_read',
  'original_text_mismatch',
  'invalid_proposal',
] as const;
export type RefusalStage = (typeof REFUSAL_STAGES)[number];

export const MAX_SCHEMA_ISSUES = 5;

/** One hypothesis of a reply, as selection saw it: counts and the confidence they allow, nothing from the reply's text. */
export interface SelectionDiagnostic {
  readonly supportingCount: number;
  readonly contradictingCount: number;
  readonly computedConfidence: number;
}

export type EscalationPlanResult =
  | { readonly ok: true; readonly plan: EscalationPlan }
  | {
      readonly ok: false;
      readonly stage: RefusalStage;
      /** May quote the reply (keys, IDs, paths); for host diagnostics only. */
      readonly reason: string;
      /** For `schema`: up to `MAX_SCHEMA_ISSUES` entries of `path: code`, built only from schema field names, indices, and Zod issue codes. */
      readonly schemaIssues?: readonly string[];
      /** For `edit_source_not_cited` and `edit_path_unknown`: whether the selected hypothesis cites a `search_result` at exactly the edit's path. */
      readonly citedSearchResultAtEditPath?: boolean;
      /** For `no_supported_hypothesis`, `below_selection_threshold`, and `no_exclusive_winner`: every hypothesis, in reply order. */
      readonly selectionDiagnostics?: readonly SelectionDiagnostic[];
      /** For the same refusals: whether the reply proposed an edit. */
      readonly editPresent?: boolean;
    };

/**
 * Validates a model reply against the investigation and, only if every check
 * passes, plans: propose the hypotheses, assess them from the evidence they
 * cite, select one by the schema's rules, and propose a patch rendered here
 * from the evidence. Nothing is returned for a partially valid reply.
 */
export function planEscalation(context: PlannerContext, reply: unknown): EscalationPlanResult {
  const parsed = ModelAssessmentSchema.safeParse(reply);
  if (!parsed.success) {
    return {
      ...refuse('schema', `The model reply does not match the assessment schema: ${z.prettifyError(parsed.error)}`),
      schemaIssues: parsed.error.issues.slice(0, MAX_SCHEMA_ISSUES).map(describeIssue),
    };
  }
  const assessment = parsed.data;

  const keys = assessment.hypotheses.map((draft) => draft.key);
  const repeated = keys.filter((key, index) => keys.indexOf(key) !== index);
  if (repeated.length > 0) return refuse('duplicate_key', `The model reply repeats hypothesis keys: ${unique(repeated).join(', ')}`);

  const known = new Set(context.evidence.map((item) => item.id));
  const cited = assessment.hypotheses.flatMap((draft) => [...draft.supportingEvidenceIds, ...draft.contradictingEvidenceIds]);
  const unknown = unique(cited.filter((id) => !known.has(id)));
  if (unknown.length > 0) return refuse('unknown_evidence', `The model reply cites evidence that was never collected: ${unknown.join(', ')}`);

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
      if (!checked.success) return refuse('invalid_hypothesis', `Hypothesis ${id} is invalid: ${z.prettifyError(checked.error)}`);
    }
    proposed.push(candidates[0] as Hypothesis);
    assessed.push(candidates[1] as Hypothesis);
  }

  const selected = chooseHypothesis(assessed);
  if (!selected) {
    return {
      ...refuse(selectionFailure(assessed), 'No model hypothesis is supported well enough by the cited evidence to be selected.'),
      selectionDiagnostics: assessed.map(selectionDiagnostic),
      editPresent: assessment.edit !== null,
    };
  }

  const { edit } = assessment;
  if (!edit) return refuse('missing_edit', `The model proposed no edit for ${selected.id}.`);
  if (`${MODEL_HYPOTHESIS_PREFIX}${edit.hypothesisKey}` !== selected.id) {
    return refuse('edit_hypothesis_mismatch', `The edit is for ${MODEL_HYPOTHESIS_PREFIX}${edit.hypothesisKey}, but the evidence selects ${selected.id}.`);
  }
  if (edit.replacementText === edit.originalText) return refuse('edit_unchanged', 'The edit does not change the line.');

  const source = sourceEvidence(context.evidence, selected, edit.path);
  if (!source) {
    const stage = context.evidence.some((item) => isSourceAt(item, edit.path)) ? 'edit_source_not_cited' : 'edit_path_unknown';
    return {
      ...refuse(stage, `${JSON.stringify(edit.path)} is not a file read as supporting evidence for ${selected.id}.`),
      citedSearchResultAtEditPath: citesSearchResultAt(context.evidence, selected, edit.path),
    };
  }
  const lines = numberLines(source.content, source.startLine);
  const index = lines.findIndex((line) => line.line === edit.line);
  const original = lines[index];
  if (!original) return refuse('edit_line_not_read', `Line ${edit.line} is not among the lines of ${edit.path} in evidence ${source.evidence.id}.`);
  if (original.text !== edit.originalText) {
    return refuse('original_text_mismatch', `Line ${edit.line} of ${edit.path} in evidence ${source.evidence.id} is not the original text the model quoted.`);
  }

  const proposal = PatchProposalSchema.safeParse(buildProposal(context, selected, edit.path, lines, index, edit.replacementText));
  if (!proposal.success) return refuse('invalid_proposal', `The patch proposal is invalid: ${z.prettifyError(proposal.error)}`);

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
    if (support.has(item.id) && isSourceAt(item, filePath)) {
      return { evidence: item, content: item.content, startLine: item.location.startLine ?? 1 };
    }
  }
  return undefined;
}

type FileSource = Evidence & { readonly content: string; readonly location: Extract<Evidence['location'], { type: 'file' }> };

/** A search hit at exactly this path that the selected hypothesis cites as support; no normalization. */
function citesSearchResultAt(evidence: readonly Evidence[], selected: Hypothesis, filePath: string): boolean {
  const support = new Set(selected.supportingEvidenceIds);
  return evidence.some((item) => support.has(item.id) && item.kind === 'search_result' && item.location.type === 'file' && item.location.path === filePath);
}

/** File content read with read_file at exactly this path; no normalization. */
function isSourceAt(item: Evidence, filePath: string): item is FileSource {
  return item.kind === 'source_code' && item.location.type === 'file' && item.location.path === filePath && item.content !== undefined;
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

function refuse(stage: RefusalStage, reason: string) {
  return { ok: false, stage, reason } as const;
}

/**
 * Why `chooseHypothesis` selected nothing, following its order: no supported
 * hypothesis, the best one below the selection requirements, or a rival at
 * least as confident.
 */
function selectionFailure(assessed: readonly Hypothesis[]): RefusalStage {
  const supported = assessed.filter((item) => item.status === 'supported');
  const best = supported.reduce<Hypothesis | undefined>((top, item) => (top === undefined || item.confidence > top.confidence ? item : top), undefined);
  if (!best) return 'no_supported_hypothesis';
  return HypothesisSchema.safeParse({ ...best, status: 'selected' }).success ? 'no_exclusive_winner' : 'below_selection_threshold';
}

function selectionDiagnostic(hypothesis: Hypothesis): SelectionDiagnostic {
  return {
    supportingCount: new Set(hypothesis.supportingEvidenceIds).size,
    contradictingCount: new Set(hypothesis.contradictingEvidenceIds).size,
    computedConfidence: hypothesis.confidence,
  };
}

/** `path: code`, where only schema field names and array indices are kept from the path; anything else becomes `?`. */
function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.map((part) => (typeof part === 'number' || (typeof part === 'string' && /^[A-Za-z]{1,40}$/.test(part)) ? String(part) : '?')).join('.');
  return `${path || '(root)'}: ${issue.code}`;
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}
