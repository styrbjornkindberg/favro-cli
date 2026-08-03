/**
 * `favro shell` refusing an interactive command UNDER A REAL PTY (#147).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `interactive-refusal.test.ts`. That file
 * mocks `child_process` and asserts `expect(execSync).not.toHaveBeenCalled()`.
 * It is the right test for the decision, and it is not a measurement of the
 * condition the bug lived in. #147's acceptance criterion asked for a pty
 * specifically, "since that is the only thing that distinguishes a pipe from a
 * terminal", and an argument that the decision happens before any fd is handed
 * over is not that measurement. So this file takes it.
 *
 * WHAT A PTY BUYS THAT JEST CANNOT FAKE. Node leaves `isTTY` **undefined** on a
 * pipe, not `false`, and `tty.isatty(fd)` answers about the real fd — neither is
 * reachable by assignment. Measured here, on this machine:
 *
 *   | parent           | child fds (stdin/stdout/stderr) |
 *   |------------------|---------------------------------|
 *   | jest (pipes)     | pipe / pipe / pipe              |
 *   | under a pty      | TTY  / pipe / pipe              |
 *
 * The second row is the bug from the ticket, reproduced: `runFavro` uses
 * `stdio: ['inherit','pipe','pipe']` so it can post-process output, so even with
 * a real terminal above it the child gets a PIPE for stdout. vi then prints
 * "Output is not to a terminal" and blocks. That row is only observable under a
 * pty, and `keeps output capture` below asserts it directly.
 *
 * HOW THE PTY IS ALLOCATED. `script(1)`, which ships with macOS and Linux — no
 * new devDependency for one test, and node-pty would mean a native gyp build.
 * The flag syntax differs between the two platforms (see `PTY_ARGV`), so this
 * suite is POSIX-only and skips cleanly elsewhere rather than failing.
 *
 * WHY A FAKE `favro` ON PATH. `runFavro` shells out to whatever `favro` resolves
 * to. A real one would open $EDITOR — non-deterministic, and dependent on a
 * global install. The shim is hermetic, it reports its own fd kinds (that is
 * where the table above comes from), it touches a marker file so "a child ran"
 * is observable even while it blocks, and for `skill edit` it BLOCKS — so a
 * removed guard hangs and this suite fails on its own timeout instead of going
 * green. Verified by doing exactly that: with the `skill edit` entry stripped
 * from `interactive-commands.ts`, `refuses … without spawning` was SIGKILLed at
 * the 4s bound and left its marker behind, against 0.6s and no marker green.
 *
 * NOTHING HERE CAN HANG THE SUITE. Every pty run is a `spawnSync` with a hard
 * `timeout` well under the per-test budget and `killSignal: 'SIGKILL'`, and a
 * timeout is asserted on explicitly rather than left to jest.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/** Hard bound on one pty run. Measured ~0.4s, so this is ~10x headroom. */
const PTY_TIMEOUT_MS = 4000;

const SUPPORTED = process.platform === 'darwin' || process.platform === 'linux';

/**
 * `script` takes an argv on macOS and a single command STRING on Linux:
 *   macOS: script -q /dev/null <cmd> <args…>
 *   Linux: script -qec "<cmd …>" /dev/null
 * The driver therefore takes ZERO arguments and reads its inputs from the
 * environment, so there is nothing to quote and one code path covers both.
 */
const PTY_ARGV = (driver: string): readonly string[] =>
  process.platform === 'darwin' ? ['-q', '/dev/null', 'node', driver] : ['-qec', `node ${driver}`, '/dev/null'];

let binDir: string;
let driver: string;
/** One marker path per run, so a stale file cannot answer for a later run. */
let runCount = 0;

