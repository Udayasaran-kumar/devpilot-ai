import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  RepairReportSchema,
  type Evidence,
  type GroundedClaim,
  type Hypothesis,
  type RepairReport,
  type RepairResult,
} from '@devpilot/core';
import { analyzeInvestigation, parseTestOutput, type Finding, type PlannerContext } from '@devpilot/planners';
import type { InvestigationState } from './state.js';

/**
 * The logs a report is checked against: the investigation and, if it ran, the
 * repair workflow. Both states must come from the reducer (a live session or
 * `replayInvestigation`); the validator trusts them, not the report.
 */
export interface ReportSources {
  readonly investigation: InvestigationState;
  readonly repair?: { readonly result: RepairResult; readonly state: InvestigationState };
  /** Why the repair workflow did not run, if it did not. */
  readonly notAttemptedReason?: string;
}

export const REPORT_ISSUE_CODES = [
  'schema',
  'unknown_evidence',
  'unknown_action',
  'missing_quote',
  'quote_not_in_evidence',
  'unverified_success_claim',
  'correctness_claim',
  'underived_claim',
  'inconsistent_report',
  'inconsistent_sources',
] as const;
export type ReportIssueCode = (typeof REPORT_ISSUE_CODES)[number];

export interface ReportIssue {
  readonly code: ReportIssueCode;
  readonly message: string;
  readonly claimId?: string;
}

export interface ReportGrounding {
  readonly valid: boolean;
  readonly issues: readonly ReportIssue[];
}

/**
 * Wording that asserts the repair worked. Allowed only in a `verification`
 * claim backed by the repair workflow's confirmed GREEN evidence.
 */
const SUCCESS_LANGUAGE: readonly RegExp[] = [
  /\btests?\b.*\bpass(?:ed|es|ing)?\b/i,
  /\bpass(?:ed|es)?\b.*\btests?\b/i,
  /\b(?:green|repaired|fixed|resolved|succeeded|successful(?:ly)?|works|worked)\b/i,
  /\bverified\b/i,
];

/**
 * Wording that claims more than a passing verification command can show.
 * Never allowed: passing the configured command does not prove a repair correct.
 */
const CORRECTNESS_LANGUAGE: readonly RegExp[] = [
  /\b(?:is|are|was|were)\s+(?:now\s+)?(?:correct|right|proven|guaranteed|safe)\b/i,
  /\b(?:correct|proven|guaranteed)\s+(?:repair|fix|patch|change|solution)\b/i,
  /\b(?:proves?|proven|guarantees?|certainly|definitely|bug[- ]free)\b/i,
  /\broot cause (?:is|was) (?:confirmed|established)\b/i,
];

