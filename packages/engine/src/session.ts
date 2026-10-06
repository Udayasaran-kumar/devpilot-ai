import { z } from 'zod';
import {
  findDanglingEvidenceIds,
  InvestigationEventSchema,
  type Evidence,
  type Hypothesis,
  type InvestigationAction,
  type InvestigationBudget,
  type InvestigationEvent,
  type JsonValue,
  type Signal,
  type TerminalStatus,
} from '@devpilot/core';
import { PlannerDecisionSchema, type Planner, type PlannerContext, type PlannerDecision } from '@devpilot/planners';
import { ToolResultSchema, type ToolRegistry } from '@devpilot/tools';
import { reduceInvestigation, type InvestigationReducer } from './reducer.js';
import { isTerminalStatus, type InvestigationState } from './state.js';

export type InvestigationEventListener = (event: InvestigationEvent) => void;

export interface InvestigationSessionOptions {
  readonly investigationId: string;
  readonly signal: Signal;
  readonly planner: Planner;
  readonly tools: ToolRegistry;
  readonly budget: InvestigationBudget;
  /** Returns the current time in epoch milliseconds. */
  readonly clock: () => number;
  readonly reducer?: InvestigationReducer;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventPayload = DistributiveOmit<InvestigationEvent, 'investigationId' | 'sequence' | 'timestamp'>;
type ActDecision = Extract<PlannerDecision, { type: 'act' }>;
type ToolOutcome =
  | { readonly ok: true; readonly output: JsonValue; readonly evidence: Evidence[] }
  | { readonly ok: false; readonly error: string };

/**
 * A single investigation run. Every state change goes through an event, so the
 * event log is the source of truth and `state` is always `replay(events)`.
 */
export class InvestigationSession {
  readonly id: string;
  readonly #options: InvestigationSessionOptions;
  readonly #reducer: InvestigationReducer;
  readonly #events: InvestigationEvent[] = [];
  readonly #listeners = new Set<InvestigationEventListener>();
  #state: InvestigationState | undefined;
  #run: Promise<InvestigationState> | undefined;

  constructor(options: InvestigationSessionOptions) {
    this.id = options.investigationId;
    this.#options = options;
    this.#reducer = options.reducer ?? reduceInvestigation;
  }

  /** Undefined until `run()` emits `investigation_started`. */
  get state(): InvestigationState | undefined {
    return this.#state;
  }

  get events(): readonly InvestigationEvent[] {
    return [...this.#events];
  }

  subscribe(listener: InvestigationEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Runs the investigation to a terminal state. Repeated calls return the same run. */
  run(): Promise<InvestigationState> {
    this.#run ??= this.#execute();
    return this.#run;
  }

  async #execute(): Promise<InvestigationState> {
    const { signal, budget, clock } = this.#options;
    const startedAtMs = clock();
    let state = this.#emit({ type: 'investigation_started', signal, budget });
    while (!isTerminalStatus(state.status)) {
      state = await this.#step(state, startedAtMs);
    }
    return state;
  }

  async #step(state: InvestigationState, startedAtMs: number): Promise<InvestigationState> {
    const { budget, clock, planner } = this.#options;
    if (state.stepCount >= budget.maxSteps) {
      return this.#complete('step_budget_exhausted', `Step budget of ${budget.maxSteps} exhausted.`);
    }
    if (clock() - startedAtMs >= budget.maxDurationMs) {
      return this.#complete('time_budget_exhausted', `Time budget of ${budget.maxDurationMs}ms exhausted.`);
    }

    let decision: PlannerDecision;
    try {
      decision = PlannerDecisionSchema.parse(await planner.next(this.#plannerContext(state)));
    } catch (error) {
      return this.#complete('failed', `Planner "${planner.name}" failed: ${describeError(error)}`);
    }

    switch (decision.type) {
      case 'act':
        return this.#act(state, decision);
      case 'update_hypotheses':
        return this.#updateHypotheses(state, decision.hypotheses);
      case 'finish':
        return this.#complete('completed', decision.reason);
    }
  }

  async #act(state: InvestigationState, decision: ActDecision): Promise<InvestigationState> {
    const action: InvestigationAction = {
      id: `action-${state.actions.length + 1}`,
      tool: decision.tool,
      input: decision.input,
      rationale: decision.rationale,
      hypothesisIds: decision.hypothesisIds ?? [],
    };
    this.#emit({ type: 'action_planned', action });

    const outcome = await this.#runTool(action);
    return outcome.ok
      ? this.#emit({ type: 'action_completed', actionId: action.id, output: outcome.output, evidence: outcome.evidence })
      : this.#emit({ type: 'action_failed', actionId: action.id, error: outcome.error });
  }

  async #runTool(action: InvestigationAction): Promise<ToolOutcome> {
    const tool = this.#options.tools.get(action.tool);
    if (!tool) {
      return { ok: false, error: `Unknown tool "${action.tool}"` };
    }

    const input = tool.inputSchema.safeParse(action.input);
    if (!input.success) {
      return { ok: false, error: `Invalid input for tool "${tool.name}": ${z.prettifyError(input.error)}` };
    }

    let result: z.infer<typeof ToolResultSchema>;
    try {
      result = ToolResultSchema.parse(
        await tool.run(input.data, {
          investigationId: this.id,
          actionId: action.id,
          now: () => this.#now(),
        }),
      );
    } catch (error) {
      return { ok: false, error: `Tool "${tool.name}" failed: ${describeError(error)}` };
    }
    if (result.status === 'error') {
      return { ok: false, error: result.error };
    }

    const output = tool.outputSchema.safeParse(result.output);
    if (!output.success) {
      return { ok: false, error: `Invalid output from tool "${tool.name}": ${z.prettifyError(output.error)}` };
    }

    return {
      ok: true,
      output: output.data,
      evidence: result.evidence.map((item) => ({ ...item, source: { tool: tool.name, actionId: action.id } })),
    };
  }

  #updateHypotheses(state: InvestigationState, hypotheses: readonly Hypothesis[]): InvestigationState {
    const referenced = hypotheses.flatMap((h) => [...h.supportingEvidenceIds, ...h.contradictingEvidenceIds]);
    const dangling = findDanglingEvidenceIds(referenced, state.evidence);
    if (dangling.length > 0) {
      return this.#complete('failed', `Hypotheses referenced unknown evidence IDs: ${dangling.join(', ')}`);
    }
    return this.#emit({ type: 'hypotheses_updated', hypotheses: [...hypotheses] });
  }

  #complete(status: TerminalStatus, reason: string): InvestigationState {
    return this.#emit({ type: 'investigation_completed', status, reason });
  }

  #emit(payload: EventPayload): InvestigationState {
    const event = InvestigationEventSchema.parse({
      ...payload,
      investigationId: this.id,
      sequence: this.#events.length,
      timestamp: this.#now(),
    });
    const state = this.#reducer(this.#state, event);
    this.#state = state;
    this.#events.push(event);
    for (const listener of this.#listeners) {
      listener(event);
    }
    return state;
  }

  #plannerContext(state: InvestigationState): PlannerContext {
    return {
      investigationId: state.investigationId,
      signal: state.signal,
      stepCount: state.stepCount,
      remainingSteps: state.budget.maxSteps - state.stepCount,
      actions: state.actions,
      evidence: state.evidence,
      hypotheses: state.hypotheses,
      verifications: state.verifications,
      tools: this.#options.tools.describe(),
    };
  }

  #now(): string {
    return new Date(this.#options.clock()).toISOString();
  }
}

function describeError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return z.prettifyError(error);
  }
  return error instanceof Error ? error.message : String(error);
}
