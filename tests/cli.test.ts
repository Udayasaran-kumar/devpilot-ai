import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const cliEntry = fileURLToPath(new URL('../apps/cli/src/index.ts', import.meta.url));

describe('CLI', () => {
  it('starts and reports that the engine is initialized', async () => {
    const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', cliEntry]);
    const lines = stdout.trim().split('\n');
    assert.equal(lines[0], 'DevPilot AI');
    assert.match(lines[1] ?? '', /^Investigation engine initialized/);
  });
});
