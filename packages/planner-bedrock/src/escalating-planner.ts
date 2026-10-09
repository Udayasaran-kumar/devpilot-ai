import { RulePlanner, type Planner, type PlannerContext, type PlannerDecision } from '@devpilot/planners';
import { planEscalation, type EscalationPlan, type RefusalStage, type SelectionDiagnostic } from './assessment.js';
import { ModelUnavailableError, type EscalationRequest, type ModelClient } from './model-client.js';

export const DEFAULT_MODEL_TIMEOUT_MS = 30_000;
export const MAX_MODEL_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_MODEL_CALLS = 50;
/** Evidence content sent to the model is cut to this many characters per item. */
export const MAX_ESCALATION_CONTENT_LENGTH = 12_000;
/** Plans of investigations that stopped midway are dropped, oldest first, beyond this many. */
const MAX_PENDING_PLANS = 100;

export type FallbackReason =
  | 'latched'
  | 'no_source_evidence'
  | 'call_budget_exhausted'
  | 'model_unavailable'
  | 'model_error'
  | 'timeout'
  | 'invalid_output'
  | 'plan_diverged';

export type EscalationEvent =
  | { readonly type: 'escalated'; readonly investigationId: string; readonly model: string; readonly selectedHypothesisId: string }
  | {
      readonly type: 'fallback';
      readonly investigationId: string;
      readonly reason: FallbackReason;
      /** May quote the model reply; never show it to end users. */
      readonly detail: string;
      /** For `invalid_output`: the check that refused the reply. Safe to log. */
      readonly stage?: RefusalStage;
      /** For a `schema` refusal: bounded `path: code` entries. Safe to log. */
      readonly schemaIssues?: readonly string[];
      /** For an `edit_source_not_cited` or `edit_path_unknown` refusal: whether the selected hypothesis cites a search hit at exactly the edit's path. Safe to log. */
      readonly citedSearchResultAtEditPath?: boolean;
      /** For a selection refusal: supporting and contradicting counts and computed confidence of every hypothesis, in reply order. Safe to log. */
      readonly selectionDiagnostics?: readonly SelectionDiagnostic[];
      /** For a selection refusal: whether the reply proposed an edit. Safe to log. */
      readonly editPresent?: boolean;
    };

type FallbackDiagnostics = Pick<
  Extract<EscalationEvent, { type: 'fallback' }>,
  'stage' | 'schemaIssues' | 'citedSearchResultAtEditPath' | 'selectionDiagnostics' | 'editPresent'
>;

export interface EscalatingPlannerOptions {
  readonly model: ModelClient;
  /** Defaults to the evidence-driven `RulePlanner`. */
  readonly rules?: Planner;
  readonly timeoutMs?: number;
  /** Model calls this planner may make in this process; once spent, escalation is disabled. */
  readonly maxModelCalls?: number;
  /** Diagnostics for the host process. Never shown to end users. */
  readonly onEvent?: (event: EscalationEvent) => void;
}

type FinishDecision = Extract<PlannerDecision, { type: 'finish' }>;

interface PendingPlan {
  readonly plan: EscalationPlan;
  next: number;
}

type CallOutcome =
  | { readonly status: 'reply'; readonly reply: unknown }
  | { readonly status: 'error'; readonly error: unknown }
  | { readonly status: 'timeout' };

/**
 * Rules first, model only when the rules give up. Every rule decision is
 * returned unchanged, except a `finish` made before any hypothesis exists:
 * then the injected model is asked once, and its reply is used only if it
 * passes every check in `planEscalation`. Otherwise the rule's `finish` is
 * returned as if the model had never been asked. The model never chooses
 * actions, sets confidence or status, writes diffs, or reports outcomes; the
 * engine reviews the proposal and only the repair workflow verifies it.
 */
export class EscalatingPlanner implements Planner {
  readonly name = 'rule+model';
  readonly #model: ModelClient;
  readonly #rules: Planner;
  readonly #timeoutMs: number;
  readonly #maxModelCalls: number;
  readonly #onEvent: ((event: EscalationEvent) => void) | undefined;
  readonly #plans = new Map<string, PendingPlan>();
  #modelCalls = 0;
  #latch: FallbackReason | undefined;

