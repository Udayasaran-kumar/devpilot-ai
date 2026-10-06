import { randomUUID } from 'node:crypto';
import { InvestigationBudgetSchema, SignalSchema, type InvestigationBudget, type Signal } from '@devpilot/core';
import type { Planner } from '@devpilot/planners';
import type { ToolRegistry } from '@devpilot/tools';
import type { InvestigationReducer } from './reducer.js';
import { InvestigationSession, type InvestigationEventListener } from './session.js';

export const DEFAULT_INVESTIGATION_BUDGET: InvestigationBudget = {
  maxSteps: 25,
  maxDurationMs: 5 * 60_000,
};

export interface InvestigationEngineOptions {
  readonly planner: Planner;
  readonly tools: ToolRegistry;
  readonly budget?: Partial<InvestigationBudget>;
  /** Returns the current time in epoch milliseconds. Inject a fake clock for deterministic runs. */
  readonly clock?: () => number;
  readonly generateId?: () => string;
  readonly reducer?: InvestigationReducer;
}

export class InvestigationEngine {
  readonly planner: Planner;
  readonly tools: ToolRegistry;
  readonly budget: InvestigationBudget;
  readonly #clock: () => number;
  readonly #generateId: () => string;
  readonly #reducer: InvestigationReducer | undefined;

  constructor(options: InvestigationEngineOptions) {
    this.planner = options.planner;
    this.tools = options.tools;
    this.budget = InvestigationBudgetSchema.parse({ ...DEFAULT_INVESTIGATION_BUDGET, ...options.budget });
    this.#clock = options.clock ?? Date.now;
    this.#generateId = options.generateId ?? (() => `inv-${randomUUID()}`);
    this.#reducer = options.reducer;
  }

  createSession(signal: Signal): InvestigationSession {
    return new InvestigationSession({
      investigationId: this.#generateId(),
      signal: SignalSchema.parse(signal),
      planner: this.planner,
      tools: this.tools,
      budget: this.budget,
      clock: this.#clock,
      ...(this.#reducer ? { reducer: this.#reducer } : {}),
    });
  }

  /** Creates a session, runs it to a terminal state, and returns it. */
  async investigate(signal: Signal, onEvent?: InvestigationEventListener): Promise<InvestigationSession> {
    const session = this.createSession(signal);
    if (onEvent) {
      session.subscribe(onEvent);
    }
    await session.run();
    return session;
  }
}
