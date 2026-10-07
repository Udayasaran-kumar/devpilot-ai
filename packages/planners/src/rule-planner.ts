import type { Hypothesis, PlannerActionType } from '@devpilot/core';
import { assessHypothesis, chooseHypothesis, proposeHypothesis } from './hypothesis-assessment.js';
import { analyzeInvestigation, definitionQuery, type InvestigationAnalysis } from './investigation-analysis.js';
import { buildPatchProposal } from './patch-proposal.js';
import type { Planner, PlannerContext, PlannerDecision } from './planner.js';

export interface PlannerRule {
  readonly name: string;
  matches(context: PlannerContext): boolean;
  decide(context: PlannerContext): PlannerDecision;
}

const analyses = new WeakMap<PlannerContext, InvestigationAnalysis>();

/** The analysis of a context, computed once per context object. */
function analysisOf(context: PlannerContext): InvestigationAnalysis {
  let analysis = analyses.get(context);
  if (!analysis) {
    analysis = analyzeInvestigation(context);
    analyses.set(context, analysis);
  }
  return analysis;
}

const hasTool = (context: PlannerContext, tool: PlannerActionType) => context.tools.some((item) => item.name === tool);
const selectedHypothesis = (context: PlannerContext) => context.hypotheses.find((item) => item.status === 'selected');

/** Hypotheses for the current candidates, as they would be after assessing the collected evidence. */
function assessedHypotheses(context: PlannerContext): Hypothesis[] {
  return analysisOf(context).candidates.map(assessHypothesis);
}

function changedSince(context: PlannerContext, hypotheses: readonly Hypothesis[]): Hypothesis[] {
  const current = new Map(context.hypotheses.map((item) => [item.id, JSON.stringify(item)]));
  return hypotheses.filter((item) => current.get(item.id) !== JSON.stringify(item));
}

/**
 * The evidence-driven investigation strategy, in order. Each rule reads only
 * the analysis of the context, so the planner is a pure function of what the
 * investigation has observed. Nothing here names a file, symbol, or incident.
 */
export const EVIDENCE_RULES: readonly PlannerRule[] = [
  {
    name: 'reproduce-failure',
    matches: (context) => {
      const analysis = analysisOf(context);
      return analysis.command !== undefined && analysis.reproduction === undefined && hasTool(context, 'run_command');
    },
    decide: (context) => {
      const { command, args } = analysisOf(context).command ?? { command: '', args: [] };
      return {
        type: 'act',
        tool: 'run_command',
        input: { command, args: [...args] },
        rationale: 'Reproduce the reported failure to observe which test fails, where, and with which values.',
        expectedEvidence: 'Command output naming the failing test, its stack location, and actual vs expected values.',
      };
    },
  },
  {
    name: 'read-failing-test',
    matches: (context) => {
      const analysis = analysisOf(context);
      return analysis.failingTest !== undefined && analysis.failingTest.action === undefined && hasTool(context, 'read_file');
    },
    decide: (context) => {
      const failure = analysisOf(context).reproduction?.failure;
      const position = failure?.failurePosition;
      return {
        type: 'act',
        tool: 'read_file',
        input: { path: position?.path ?? '' },
        rationale: `The failing assertion of "${failure?.name}" is raised at ${position?.path}:${position?.line}; read the test to see what it checks and what ran before it.`,
        expectedEvidence: 'Source of the failing test: the failing assertion, earlier assertions, and the other tests.',
      };
    },
  },
  {
    name: 'locate-computation',
    matches: (context) => {
      const analysis = analysisOf(context);
      return (
        analysis.definition !== undefined &&
        analysis.definition.action === undefined &&
        hasTool(context, 'search_code')
      );
    },
    decide: (context) => {
      const assertion = analysisOf(context).failingTest?.assertion;
      return {
        type: 'act',
        tool: 'search_code',
        input: { query: definitionQuery(assertion?.property ?? '') },
        rationale: `The failing assertion checks \`${assertion?.subject}\`; find where \`${assertion?.property}\` is computed.`,
        expectedEvidence: `Search results with the declaration that assigns \`${assertion?.property}\`.`,
      };
    },
  },
  {
    name: 'read-computation',
    matches: (context) => {
      const analysis = analysisOf(context);
      return analysis.computation !== undefined && analysis.computation.action === undefined && hasTool(context, 'read_file');
    },
    decide: (context) => {
      const match = analysisOf(context).definition?.match;
      const location = match?.location.type === 'file' ? match.location : undefined;
      return {
        type: 'act',
        tool: 'read_file',
        input: { path: location?.path ?? '' },
        rationale: `\`${match?.content?.trim()}\` at ${location?.path}:${location?.startLine} computes the failing value; read the file for its inputs, nearby calculations, and constants.`,
        expectedEvidence: 'Source of the enclosing function and module-level constants.',
      };
    },
  },
  {
    name: 'propose-hypotheses',
    matches: (context) => {
      const known = new Set(context.hypotheses.map((item) => item.id));
      return analysisOf(context).candidates.some((candidate) => !known.has(candidate.id));
    },
    decide: (context) => {
      const known = new Set(context.hypotheses.map((item) => item.id));
      return {
        type: 'update_hypotheses',
        hypotheses: analysisOf(context)
          .candidates.filter((candidate) => !known.has(candidate.id))
          .map(proposeHypothesis),
      };
    },
  },
  {
    name: 'assess-hypotheses',
    matches: (context) => selectedHypothesis(context) === undefined && changedSince(context, assessedHypotheses(context)).length > 0,
    decide: (context) => ({ type: 'update_hypotheses', hypotheses: changedSince(context, assessedHypotheses(context)) }),
  },
  {
    name: 'select-hypothesis',
    matches: (context) => selectedHypothesis(context) === undefined && chooseHypothesis(context.hypotheses) !== undefined,
    decide: (context) => {
      const selected = chooseHypothesis(context.hypotheses);
      return selected ? { type: 'update_hypotheses', hypotheses: [selected] } : conclude(context);
    },
  },
  {
    name: 'propose-patch',
    matches: (context) => context.patchProposals.length === 0 && proposalFor(context) !== undefined,
    decide: (context) => {
      const proposal = proposalFor(context);
      return proposal ? { type: 'propose_patch', proposal } : conclude(context);
    },
  },
];

