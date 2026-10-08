import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import type { Signal } from '@devpilot/core';
import { GroundedRepairPipeline, type GroundedRepairRun } from '@devpilot/engine';
import { resolveGitExecutable, type GitExecutable } from '@devpilot/tools';
import {
  createGitRepositoryFixture,
  type GitRepositoryFixture,
} from '../../tools/test/support/git-repository.js';
import {
  InvestigationOutcomeSchema,
  InvestigationService,
  MAX_SIGNAL_CONTENT_LENGTH,
  projectOutcome,
  RepositoryRegistry,
  retainReport,
  ServiceError,
  type InvestigationResult,
  type JobView,
  type ServiceErrorCode,
  type SignalInput,
} from '../src/index.js';

const SERVICE_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

const FAILURE: SignalInput = {
  kind: 'failing_test',
  title: 'Total is too high when a code is applied',
  content: [
    'not ok 2 - applies tax to the discounted amount',
    '  error: |-',
    '    Expected values to be strictly equal:',
    '    200 !== 180',
  ].join('\n'),
};

const NPM_TEST = { command: 'npm', args: ['test'] };

function refuses(code: ServiceErrorCode, call: () => unknown): void {
  assert.throws(call, (error: unknown) => error instanceof ServiceError && error.code === code);
}

function assertNoHostPaths(value: unknown, paths: readonly string[]): void {
  const text = JSON.stringify(value);
  for (const hostPath of paths) assert.ok(!text.includes(hostPath), `projection mentions host path ${hostPath}`);
  assert.ok(!/\/(Users|home|private|var|tmp)\//.test(text), 'projection mentions an absolute host path');
}

describe('repository registry', () => {
  const root = path.join(tmpdir(), 'devpilot-service-registry', 'repo');

  it('keeps host paths internal and lists only id, name, and command', () => {
    const registry = new RepositoryRegistry();
    registry.register({ repositoryId: 'shop', displayName: 'Shop', repositoryRoot: root, verification: NPM_TEST });
    assert.deepEqual(registry.list(), [{ repositoryId: 'shop', displayName: 'Shop', command: 'npm test' }]);
    assert.equal(registry.resolve('shop')?.repositoryRoot, root);
    assert.equal(registry.resolve('shop')?.allowedRoot, root, 'the allowed root defaults to the repository root');
  });

  it('refuses invalid registrations', () => {
    const registry = new RepositoryRegistry();
    const base = { repositoryId: 'shop', displayName: 'Shop', repositoryRoot: root, verification: NPM_TEST };
    refuses('invalid_registration', () => registry.register({ ...base, repositoryRoot: 'relative/repo' }));
    refuses('invalid_registration', () => registry.register({ ...base, allowedRoot: path.join(tmpdir(), 'elsewhere') }));
    refuses('invalid_registration', () => registry.register({ ...base, verification: { command: 'node', args: ['-e', '1'] } }));
    refuses('invalid_registration', () => registry.register({ ...base, verification: { command: 'npm', args: ['run', 'x'] } }));
    refuses('invalid_registration', () => registry.register({ ...base, repositoryId: '../repo' }));
    refuses('invalid_registration', () => registry.register({ ...base, planner: 'other' } as never));
    registry.register(base);
    refuses('invalid_registration', () => registry.register(base));
  });
});

describe('startInvestigation input contract', () => {
  const registry = new RepositoryRegistry();
  const root = path.join(tmpdir(), 'devpilot-service-contract', 'repo');
  registry.register({ repositoryId: 'shop', displayName: 'Shop', repositoryRoot: root, verification: NPM_TEST });
  registry.register({ repositoryId: 'no-default', displayName: 'No default', repositoryRoot: `${root}-2`, verification: NPM_TEST });
  const service = new InvestigationService({ registry });

  it('rejects an unknown repository', () => {
    refuses('unknown_repository', () => service.startInvestigation({ repositoryId: 'missing', signal: FAILURE }));
  });

  it('rejects unknown and malformed fields', () => {
    refuses('invalid_input', () => service.startInvestigation({ repositoryId: 'shop', signal: FAILURE, priority: 'high' }));
    refuses('invalid_input', () => service.startInvestigation({ repositoryId: 'shop', signal: { ...FAILURE, severity: 1 } }));
    refuses('invalid_input', () => service.startInvestigation({ repositoryId: 'shop', signal: { ...FAILURE, kind: 'pager' } }));
    refuses('invalid_input', () => service.startInvestigation({ repositoryId: 'Shop/../x', signal: FAILURE }));
    refuses('invalid_input', () => service.startInvestigation(null));
    refuses('invalid_input', () => service.startInvestigation('shop'));
  });

  it('does not let a caller supply a repository path, command, or planner', () => {
    for (const [name, value] of Object.entries({
      repositoryRoot: root,
      allowedRoot: '/',
      repositoryPath: root,
      worktreePath: '/tmp/worktree',
      command: 'node',
      args: ['-e', '1'],
      planner: 'custom',
      git: '/usr/bin/git',
    })) {
      refuses('invalid_input', () => service.startInvestigation({ repositoryId: 'shop', signal: FAILURE, [name]: value }));
    }
    for (const [name, value] of Object.entries({
      id: 'sig-1',
      command: 'node -e 1',
      repository: { path: root },
      receivedAt: '2026-01-01T00:00:00.000Z',
      metadata: { repositoryRoot: root },
    })) {
      refuses('invalid_input', () => service.startInvestigation({ repositoryId: 'shop', signal: { ...FAILURE, [name]: value } }));
    }
  });

  it('does not let a caller override the budget', () => {
    refuses('invalid_input', () => service.startInvestigation({ repositoryId: 'shop', signal: FAILURE, budget: { maxSteps: 1000 } }));
    refuses('invalid_input', () => service.startInvestigation({ repositoryId: 'shop', signal: { ...FAILURE, budget: { maxSteps: 1 } } }));
  });

  it('bounds the signal content and title', () => {
    const tooLong = 'x'.repeat(MAX_SIGNAL_CONTENT_LENGTH + 1);
    refuses('invalid_input', () => service.startInvestigation({ repositoryId: 'shop', signal: { ...FAILURE, content: tooLong } }));
    refuses('invalid_input', () => service.startInvestigation({ repositoryId: 'shop', signal: { ...FAILURE, content: '' } }));
    refuses('invalid_input', () => service.startInvestigation({ repositoryId: 'shop', signal: { ...FAILURE, title: 't'.repeat(201) } }));
    refuses('invalid_input', () => service.startInvestigation({ repositoryId: 'shop', signal: { ...FAILURE, title: '   ' } }));
  });

  it('requires a signal when the repository has no default', () => {
    refuses('signal_required', () => service.startInvestigation({ repositoryId: 'no-default' }));
  });

  it('refuses unknown and malformed job IDs', () => {
    refuses('unknown_job', () => service.getJob({ jobId: 'job-00000000-0000-0000-0000-000000000000' }));
    refuses('invalid_input', () => service.getJob({ jobId: '../job' }));
    refuses('invalid_input', () => service.getResult({ jobId: 'job-00000000-0000-0000-0000-000000000000', status: 'completed' }));
  });
});

describe('InvestigationService runs the grounded repair pipeline', () => {
  let realGit: GitExecutable;
  let shop: GitRepositoryFixture;
  let second: GitRepositoryFixture;
  let service: InvestigationService;
  let queued: JobView;
  let otherQueued: JobView;
  let busyError: unknown;
  let finished: JobView;
  let result: InvestigationResult;
  let pendingResult: InvestigationResult;
  let hostPaths: string[];

  before(async () => {
    realGit = await resolveGitExecutable();
    shop = await createGitRepositoryFixture(realGit);
    second = await createGitRepositoryFixture(realGit);
    hostPaths = [shop.base, shop.root, shop.canonicalRoot, shop.allowedRoot, second.base, second.root, homedir(), tmpdir()];
    const registry = new RepositoryRegistry();
    registry.register({
      repositoryId: 'shop',
      displayName: 'Shop',
      repositoryRoot: shop.root,
      allowedRoot: shop.allowedRoot,
      verification: NPM_TEST,
    });
    registry.register({
      repositoryId: 'second-shop',
      displayName: 'Second shop',
      repositoryRoot: second.root,
      allowedRoot: second.allowedRoot,
      verification: NPM_TEST,
      defaultSignal: FAILURE,
    });
    service = new InvestigationService({ registry, git: realGit });

    queued = service.startInvestigation({ repositoryId: 'shop', signal: FAILURE });
    pendingResult = service.getResult({ jobId: queued.jobId });
    try {
      service.startInvestigation({ repositoryId: 'shop', signal: FAILURE });
    } catch (error) {
      busyError = error;
    }
    otherQueued = service.startInvestigation({ repositoryId: 'second-shop' });
    finished = await service.waitForJob({ jobId: queued.jobId });
    await service.waitForJob({ jobId: otherQueued.jobId });
    result = service.getResult({ jobId: queued.jobId });
  });

  after(async () => {
    await shop?.cleanup();
    await second?.cleanup();
  });

  it('a valid start returns an opaque queued job', () => {
    assert.equal(queued.status, 'queued');
    assert.match(queued.jobId, /^job-[0-9a-f-]{36}$/);
    assert.equal(queued.repositoryId, 'shop');
    assert.equal(pendingResult.outcome, null, 'no outcome before the job completes');
  });

  it('rejects a concurrent start for the same repository', () => {
    assert.ok(busyError instanceof ServiceError);
    assert.equal(busyError.code, 'repository_busy');
  });

  it('runs different repositories independently, using the server-owned default signal', async () => {
    assert.notEqual(otherQueued.jobId, queued.jobId);
    const other = service.getResult({ jobId: otherQueued.jobId });
    assert.equal(other.job.status, 'completed');
    assert.equal(other.outcome?.repairStatus, 'repaired');
  });

  it('the job reaches completed and frees the repository', async () => {
    assert.equal(finished.status, 'completed', finished.failureReason);
    assert.ok(finished.finishedAt);
    const again = service.startInvestigation({ repositoryId: 'shop', signal: FAILURE });
    assert.equal((await service.waitForJob({ jobId: again.jobId })).status, 'completed');
  });

  it('projects the grounded result', () => {
    const outcome = result.outcome;
    assert.ok(outcome);
    InvestigationOutcomeSchema.parse(outcome);
    assert.equal(outcome.groundingValid, true);
    assert.equal(outcome.repairStatus, 'repaired');
    assert.deepEqual(
      outcome.baselineFailures.map((failure) => failure.testName),
      ['applies tax to the discounted amount'],
    );
    assert.ok(outcome.baselineFailures.every((failure) => !path.isAbsolute(failure.testFile)));
    assert.ok(outcome.affectedFiles.length > 0 && outcome.affectedFiles.every((file) => !path.isAbsolute(file)));
    assert.ok(outcome.claims.some((claim) => claim.kind === 'verification'));
    assert.ok(outcome.limitations.some((limitation) => limitation.includes('removed the verification worktree')));
    assert.match(outcome.spokenSummary, /verified a patch in an isolated worktree/);
    assert.match(outcome.spokenSummary, /not applied to the repository/);
    assert.ok(!/\b(fixed|correct|resolved the bug)\b/i.test(outcome.spokenSummary));
  });

  it('exposes no host paths, worktrees, logs, or patch text', () => {
    const views = [service.listRepositories(), result, service.getJob({ jobId: queued.jobId })];
    for (const view of views) assertNoHostPaths(view, hostPaths);
    const text = JSON.stringify(result);
    assert.ok(!text.includes('devpilot-worktree'));
    assert.ok(!/"(events|evidence|patch|workspace|repositoryRoot|allowedRoot|env)"/.test(text));
    assert.ok(!text.includes('@@ '), 'no unified diff hunks');
  });

  it('leaves no worktree behind and the repository unmodified', async () => {
    const { git } = await import('../../tools/test/support/git-repository.js');
    assert.equal(git(realGit, shop.root, 'status', '--porcelain'), '');
    assert.equal(git(realGit, shop.root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)?.length, 1);
  });

  it('reports a run that cannot start as failed, without internal details, and frees the repository', async () => {
    const registry = new RepositoryRegistry();
    const missing = path.join(shop.allowedRoot, 'not-a-repository');
    registry.register({ repositoryId: 'gone', displayName: 'Gone', repositoryRoot: missing, verification: NPM_TEST });
    const failing = new InvestigationService({ registry, git: realGit });
    const job = failing.startInvestigation({ repositoryId: 'gone', signal: FAILURE });
    const view = await failing.waitForJob({ jobId: job.jobId });
    assert.equal(view.status, 'failed');
    assert.equal(view.failureReason, 'The investigation could not be run for this repository.');
    assert.equal(failing.getResult({ jobId: job.jobId }).outcome, null);
    assertNoHostPaths(failing.getResult({ jobId: job.jobId }), [...hostPaths, missing]);
    const retry = failing.startInvestigation({ repositoryId: 'gone', signal: FAILURE });
    await failing.waitForJob({ jobId: retry.jobId });
  });
});

describe('projection refuses ungrounded reports', () => {
  let realGit: GitExecutable;
  let fixture: GitRepositoryFixture;
  let run: GroundedRepairRun;
  const signal: Signal = { ...FAILURE, id: 'sig-service', command: 'npm test', receivedAt: '2026-01-01T00:00:00.000Z' };

  before(async () => {
    realGit = await resolveGitExecutable();
    fixture = await createGitRepositoryFixture(realGit);
    run = await new GroundedRepairPipeline({ allowedRoot: fixture.allowedRoot, git: realGit }).run({ repositoryRoot: fixture.root, signal });
    await run.repair?.workspace?.remove();
  });

  after(async () => {
    await fixture?.cleanup();
  });

  const context = { displayName: 'Shop', hostPaths: [] as string[] };

  it('the untampered run is grounded', () => {
    assert.equal(run.report.repairStatus, 'repaired');
    assert.equal(retainReport(run).groundingValid, true);
  });

  it('re-validates instead of trusting the pipeline: a tampered report yields no success claims', () => {
    const tampered: GroundedRepairRun = {
      ...run,
      report: {
        ...run.report,
        claims: run.report.claims.map((claim) =>
          claim.kind === 'verification' ? { ...claim, statement: `${claim.statement} The bug is fixed.` } : claim,
        ),
      },
    };
    const retained = retainReport(tampered);
    assert.equal(retained.groundingValid, false, 'the service re-validation catches what the pipeline grounding did not see');
    const outcome = projectOutcome(retained, context);
    assert.equal(outcome.groundingValid, false);
    assert.equal(outcome.repairStatus, null);
    assert.deepEqual(outcome.claims, []);
    assert.deepEqual(outcome.baselineFailures, []);
    assert.deepEqual(outcome.affectedFiles, []);
    assert.equal(outcome.spokenSummary, 'DevPilot has no verified result for Shop.');
  });

  it('a run whose pipeline grounding failed yields no success claims', () => {
    const outcome = projectOutcome(retainReport({ ...run, grounding: { valid: false, issues: [] } }), context);
    assert.equal(outcome.groundingValid, false);
    assert.equal(outcome.repairStatus, null);
    assert.deepEqual(outcome.claims, []);
  });

  it('a projection that would mention a host path is withheld', () => {
    const retained = retainReport(run);
    const leaking = { ...retained, report: { ...retained.report, limitations: [...retained.report.limitations, `See ${fixture.root}`] } };
    const outcome = projectOutcome(leaking, { displayName: 'Shop', hostPaths: [fixture.root] });
    assert.equal(outcome.groundingValid, false);
    assert.deepEqual(outcome.claims, []);
    assertNoHostPaths(outcome, [fixture.root]);
  });

  it('the outcome schema refuses an ungrounded outcome that carries success claims', () => {
    const outcome = projectOutcome(retainReport(run), context);
    assert.equal(InvestigationOutcomeSchema.safeParse({ ...outcome, groundingValid: false }).success, false);
  });
});

describe('the service stays transport-free and calls only the grounded pipeline', () => {
  const ALLOWED_IMPORTS = new Set([
    'node:crypto',
    'node:fs/promises',
    'node:os',
    'node:path',
    'zod',
    '@devpilot/core',
    '@devpilot/engine',
    '@devpilot/tools',
  ]);
  const FORBIDDEN = /RepairWorkflow|InvestigationEngine|apply_patch|run_command|createDefaultToolRegistry|RepositorySandbox|invokeTool|child_process|execFile|spawn\(|node:http|node:net|@modelcontextprotocol|@aws-sdk|\bexpress\b|alexa|bedrock/i;
  const VOCABULARY = /checkout\.ts|checkout\(|\btax\b|tax_rate|discount|subtotal|payroll|pension|\bgross\b|INC-001|traceroot/i;

  it('imports only core, engine, tools, zod, and local node modules, with no direct tool or workflow calls', async () => {
    const files = (await readdir(SERVICE_SRC)).filter((file) => file.endsWith('.ts'));
    assert.ok(files.length >= 4);
    for (const file of files) {
      const source = await readFile(path.join(SERVICE_SRC, file), 'utf8');
      for (const [, specifier] of source.matchAll(/from '([^']+)'/g)) {
        assert.ok(specifier?.startsWith('./') || ALLOWED_IMPORTS.has(specifier ?? ''), `${file} imports ${specifier}`);
      }
      assert.ok(!FORBIDDEN.test(source), `${file} references ${source.match(FORBIDDEN)?.[0]}`);
      assert.ok(!VOCABULARY.test(source), `${file} contains fixture vocabulary ${source.match(VOCABULARY)?.[0]}`);
    }
  });

  it('constructs only GroundedRepairPipeline from the engine', async () => {
    const source = await readFile(path.join(SERVICE_SRC, 'service.ts'), 'utf8');
    assert.deepEqual([...source.matchAll(/new ([A-Z]\w+)\(/g)].map((match) => match[1]).filter((name) => name !== 'Date' && name !== 'Map' && name !== 'Set' && name !== 'ServiceError' && name !== 'Error'), ['GroundedRepairPipeline']);
  });
});
