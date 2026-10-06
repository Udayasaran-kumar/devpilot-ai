import type { Planner, PlannerContext, PlannerDecision } from './planner.js';

export interface PlannerRule {
  readonly name: string;
  matches(context: PlannerContext): boolean;
  decide(context: PlannerContext): PlannerDecision;
}

/**
 * Placeholder planner that applies the first matching rule. It ships with no
 * built-in rules: investigation strategy is supplied by the caller, never
 * hardcoded for a particular incident.
 */
export class RulePlanner implements Planner {
  readonly name = 'rule';
  readonly #rules: readonly PlannerRule[];

  constructor(rules: readonly PlannerRule[] = []) {
    this.#rules = rules;
  }

  async next(context: PlannerContext): Promise<PlannerDecision> {
    const rule = this.#rules.find((candidate) => candidate.matches(context));
    if (!rule) {
      return { type: 'finish', reason: 'No planner rule matched the current investigation state.' };
    }
    return rule.decide(context);
  }
}
