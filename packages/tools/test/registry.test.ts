import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { InMemoryToolRegistry, type Tool } from '../src/index.js';

const echoTool: Tool<{ text: string }, { echoed: string }> = {
  name: 'echo',
  description: 'Returns its input unchanged',
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ echoed: z.string() }),
  async run(input) {
    return { status: 'success', output: { echoed: input.text }, evidence: [] };
  },
};

describe('InMemoryToolRegistry', () => {
  it('registers and retrieves a fake tool', async () => {
    const registry = new InMemoryToolRegistry().register(echoTool);

    assert.equal(registry.has('echo'), true);
    const tool = registry.get('echo');
    assert.ok(tool);
    assert.equal(tool.name, 'echo');
    assert.deepEqual(registry.describe(), [{ name: 'echo', description: 'Returns its input unchanged' }]);

    const result = await tool.run({ text: 'hi' }, { investigationId: 'inv-1', actionId: 'action-1', now: () => '' });
    assert.deepEqual(result, { status: 'success', output: { echoed: 'hi' }, evidence: [] });
  });

  it('returns undefined for unknown tools', () => {
    const registry = new InMemoryToolRegistry();
    assert.equal(registry.get('missing'), undefined);
    assert.equal(registry.has('missing'), false);
    assert.deepEqual(registry.list(), []);
  });

  it('rejects duplicate registrations', () => {
    const registry = new InMemoryToolRegistry([echoTool]);
    assert.throws(() => registry.register(echoTool), /already registered/);
  });

  it('rejects invalid tool names', () => {
    assert.throws(() => new InMemoryToolRegistry().register({ ...echoTool, name: 'has spaces' }), /Invalid tool name/);
  });
});