beforeAll(() => {
  if (!SUPPORTED) return;
  const root = mkdtempSync(join(tmpdir(), 'favro-pty-'));
  binDir = join(root, 'bin');
  driver = join(root, 'driver.js');
  mkdirSync(binDir);

  // The child. Touches a marker, reports its inherited fds, then blocks for
  // `skill edit` — the blocking is what makes a removed guard fail instead of
  // pass. `sleep`, not an unbounded read: if SIGKILL ever misses it, it reaps
  // itself.
  //
  // THE MARKER IS NOT REDUNDANT WITH THE OUTPUT. `runFavro` captures the child's
  // stdout, so while the child blocks everything it printed sits unflushed in the
  // pipe and never reaches this process — an assertion on absent output would be
  // unfalsifiable exactly in the case that matters. A file on disk survives that,
  // and is the real-pty analogue of `expect(execSync).not.toHaveBeenCalled()`.
  const shim = join(binDir, 'favro');
  writeFileSync(
    shim,
    [
      '#!/bin/sh',
      'exec 2>&1',
      ': > "$FAVRO_PTY_MARKER"',
      `"${process.execPath}" -e 'const k=f=>require("tty").isatty(f)?"TTY":"pipe";console.log("CHILD-FDS stdin="+k(0)+" stdout="+k(1)+" stderr="+k(2))'`,
      'case "$1 $2" in',
      '  "skill edit") sleep 30 ;;',
      '  *) echo "CHILD-RAN $*" ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  chmodSync(shim, 0o755);

  writeFileSync(
    driver,
    [
      "const k = (f) => require('tty').isatty(f) ? 'TTY' : 'pipe';",
      "console.log('PARENT-FDS stdin=' + k(0) + ' stdout=' + k(1) + ' stderr=' + k(2));",
      'require(process.env.PTY_TS_NODE);',
      "require(process.env.PTY_SHELL).runFavro(process.env.PTY_CMD);",
      '',
    ].join('\n'),
  );
});

interface PtyRun {
  readonly out: string;
  readonly ms: number;
  readonly timedOut: boolean;
  /** Whether a child `favro` actually ran — observed on disk, not in the output. */
  readonly spawned: boolean;
}

/** Run `runFavro(cmd)` in a fresh node process whose three fds are a real pty. */
function underPty(cmd: string): PtyRun {
  const marker = join(binDir, `spawned-${runCount++}`);
  const started = Date.now();
  const result = spawnSync('script', PTY_ARGV(driver) as string[], {
    encoding: 'utf-8',
    timeout: PTY_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    // `ignore` is /dev/null. Not cosmetic: macOS `script` runs `tcgetattr` on its
    // OWN stdin to copy the terminal settings onto the pty it allocates, and
    // jest hands its children a socket — which fails with "tcgetattr/ioctl:
    // Operation not supported on socket" before any pty exists.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      PTY_TS_NODE: require.resolve('ts-node/register/transpile-only'),
      PTY_SHELL: require.resolve('../../commands/shell'),
      PTY_CMD: cmd,
      FAVRO_PTY_MARKER: marker,
      // Colour would only add escapes around the strings asserted below.
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
  });

  return {
    // `script` echoes CRs and a stray ^D; strip both plus any ANSI that leaks.
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`.replace(/\r/g, '').replace(/\x1b\[[0-9;]*m/g, ''),
    ms: Date.now() - started,
    timedOut: result.signal === 'SIGKILL',
    spawned: existsSync(marker),
  };
}

const describePty = SUPPORTED ? describe : describe.skip;

describePty('favro shell under a real pty', () => {
  test('the pty is real — all three parent fds are terminals, not pipes', () => {
    // Load-bearing. `isTTY` is `undefined` on a pipe, not `false`, so a harness
    // that quietly degraded to pipes would satisfy every other assertion here.
    // This one fails instead.
    const run = underPty('boards list');

    expect(run.timedOut).toBe(false);
    expect(run.out).toContain('PARENT-FDS stdin=TTY stdout=TTY stderr=TTY');
  });

  test('refuses skill edit without spawning, rather than handing vi a pipe', () => {
    const run = underPty('skill edit victim');

    // The shim blocks for `skill edit`, so a missing guard shows up here as a
    // SIGKILL at PTY_TIMEOUT_MS — the hang from the ticket, caught loudly.
    expect(run.timedOut).toBe(false);
    // No child, therefore nothing to block on. The inverse arm below observes
    // this same marker as `true`, so neither direction is vacuous.
    expect(run.spawned).toBe(false);
    expect(run.out).toContain('favro skill edit');
    expect(run.out).toContain('needs a terminal');
  });

  test('a non-interactive command still runs, and still has its output captured', () => {
    // The inverse arm. A guard that refused everything under a pty would pass
    // the test above; this is what stops it.
    const run = underPty('boards list');

    expect(run.timedOut).toBe(false);
    expect(run.spawned).toBe(true);
    expect(run.out).toContain('CHILD-RAN boards list');
    // The ticket's measurement, reproduced: a real terminal above, and the child
    // STILL gets a pipe for stdout, because capture is what pays for the refusal.
    // Flip `runFavro` to a blanket `stdio: 'inherit'` and this line changes.
    expect(run.out).toContain('CHILD-FDS stdin=TTY stdout=pipe stderr=pipe');
  });
});
