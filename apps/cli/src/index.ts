import { InvestigationEngine } from '@devpilot/engine';
import { RulePlanner } from '@devpilot/planners';
import { InMemoryToolRegistry } from '@devpilot/tools';

function main(): void {
  const engine = new InvestigationEngine({
    planner: new RulePlanner(),
    tools: new InMemoryToolRegistry(),
  });

  console.log('DevPilot AI');
  console.log(
    `Investigation engine initialized (planner: ${engine.planner.name}, ` +
      `tools: ${engine.tools.list().length}, ` +
      `step budget: ${engine.budget.maxSteps}, ` +
      `time budget: ${engine.budget.maxDurationMs}ms).`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
