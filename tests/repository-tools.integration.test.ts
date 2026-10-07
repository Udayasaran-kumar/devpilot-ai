import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import type { Signal } from '@devpilot/core';
import { InvestigationEngine, replayInvestigation } from '@devpilot/engine';
import { RulePlanner, type PlannerRule } from '@devpilot/planners';
import { createDefaultToolRegistry, RepositorySandbox } from '@devpilot/tools';

const FIXTURE_ROOT = fileURLToPath(new URL('../fixtures/sample-repository', import.meta.url));

const signal: Signal = {
  id: 'sig-repo-tools',
  kind: 'bug_report',
  title: 'Observation pipeline smoke test',
  content: 'Caller-provided query: applyDiscount',
  repository: { path: FIXTURE_ROOT },
  receivedAt: '2026-01-01T00:00:00.000Z',
};

const QUERY = 'applyDiscount';

const rules: PlannerRule[] = [
  {
    name: 'list',
    matches: (context) => context.actions.length === 0,
    decide: () => ({ type: 'act', tool: 'list_files', input: { path: 'src' }, rationale: 'Survey the source tree', expectedEvidence: 'File list' }),
  },
  {
    name: 'search',
    matches: (context) => context.actions.length === 1,
    decide: () => ({ type: 'act', tool: 'search_code', input: { query: QUERY }, rationale: 'Locate the caller query', expectedEvidence: 'Search hits' }),
  },
  {
    name: 'read-first-hit',
    matches: (context) => context.actions.length === 2,
    decide: (context) => {
      const hit = context.evidence.find((item) => item.kind === 'search_result');
      if (!hit || hit.location.type !== 'file') {
        return { type: 'finish', reason: 'No search hits to read' };
      }
      return {
        type: 'act',
        tool: 'read_file',
        input: { path: hit.location.path, startLine: hit.location.startLine ?? 1 },
        rationale: 'Read the code around the first hit',
        expectedEvidence: 'Source around the hit',
      };
    },
  },
];

describe('repository tools through the engine', () => {
  it('turns repository reads into stamped, replayable evidence', async () => {
    let tick = Date.parse(signal.receivedAt);
    const engine = new InvestigationEngine({
      planner: new RulePlanner(rules),
      tools: createDefaultToolRegistry(await RepositorySandbox.create(FIXTURE_ROOT)),
      clock: () => (tick += 5),
      generateId: () => 'inv-repo-tools',
    });

    const session = await engine.investigate(signal);
    const state = session.state;
    assert.ok(state);
    assert.equal(state.status, 'completed');
    assert.equal(session.events.filter((event) => event.type === 'action_failed').length, 0);

    const searchHits = state.evidence.filter((item) => item.kind === 'search_result');
    const reads = state.evidence.filter((item) => item.kind === 'source_code');
    assert.equal(searchHits.length, 3);
    assert.equal(reads.length, 1);
    assert.deepEqual(reads[0]?.source, { tool: 'read_file', actionId: 'action-3' });
    assert.ok(searchHits.every((item) => item.source.tool === 'search_code' && item.source.actionId === 'action-2'));
    assert.deepEqual(replayInvestigation(session.events), state);
  });
});