function proposalFor(context: PlannerContext) {
  const selected = selectedHypothesis(context);
  const analysis = analysisOf(context);
  const candidate = analysis.candidates.find((item) => item.id === selected?.id);
  const lines = analysis.computation?.lines;
  const failure = analysis.reproduction?.failure;
  const commandLine = context.signal.command;
  if (!selected || !candidate || !lines || !failure || commandLine === undefined) return undefined;
  return buildPatchProposal(candidate, selected, lines, { commandLine, failingTest: failure.name });
}

/** Why the investigation stops here, stated from the analysis. Never a repair outcome. */
function conclude(context: PlannerContext): PlannerDecision {
  return { type: 'finish', reason: conclusion(context, analysisOf(context)) };
}

function conclusion(context: PlannerContext, analysis: InvestigationAnalysis): string {
  const proposal = context.patchProposals.at(-1);
  if (proposal?.status === 'awaiting_verification') {
    return `Proposal ${proposal.id} for ${proposal.proposal.hypothesisId} passed review and is awaiting verification by the repair workflow.`;
  }
  if (proposal?.status === 'patch_rejected') {
    return `Proposal ${proposal.id} was rejected by review (${proposal.violations.map((item) => item.code).join(', ')}).`;
  }
  if (analysis.commandProblem) return analysis.commandProblem;
  const reproduction = analysis.reproduction;
  if (!reproduction) return 'The run_command tool is not available, so the failure cannot be reproduced.';
  if (reproduction.action.status === 'failed') return `The reproduction command could not run: ${reproduction.action.error}`;
  const location = reproduction.evidence?.location;
  if (location?.type === 'command' && location.exitCode === 0) {
    return `\`${location.command}\` exited 0; the failure did not reproduce.`;
  }
  if (!reproduction.failure) return 'The command output contains no failing test in a format the planner can parse.';
  if (!reproduction.failure.failurePosition) {
    return `"${reproduction.failure.name}" failed, but its output has no stack frame inside the repository.`;
  }
  const test = analysis.failingTest;
  if (!test?.assertion) {
    const position = reproduction.failure.failurePosition;
    return `No supported assertion was found at ${position.path}:${position.line}.`;
  }
  if (analysis.definition?.problem) return analysis.definition.problem;
  if (!analysis.computation?.declaration) return `Could not read how \`${test.assertion.property}\` is computed.`;
  if (analysis.candidates.length === 0) {
    return `No competing hypotheses could be formed from \`${analysis.computation.declaration.text}\`.`;
  }
  const selected = selectedHypothesis(context);
  if (!selected) {
    const best = [...context.hypotheses].sort((a, b) => b.confidence - a.confidence)[0];
    return `No hypothesis is sufficiently supported to select${best ? ` (best: ${best.id}, ${best.status}, confidence ${best.confidence})` : ''}.`;
  }
  return `Hypothesis ${selected.id} is selected, but no patch can be derived from the evidence for it.`;
}

/**
 * Deterministic, evidence-grounded planner. Custom rules, if given, are
 * consulted first; the default strategy is `EVIDENCE_RULES`. It only returns
 * decisions: the engine executes actions through the tool registry, reviews
 * proposals, and the repair workflow alone verifies them.
 */
export class RulePlanner implements Planner {
  readonly name = 'rule';
  readonly #rules: readonly PlannerRule[];

  constructor(rules: readonly PlannerRule[] = EVIDENCE_RULES) {
    this.#rules = rules;
  }

  async next(context: PlannerContext): Promise<PlannerDecision> {
    const rule = this.#rules.find((candidate) => candidate.matches(context));
    if (!rule) {
      return this.#rules === EVIDENCE_RULES
        ? conclude(context)
        : { type: 'finish', reason: 'No planner rule matched the current investigation state.' };
    }
    return rule.decide(context);
  }
}