/** Quoted names and code spans are data, not assertions; they are ignored when scanning wording. */
function wording(statement: string): string {
  return statement.replace(/`[^`]*`/g, '`…`').replace(/"[^"]*"/g, '"…"');
}

/**
 * Checks every claim against the logs: cited evidence and actions must
 * exist, observations and findings must quote text present in a cited
 * evidence item, success wording needs the workflow's confirmed GREEN, and
 * correctness wording is refused outright.
 *
 * A quote only shows that some text exists, not that the statement reads it
 * fairly ("X" quoted under "X is not the cause"). So the report is also
 * re-derived from the logs: every claim must be one the builder derives, none
 * may be omitted, and every structured field must equal its derivation. The
 * report is a projection of the logs, never a second source of truth. The
 * repair log must also belong to the reviewed proposal and the same incident.
 */
export function validateRepairReport(report: RepairReport, sources: ReportSources): ReportGrounding {
  const issues: ReportIssue[] = [];
  const parsed = RepairReportSchema.safeParse(report);
  if (!parsed.success) {
    issues.push({ code: 'schema', message: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
  }

  const evidence = new Map<string, Evidence>();
  for (const item of [...sources.investigation.evidence, ...(sources.repair?.state.evidence ?? [])]) {
    evidence.set(item.id, item);
  }
  const actionIds = new Set(sources.investigation.actions.map((action) => action.id));
  const green = confirmedGreenEvidenceId(sources);

  for (const claim of report.claims) {
    const flag = (code: ReportIssueCode, message: string) => issues.push({ code, message, claimId: claim.id });
    const unknownEvidence = claim.evidenceIds.filter((id) => !evidence.has(id));
    if (unknownEvidence.length > 0) flag('unknown_evidence', `cites evidence that was never collected: ${unknownEvidence.join(', ')}`);
    const unknownActions = claim.actionIds.filter((id) => !actionIds.has(id));
    if (unknownActions.length > 0) flag('unknown_action', `cites actions that never ran: ${unknownActions.join(', ')}`);

    if (claim.kind === 'observation' || claim.kind === 'finding') {
      if (claim.quote === undefined) {
        flag('missing_quote', `${claim.kind} claims must quote the evidence they rest on`);
      } else {
        const quote = claim.quote;
        if (!claim.evidenceIds.some((id) => evidence.get(id)?.content?.includes(quote) === true)) {
          flag('quote_not_in_evidence', `none of the cited evidence contains ${JSON.stringify(quote)}`);
        }
      }
    }

    const text = wording(claim.statement);
    if (CORRECTNESS_LANGUAGE.some((pattern) => pattern.test(text))) {
      flag(
        'correctness_claim',
        'claims of correctness are not supported by a passing command; say "Repair verified against the configured verification command."',
      );
    }
    const claimsSuccess = claim.kind === 'verification' || SUCCESS_LANGUAGE.some((pattern) => pattern.test(text));
    if (claimsSuccess && (claim.kind !== 'verification' || green === undefined || !claim.evidenceIds.includes(green))) {
      flag(
        'unverified_success_claim',
        green === undefined
          ? 'claims success, but the repair workflow has no confirmed GREEN verification'
          : `claims success without being a verification claim that cites the confirmed GREEN evidence ${green}`,
      );
    }
  }

  issues.push(...checkSources(sources), ...checkConsistency(report, sources), ...checkDerivation(report, sources));
  return { valid: issues.length === 0, issues };
}

/** The repair log must be the workflow run of the investigation's accepted proposal, for the same incident. */
function checkSources(sources: ReportSources): ReportIssue[] {
  const { investigation, repair } = sources;
  if (!repair) return [];
  const issues: ReportIssue[] = [];
  const mismatch = (message: string) => issues.push({ code: 'inconsistent_sources', message });
  const { result, state } = repair;
  const run = state.repair;
  const record = investigation.patchProposals.at(-1);

  if (record?.status !== 'awaiting_verification') {
    mismatch('the repair workflow ran, but the investigation has no proposal that passed review');
  }
  if (!run) {
    mismatch('the repair log has no repair_started event');
    return issues;
  }
  if (result.investigationId !== state.investigationId) mismatch('the repair result belongs to a different repair log');
  if (state.investigationId === investigation.investigationId) mismatch('the repair log is the investigation log');
  if (!isDeepStrictEqual(state.signal, investigation.signal)) mismatch('the repair workflow ran for a different incident');
  if (record && run.patchSha256 !== sha256(record.proposal.patch)) {
    mismatch(`the repair workflow applied a patch other than proposal ${record.id}`);
  }
  if (record && (run.hypothesisId !== record.proposal.hypothesisId || result.hypothesisId !== record.proposal.hypothesisId)) {
    mismatch(`the repair workflow ran for a hypothesis other than ${record.proposal.hypothesisId}`);
  }
  if (run.verificationCommand !== investigation.signal.command || result.verificationCommand !== run.verificationCommand) {
    mismatch('the repair workflow verified a command other than the incident command');
  }
  const logStatus = run.phase === 'verified' ? 'repaired' : (run.failure?.status ?? 'error');
  if (result.status !== logStatus) mismatch(`the repair result says ${result.status}, but its log says ${logStatus}`);
  const proofs: [string, string | undefined, string | null][] = [
    ['baseline', run.baselineEvidenceId, result.baselineEvidenceId],
    ['unpatched worktree', run.worktreeEvidenceId, result.worktreeBaselineEvidenceId],
    ['patch', run.patchEvidenceId, result.patchEvidenceId],
    ['final', run.finalEvidenceId, result.finalEvidenceId],
  ];
  for (const [label, logged, reported] of proofs) {
    if (logged !== undefined && logged !== reported) mismatch(`the repair result's ${label} evidence differs from its log`);
  }
  if (run.phase === 'verified' && !isDeepStrictEqual([...result.changedFiles].sort(), [...(run.changedFiles ?? [])].sort())) {
    mismatch('the repair result lists changed files other than its log');
  }
  return issues;
}

