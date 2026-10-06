import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

export interface ProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  /** Absolute, already sandbox-validated working directory. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** Per-stream capture limit in bytes. */
  readonly maxOutputBytes: number;
}

export interface ProcessOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly startError: string | null;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

/** How long to wait for stdio to close after a timeout kill before giving up on it. */
const CLOSE_GRACE_MS = 2000;
const USE_PROCESS_GROUPS = process.platform !== 'win32';

type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Runs one process from an argv array, never through a shell. On POSIX the
 * child leads its own process group so a timeout kills everything it spawned
 * (npm runs scripts through `sh`, and killing only npm orphans the script).
 */
export async function runProcess(request: ProcessRequest): Promise<ProcessOutcome> {
  const startedAt = performance.now();
  const stdout = new OutputCapture(request.maxOutputBytes);
  const stderr = new OutputCapture(request.maxOutputBytes);
  const outcome = (fields: Pick<ProcessOutcome, 'exitCode' | 'signal' | 'timedOut' | 'startError'>): ProcessOutcome => ({
    ...fields,
    durationMs: Math.round(performance.now() - startedAt),
    stdout: stdout.text(),
    stderr: stderr.text(),
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  });

  let child: PipedChild;
  try {
    child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: USE_PROCESS_GROUPS,
      windowsHide: true,
    });
  } catch (error) {
    return outcome({ exitCode: null, signal: null, timedOut: false, startError: errorMessage(error) });
  }

  return new Promise<ProcessOutcome>((resolve) => {
    let timedOut = false;
    let settled = false;
    let closeGrace: NodeJS.Timeout | undefined;

    const finish = (exitCode: number | null, signal: string | null, startError: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(closeGrace);
      killProcessTree(child);
      resolve(outcome({ exitCode, signal, timedOut, startError }));
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      closeGrace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null, 'SIGKILL', null);
      }, CLOSE_GRACE_MS);
    }, request.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.append(chunk));
    child.once('error', (error) => {
      if (child.pid === undefined) {
        finish(null, null, error.message);
      }
    });
    child.once('close', (code, signal) => finish(code, signal, null));
  });
}

/**
 * Kills the child and, on POSIX, every process in its group. Safe to call after
 * the child has exited. Failures are ignored: this runs inside event handlers,
 * and a kill that fails after a timeout is covered by the close grace period.
 */
function killProcessTree(child: PipedChild): void {
  if (child.pid === undefined) return;
  try {
    if (USE_PROCESS_GROUPS) {
      process.kill(-child.pid, 'SIGKILL');
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    // ESRCH (group already gone) is the normal case after a clean exit.
  }
}

/** Keeps at most `limit` bytes; later output is drained and discarded so the child never blocks on a full pipe. */
class OutputCapture {
  readonly #limit: number;
  readonly #chunks: Buffer[] = [];
  #size = 0;
  truncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  append(chunk: Buffer): void {
    const remaining = this.#limit - this.#size;
    if (chunk.length > remaining) {
      this.truncated = true;
      if (remaining > 0) {
        this.#chunks.push(Buffer.from(chunk.subarray(0, remaining)));
        this.#size = this.#limit;
      }
      return;
    }
    this.#chunks.push(chunk);
    this.#size += chunk.length;
  }

  text(): string {
    return Buffer.concat(this.#chunks).toString('utf8');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
