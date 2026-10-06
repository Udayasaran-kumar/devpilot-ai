import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDefaultToolRegistry, RepositorySandbox } from '../src/index.js';
import { FIXTURE_ROOT } from './support/sandbox-fixture.js';

describe('createDefaultToolRegistry', () => {
  it('registers the three read-only repository tools', async () => {
    const registry = createDefaultToolRegistry(await RepositorySandbox.create(FIXTURE_ROOT));
    assert.deepEqual(
      registry.list().map((tool) => tool.name),
      ['read_file', 'search_code', 'list_files'],
    );
    for (const descriptor of registry.describe()) {
      assert.ok(descriptor.description.length > 0);
    }
  });
});