/** The report must equal what `buildRepairReport` derives from the same logs, apart from `createdAt`. */
function checkDerivation(report: RepairReport, sources: ReportSources): ReportIssue[] {
  const issues: ReportIssue[] = [];
  const expected = buildRepairReport({ ...sources, createdAt: report.createdAt });
  const claims = Array.isArray(report.claims) ? report.claims : [];
  for (const claim of claims) {
    if (!expected.claims.some((derived) => sameClaim(derived, claim))) {
      issues.push({
        code: 'underived_claim',
        claimId: claim.id,
        message: 'the claim is not one the logs support; claims are derived from the logs, not written freely',
      });
    }
  }
  for (const derived of expected.claims) {
    if (!claims.some((claim) => sameClaim(derived, claim))) {
      issues.push({ code: 'inconsistent_report', message: `the report omits a claim the logs support: ${derived.statement}` });
    }
  }
  for (const key of Object.keys(expected) as (keyof RepairReport)[]) {
    if (key === 'claims' || key === 'createdAt') continue;
    if (!isDeepStrictEqual(normalized(report[key]), normalized(expected[key]))) {
      issues.push({ code: 'inconsistent_report', message: `${key} does not match the logs` });
    }
  }
  return issues;
}

function sameClaim(left: GroundedClaim, right: GroundedClaim): boolean {
  return (
    left.kind === right.kind &&
    left.statement === right.statement &&
    left.quote === right.quote &&
    isDeepStrictEqual(left.evidenceIds, right.evidenceIds) &&
    isDeepStrictEqual(left.actionIds, right.actionIds)
  );
}

