# Hackathon friction log

Real problems hit while building DevPilot AI, with what we did about them.
Environment: macOS, Node.js 22.17.0, npm 11.6.2, TypeScript 7.0.2, tsx 4.23.

## Killing `npm` does not kill the test process it started

- **What happened:** `npm test` runs the package script through `sh`, so the
  process tree is `npm -> sh -> node`. A probe that spawned `npm test` (script:
  a `node` process that never exits) and then called `child.kill('SIGKILL')`
  left the `node` grandchild running as an orphan. The same probe with
  `detached: true` and `process.kill(-pid, 'SIGKILL')` left nothing behind.
- **Impact:** a timeout implemented with `child.kill()` (or `spawn`'s
  `timeout` option) reports success while the test keeps running, holding CPU
  and possibly the stdout pipe.
- **Workaround:** `process-runner.ts` starts each command as the leader of its
  own process group and kills the whole group on timeout and after exit. A
  test spawns a grandchild and asserts it is dead after the timeout; switching
  back to `child.kill()` makes that test fail. Process groups are POSIX-only,
  so Windows still only kills the direct child.

## Node's built-in TypeScript stripping cannot run TypeScript written for `tsc`/`tsx`

- **What happened:** the fixture used the NodeNext convention of importing
  `./money.js` from `.ts` files. Under
  `node --experimental-strip-types` (Node 22.17) this fails with
  `ERR_MODULE_NOT_FOUND ... a.js`: Node does not map `.js` specifiers to `.ts`
  files. Node 22.17 also still needs the flag and prints an
  `ExperimentalWarning` on every run.
- **Impact:** the fixture could not run its own tests without either a
  TypeScript runner installed in the fixture or rewriting imports. The
  workspace (tsx, `.js` specifiers) and the fixture (native, `.ts` specifiers)
  now use different conventions.
- **Workaround:** fixture imports use `.ts` specifiers and its test script is
  `node --experimental-strip-types --disable-warning=ExperimentalWarning --test ...`,
  so `npm test` needs nothing beyond Node itself.

## `node:test` output makes command evidence unstable

- **What happened:** the TAP reporter prints `duration_ms` for every test and
  absolute file paths in failure `location` and stack lines.
- **Impact:** evidence IDs are content hashes, so two runs of the same failing
  `npm test` produce different IDs, and a copy of the repository in another
  directory produces different output for the same failure.
- **Workaround:** the sandbox replaces the repository root with `<repo>` in
  captured output, which fixes the path part. Durations remain, so identical
  test failures still get distinct evidence IDs per run; the deterministic-ID
  tests use commands with deterministic output.

## `tsx -e` compiles as CommonJS inside an ESM package

- **What happened:** a quick `npx tsx -e "...await..."` smoke test in this
  `"type": "module"` workspace failed with
  `Top-level await is currently not supported with the "cjs" output format`.
- **Workaround:** wrap ad-hoc scripts in an async IIFE.

## `node:test` reports the wrong source location under tsx

- **What happened:** a failing assertion in `run-command.test.ts` was reported
  with `location: '.../run-command.test.ts:1:2037'`, while the stack trace in
  the same report pointed at the correct line (104).
- **Workaround:** read the stack trace, not `location`, when debugging tests
  run through `--import tsx`.

## System `git` blocked by the Xcode license on macOS

- **What happened:** `/usr/bin/git` refused to run until the Xcode license was
  accepted (`sudo xcodebuild -license`), which needs an interactive terminal.
- **Workaround:** used Homebrew's `/opt/homebrew/bin/git`.

## The broken system `git` comes first on PATH

- **What happened:** when DevPilot needed to run git itself (for worktrees),
  `which -a git` listed `/usr/bin/git` before `/opt/homebrew/bin/git`, because
  `/usr/bin` precedes `/opt/homebrew/bin` on this machine's PATH. The Xcode
  shim is executable but exits with code 69 and the license message on
  stderr, so "first `git` on PATH" chooses a git that cannot run.
- **Impact:** a plain PATH lookup, or spawning `git` by name, fails on a
  machine that has a perfectly good git installed. Hardcoding the Homebrew
  path would break Intel Macs (`/usr/local/bin`), Linux, and CI.
- **Workaround:** `resolveGitExecutable` probes every absolute `git` on PATH
  with `git --version` and uses the first that succeeds. If none works, the
  error lists each candidate and why it failed (for example
  `/usr/bin/git: exited with code 69: You have not agreed to the Xcode license
  agreements...`). A test puts a fake shim with the same behaviour ahead of a
  working git on PATH.