  constructor(options: EscalatingPlannerOptions) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_MODEL_TIMEOUT_MS) {
      throw new RangeError(`timeoutMs must be an integer from 1 to ${MAX_MODEL_TIMEOUT_MS}`);
    }
    const maxModelCalls = options.maxModelCalls ?? DEFAULT_MAX_MODEL_CALLS;
    if (!Number.isInteger(maxModelCalls) || maxModelCalls < 0) {
      throw new RangeError('maxModelCalls must be a non-negative integer');
    }
    this.#model = options.model;
    this.#rules = options.rules ?? new RulePlanner();
    this.#timeoutMs = timeoutMs;
    this.#maxModelCalls = maxModelCalls;
    this.#onEvent = options.onEvent;
  }

  get modelCalls(): number {
    return this.#modelCalls;
  }

  /** Why escalation is disabled for the rest of this process, if it is. */
  get latch(): FallbackReason | undefined {
    return this.#latch;
  }

  async next(context: PlannerContext): Promise<PlannerDecision> {
    const pending = this.#plans.get(context.investigationId);
    if (pending) return this.#continue(context, pending);

    const decision = await this.#rules.next(context);
    if (decision.type !== 'finish' || context.hypotheses.length > 0) return decision;
    return this.#escalate(context, decision);
  }

  async #escalate(context: PlannerContext, ruleDecision: FinishDecision): Promise<PlannerDecision> {
    const fallback = (reason: FallbackReason, detail: string, diagnostics: FallbackDiagnostics = {}) => {
      this.#onEvent?.({ type: 'fallback', investigationId: context.investigationId, reason, detail, ...diagnostics });
      return ruleDecision;
    };
    if (this.#latch) return fallback('latched', `Escalation is disabled for this process (${this.#latch}).`);
    if (!context.evidence.some((item) => item.kind === 'source_code' && item.content !== undefined)) {
      return fallback('no_source_evidence', 'No source file has been read, so no edit could be grounded.');
    }
    if (this.#modelCalls >= this.#maxModelCalls) {
      this.#latch = 'call_budget_exhausted';
      return fallback('call_budget_exhausted', `All ${this.#maxModelCalls} model calls for this process are spent.`);
    }

    this.#modelCalls += 1;
    const outcome = await this.#call(escalationRequest(context, ruleDecision.reason));
    if (outcome.status === 'timeout') return fallback('timeout', `The model did not reply within ${this.#timeoutMs}ms.`);
    if (outcome.status === 'error') {
      if (outcome.error instanceof ModelUnavailableError) {
        this.#latch = 'model_unavailable';
        return fallback('model_unavailable', describeError(outcome.error));
      }
      return fallback('model_error', describeError(outcome.error));
    }

    const result = planEscalation(context, outcome.reply);
    if (!result.ok) {
      return fallback('invalid_output', result.reason, {
        stage: result.stage,
        ...(result.schemaIssues ? { schemaIssues: result.schemaIssues } : {}),
        ...(result.citedSearchResultAtEditPath !== undefined ? { citedSearchResultAtEditPath: result.citedSearchResultAtEditPath } : {}),
        ...(result.selectionDiagnostics ? { selectionDiagnostics: result.selectionDiagnostics } : {}),
        ...(result.editPresent !== undefined ? { editPresent: result.editPresent } : {}),
      });
    }
    const [first] = result.plan.decisions;
    if (!first) return fallback('invalid_output', 'The plan is empty.');

    if (this.#plans.size >= MAX_PENDING_PLANS) {
      const oldest = this.#plans.keys().next().value;
      if (oldest !== undefined) this.#plans.delete(oldest);
    }
    this.#plans.set(context.investigationId, { plan: result.plan, next: 1 });
    this.#onEvent?.({
      type: 'escalated',
      investigationId: context.investigationId,
      model: this.#model.name,
      selectedHypothesisId: result.plan.selectedHypothesisId,
    });
    return first;
  }

  /**
   * Returns the plan's next decision while the investigation still holds what
   * the plan has done so far; once the plan is spent, the rules decide again.
   */
  async #continue(context: PlannerContext, pending: PendingPlan): Promise<PlannerDecision> {
    const { plan } = pending;
    const decision = plan.decisions[pending.next];
    if (!decision) {
      this.#plans.delete(context.investigationId);
      return this.#rules.next(context);
    }
    const recorded = new Map(context.hypotheses.map((hypothesis) => [hypothesis.id, hypothesis]));
    const diverged =
      !plan.hypothesisIds.every((id) => recorded.has(id)) ||
      (decision.type === 'propose_patch' && recorded.get(plan.selectedHypothesisId)?.status !== 'selected');
    if (diverged) {
      this.#plans.delete(context.investigationId);
      this.#onEvent?.({
        type: 'fallback',
        investigationId: context.investigationId,
        reason: 'plan_diverged',
        detail: 'The recorded hypotheses no longer match the escalation plan.',
      });
      return { type: 'finish', reason: 'The model-assisted plan no longer matches the recorded hypotheses, so no patch is proposed.' };
    }
    pending.next += 1;
    return decision;
  }

  /** One model call, abandoned (and aborted) at the timeout. Never rejects. */
  async #call(request: EscalationRequest): Promise<CallOutcome> {
    const controller = new AbortController();
    const reply = Promise.resolve()
      .then(() => this.#model.assess(request, { signal: controller.signal }))
      .then(
        (value): CallOutcome => ({ status: 'reply', reply: value }),
        (error: unknown): CallOutcome => ({ status: 'error', error }),
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<CallOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ status: 'timeout' }), this.#timeoutMs);
    });
    try {
      const outcome = await Promise.race([reply, timeout]);
      if (outcome.status === 'timeout') controller.abort();
      return outcome;
    } finally {
      clearTimeout(timer);
    }
  }
}

function escalationRequest(context: PlannerContext, ruleConclusion: string): EscalationRequest {
  const { title, content, command } = context.signal;
  return {
    investigationId: context.investigationId,
    signal: { title, content, ...(command !== undefined ? { command } : {}) },
    ruleConclusion,
    evidence: context.evidence.map((item) => ({
      id: item.id,
      kind: item.kind,
      summary: item.summary,
      location: item.location,
      ...(item.content !== undefined ? { content: item.content.slice(0, MAX_ESCALATION_CONTENT_LENGTH) } : {}),
    })),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
}