/** Plain JSON, so a report that went through serialisation compares equal to a freshly built one. */
function normalized(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The final evidence of a repair the workflow reported `repaired` and whose log reached `verified`. */
function confirmedGreenEvidenceId(sources: ReportSources): string | undefined {
  const repair = sources.repair;
  if (repair?.result.status !== 'repaired' || repair.state.repair?.phase !== 'verified') return undefined;
  const id = repair.state.repair.finalEvidenceId;
  const item = repair.state.evidence.find((candidate) => candidate.id === id);
  const verification = repair.state.verifications.findLast((candidate) => candidate.id === repair.state.repair?.finalVerificationId);
  const green =
    item?.kind === 'command_output' &&
    item.location.type === 'command' &&
    item.location.exitCode === 0 &&
    verification?.status === 'confirmed' &&
    verification.commandOutcome === 'green' &&
    verification.evidenceIds.includes(item.id) &&
    repair.result.finalEvidenceId === id;
  return green ? id : undefined;
}

function checkConsistency(report: RepairReport, sources: ReportSources): ReportIssue[] {
  const issues: ReportIssue[] = [];
  const mismatch = (message: string) => issues.push({ code: 'inconsistent_report', message });
  const { investigation, repair } = sources;

  if (report.investigationId !== investigation.investigationId) mismatch('investigationId does not match the investigation');
  const expectedStatus = repair?.result.status ?? 'not_attempted';
  if (report.repairStatus !== expectedStatus || report.verification.status !== expectedStatus) {
    mismatch(`repair status ${report.repairStatus} does not match the repair workflow result ${expectedStatus}`);
  }
  if (repair && report.verification.finalEvidenceId !== repair.result.finalEvidenceId) {
    mismatch('verification evidence does not match the repair workflow result');
  }
  const selected = investigation.hypotheses.find((item) => item.status === 'selected') ?? null;
  if (JSON.stringify(report.selectedHypothesis) !== JSON.stringify(selected)) {
    mismatch('selectedHypothesis does not match the investigation');
  }
  if (report.confidence > (selected?.confidence ?? 0)) mismatch('report confidence exceeds the selected hypothesis');
  const proposal = investigation.patchProposals.at(-1) ?? null;
  if (JSON.stringify(report.patchProposal) !== JSON.stringify(proposal)) mismatch('patchProposal does not match the investigation');
  return issues;
}

export interface BuildRepairReportInput {
  readonly investigation: InvestigationState;
  readonly repair?: { readonly result: RepairResult; readonly state: InvestigationState };
  /** Why the repair workflow did not run, if it did not. */
  readonly notAttemptedReason?: string;
  readonly createdAt: string;
}

/**
 * Builds the report from the two event-sourced logs. Statements are composed
 * from evidence (quoted) and from the workflow's recorded result; nothing is
 * specific to a repository or incident.
 */
export function buildRepairReport(input: BuildRepairReportInput): RepairReport {
  const { investigation, repair } = input;
  const selected = investigation.hypotheses.find((item) => item.status === 'selected') ?? null;
  const proposal = investigation.patchProposals.at(-1) ?? null;
  const claims: GroundedClaim[] = [];
  const addClaim = (claim: Omit<GroundedClaim, 'id'>) => claims.push({ id: `claim-${claims.length + 1}`, ...claim });
  const producedBy = (evidenceIds: readonly string[]) =>
    investigation.actions.filter((action) => action.resultingEvidenceIds.some((id) => evidenceIds.includes(id))).map((action) => action.id);

  const analysis = analyzeInvestigation(plannerView(investigation));
  const failure = analysis.reproduction?.failure;
  const run = analysis.reproduction?.evidence;
  if (failure && run && run.location.type === 'command') {
    addClaim({
      kind: 'observation',
      statement: `\`${run.location.command}\` exited with code ${run.location.exitCode ?? 'none'} and reported the failing test "${failure.name}".`,
      evidenceIds: [run.id],
      actionIds: producedBy([run.id]),
      quote: failure.resultLine,
    });
  }

  const findingsFor = (hypothesis: Hypothesis | null) => {
    const candidate = analysis.candidates.find((item) => item.id === hypothesis?.id);
    return candidate ? { support: candidate.support, contradiction: candidate.contradiction } : { support: [], contradiction: [] };
  };
  const addFinding = (finding: Finding, prefix: string) =>
    addClaim({
      kind: 'finding',
      statement: `${prefix}${finding.statement}`,
      evidenceIds: [...finding.evidenceIds],
      actionIds: producedBy(finding.evidenceIds),
      quote: finding.quote,
    });
  for (const finding of findingsFor(selected).support) addFinding(finding, `Supports ${selected?.id}: `);
  for (const hypothesis of investigation.hypotheses.filter((item) => item.id !== selected?.id)) {
    for (const finding of findingsFor(hypothesis).contradiction) addFinding(finding, `Contradicts ${hypothesis.id}: `);
  }

  if (proposal && proposal.proposal.supportingEvidenceIds.length > 0) {
    addClaim({
      kind: 'proposal',
      statement: `The planner proposed changing ${proposal.proposal.affectedPaths.join(', ')} for ${proposal.proposal.hypothesisId}; review status: ${proposal.status}.`,
      evidenceIds: [...proposal.proposal.supportingEvidenceIds],
      actionIds: producedBy(proposal.proposal.supportingEvidenceIds),
    });
  }

  if (repair) {
    const { result, state } = repair;
    const expected = state.repair?.expectedFailure[0];
    const redEvidence = [result.baselineEvidenceId, result.worktreeBaselineEvidenceId].filter((id): id is string => id !== null);
    if (expected !== undefined && redEvidence.length > 0 && state.repair && ['worktree_created', 'patch_applied', 'verified'].includes(state.repair.phase)) {
      addClaim({
        kind: 'observation',
        statement: `Before the patch, \`${result.verificationCommand}\` reproduced the expected failure on the original repository and in the unpatched worktree.`,
        evidenceIds: redEvidence,
        actionIds: [],
        quote: expected,
      });
    }
    if (result.patchStatus === 'applied' && result.patchEvidenceId !== null) {
      addClaim({
        kind: 'observation',
        statement: 'The proposed patch was applied, unmodified, in an isolated worktree.',
        evidenceIds: [result.patchEvidenceId],
        actionIds: [],
        quote: 'apply_patch: applied',
      });
    }
    if (result.status === 'repaired' && result.finalEvidenceId !== null) {
      addClaim({
        kind: 'verification',
        statement: `Repair verified against the configured verification command \`${result.verificationCommand}\`: it exited 0 in the patched worktree, and the original repository is unchanged.`,
        evidenceIds: [result.finalEvidenceId],
        actionIds: [],
      });
    }
  }

  const verification = {
    command: repair?.result.verificationCommand ?? investigation.signal.command ?? null,
    status: repair?.result.status ?? ('not_attempted' as const),
    reason: repair ? repair.result.reason : (input.notAttemptedReason ?? investigation.terminalReason ?? null),
    baselineEvidenceId: repair?.result.baselineEvidenceId ?? null,
    worktreeBaselineEvidenceId: repair?.result.worktreeBaselineEvidenceId ?? null,
    finalEvidenceId: repair?.result.finalEvidenceId ?? null,
  };

  return {
    id: `report-${investigation.investigationId}`,
    investigationId: investigation.investigationId,
    repairInvestigationId: repair?.result.investigationId ?? null,
    signalId: investigation.signal.id,
    incident: { title: investigation.signal.title, kind: investigation.signal.kind, command: investigation.signal.command ?? null },
    selectedHypothesis: selected,
    confidence: selected?.confidence ?? 0,
    hypotheses: [...investigation.hypotheses],
    supportingEvidenceIds: [...(selected?.supportingEvidenceIds ?? [])],
    contradictingEvidenceIds: [...new Set(investigation.hypotheses.filter((item) => item.id !== selected?.id).flatMap((item) => item.contradictingEvidenceIds))],
    investigationActions: [...investigation.actions],
    patchProposal: proposal,
    affectedFiles: repair?.result.changedFiles.length ? [...repair.result.changedFiles] : [...(proposal?.proposal.affectedPaths ?? [])],
    verification,
    repairStatus: verification.status,
    claims,
    limitations: limitations(input, selected, failure?.name),
    createdAt: input.createdAt,
  };
}

function limitations(input: BuildRepairReportInput, selected: Hypothesis | null, failingTest: string | undefined): string[] {
  const { repair } = input;
  const notes = [
    'Confidence is an evidence-count bound, s / (s + c + 1) over distinct supporting and contradicting evidence items; it is not a probability.',
    'Hypotheses come from the failing assertion and the declaration that computes the asserted value; causes outside that computation are not considered.',
    'Findings restate the rule-based analysis of the quoted evidence; the grounding validator accepts only claims it re-derives from the logs, so it checks that the analysis is reproducible, not that it is right.',
  ];
  if (!selected) notes.push('No hypothesis was sufficiently supported to select, so no repair was proposed.');
  if (!repair) {
    notes.push(`The repair workflow did not run${input.notAttemptedReason ? `: ${input.notAttemptedReason}` : '.'}`);
    return notes;
  }
  notes.push(
    `Verification covers only \`${repair.result.verificationCommand}\`; behaviour that command does not exercise is unverified.`,
  );
  if (repair.result.status !== 'repaired') notes.push(`The repair was not verified (${repair.result.status}).`);
  if (repair.result.status === 'repaired' && failingTest !== undefined) {
    const green = repair.state.evidence.find((item) => item.id === repair.result.finalEvidenceId)?.content ?? '';
    if (!parseTestOutput(green).passed.some((test) => test.name === failingTest)) {
      notes.push(
        `The GREEN output does not report the previously failing test "${failingTest}" as passing; only the exit code of \`${repair.result.verificationCommand}\` was verified, and a change that stops tests from running would also exit 0.`,
      );
    }
  }
  if (repair.result.worktreeRetained && repair.result.worktree) {
    notes.push(`The patch exists only in worktree ${repair.result.worktree}; it is not committed, merged, or applied to the original checkout.`);
  }
  return notes;
}

/** The planner's view of a finished investigation, used to re-derive its findings deterministically. */
function plannerView(state: InvestigationState): PlannerContext {
  return {
    investigationId: state.investigationId,
    signal: state.signal,
    stepCount: state.stepCount,
    remainingSteps: state.budget.maxSteps - state.stepCount,
    actions: state.actions,
    evidence: state.evidence,
    hypotheses: state.hypotheses,
    verifications: state.verifications,
    patchProposals: state.patchProposals,
    tools: [],
  };
}
