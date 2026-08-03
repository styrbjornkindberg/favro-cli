/**
 * `skill edit` (and its interactive siblings) through BOTH parents (#147).
 *
 * WHAT WENT WRONG. `favro skill edit x` typed at a terminal works — #129 gave it
 * `spawnSync(bin, argv, { stdio: 'inherit' })`. But `inherit` inherits whatever
 * the parent handed down, and both parents hand down pipes: `favro shell` runs
 * `stdio: ['inherit','pipe','pipe']` so it can post-process the output, and
 * `favro_run` runs `execFile`, which pipes all three. vi then prints "Output is
 * not to a terminal" and blocks. Under `favro_run` that cost the entire 60s
 * timeout and returned a generic `isError` — which reads to an agent as "retry".
 *
 * WHAT IS ASSERTED. Both parents now ask `lib/interactive-commands.ts` and refuse
 * BEFORE spawning, so the load-bearing assertion in each refusal test is
 * `expect(spawn).not.toHaveBeenCalled()` — no child, therefore no hang, therefore
 * nothing to time out. The companion tests pin the other half: a non-interactive
 * command still spawns and the shell still captures its stdout, which is what a
 * blanket `stdio: 'inherit'` would have destroyed.
 *
 * NO PTY, AND WHY THAT IS NOT A GAP. A pty is what distinguishes a pipe from a
 * terminal, and it was the only way to observe the old bug. It cannot observe
 * this fix: the decision is taken before any fd is handed to anything, so the
 * result is identical under a pty and under jest — measured: run the pty suite's
 * harness over a plain pipe instead of `script` and the refusal arm still passes,
 * while its two siblings fail. `skill-edit-spawn.test.ts` still covers the
 * real-spawn path for the terminal case, and `shell-pty.test.ts` takes #147's
 * "under a real pty" clause literally: same refusal, real terminal above it, plus
 * the child-fd measurement from the ticket that only a pty can make.
 *
 * NOTHING HERE CAN HANG. `child_process` is mocked and both mocks answer
 * immediately, so a removed guard fails an assertion in milliseconds rather than
 * burning a jest timeout.
 */
import { execFile, execSync } from 'child_process';

jest.mock('child_process', () => ({
  // Answers at once. A regression that reaches these must fail on the
  // "not.toHaveBeenCalled" assertion, never by hanging the suite.
  execSync: jest.fn(() => 'spawned\n'),
  execFile: jest.fn((...args: unknown[]) => {
    const cb = args[args.length - 1] as (e: null, r: { stdout: string; stderr: string }) => void;
    cb(null, { stdout: 'spawned', stderr: '' });
  }),
}));

import { runFavro } from '../../commands/shell';
import { createMcpServer, ToolResult } from '../../mcp-server';

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockExecFile = execFile as jest.MockedFunction<typeof execFile>;

let errorSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

const stderrText = (): string => errorSpy.mock.calls.map((call) => String(call[0])).join('\n');

const favroRun = (command: string): Promise<ToolResult> =>
  createMcpServer().tools.get('favro_run')!({ command }) as Promise<ToolResult>;

// ─── parent 1: favro shell ───────────────────────────────────────────────────

describe('favro shell', () => {
  test('refuses skill edit by name instead of handing vi a pipe', () => {
    runFavro('skill edit victim');

    // The whole fix: no child, so nothing to block on.
    expect(mockExecSync).not.toHaveBeenCalled();
    expect(stderrText()).toContain('favro skill edit');
    expect(stderrText()).toContain('terminal');
  });

  test('refuses the other interactive commands too, not just the one in the ticket', () => {
    for (const cmd of ['shell', 'browse', 'auth login', 'board b1 --watch']) {
      errorSpy.mockClear();
      runFavro(cmd);
      expect(mockExecSync).not.toHaveBeenCalled();
      expect(stderrText()).toContain('needs a terminal');
    }
  });

  test('a non-interactive command still runs AND still has its output captured', () => {
    runFavro('boards list');

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync.mock.calls[0][0]).toBe('favro boards list');
    // `stdio: ['inherit','pipe','pipe']` is the reason the refusal exists rather
    // than a blanket `inherit`; if capture goes, so does the trade-off.
    expect((mockExecSync.mock.calls[0][1] as { stdio: unknown }).stdio).toEqual(['inherit', 'pipe', 'pipe']);
    expect(logSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain('spawned');
  });
});

// ─── parent 2: favro_run (MCP) ───────────────────────────────────────────────

describe('favro_run', () => {
  test('refuses skill edit immediately rather than timing out after 60s', async () => {
    const started = Date.now();
    const result = await favroRun('skill edit victim');

    expect(mockExecFile).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('favro skill edit');
    expect(result.content[0].text).toContain('needs a terminal');
    // "well under a second" — a spawn is the only thing here that could take
    // longer, and the assertion above proves there was none.
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('an empty command is the main menu, and refuses rather than opening it', async () => {
    // `cli.ts` opens the interactive menu on zero arguments, and `splitCommand('')`
    // is zero arguments. This was reachable and cost the full timeout.
    const result = await favroRun('');

    expect(mockExecFile).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('main menu');
  });

  test('refuses shell, browse and board --watch, each naming itself', async () => {
    for (const [command, name] of [
      ['shell', 'favro shell'],
      ['browse', 'favro browse'],
      ['board b1 --watch', 'favro board'],
      ['auth login', 'favro auth login'],
    ]) {
      const result = await favroRun(command);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(name);
    }
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  test('the flagged non-interactive paths are NOT refused', async () => {
    // Each of these is a real way to get the same job done without a terminal.
    // Refusing them would be the fix breaking more than it fixed.
    for (const command of [
      'auth login --email a@b.c --api-key k',
      // `--flag=value` is the same invocation, and the matcher normalises on
      // `split('=')[0]` to see it. Dropping that normalisation left every `=`
      // form unrecognised and this loop still green.
      'auth login --email=a@b.c --api-key=k',
      'board b1',
      'board b1 --watch --json',
      'board b1 --watch --json=true',
      'boards list',
      'skill list',
      // BOTH FLAGS PRESENT, NEITHER CARRYING A VALUE — and it spawns, because a
      // list of command PATHS cannot see values. `splitCommand` drops the empty
      // token, so this reaches commander as `--email --api-key`; commander binds
      // `--api-key` as the email and leaves the token unset, and the handler
      // prompts for what it did not get. That hung for 60022ms, measured, until
      // `promptInput` was made fail-closed — see
      // `auth-commands.test.ts: refuses to prompt when stdin is not a terminal`.
      // The matcher is deliberately NOT taught to inspect values: the guard at
      // the prompt covers every way of arriving there, including the multi-org
      // picker, which no flag can predict.
      'auth login --email "" --api-key ""',
    ]) {
      const result = await favroRun(command);
      expect(result.isError).toBeUndefined();
    }
    expect(mockExecFile).toHaveBeenCalledTimes(8);
  });

  test('a PARTIALLY flagged auth login is refused, not waved through to the prompt', async () => {
    // `notWith` fires only when EVERY listed flag is present, and that `every`
    // is the whole guard: relaxed to `some`, `auth login --email a@b.c` spawns,
    // prompts for the API token it was not given, and hangs for the full 60s.
    // The mutation survived the suite before this test existed.
    for (const command of ['auth login --email a@b.c', 'auth login --api-key k']) {
      const result = await favroRun(command);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('favro auth login');
    }
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  test('an interactive command NAME appearing as an option value is not a match', async () => {
    // The matcher reads the leading non-flag tokens as a path. A board called
    // "shell" must not make `cards list` unrunnable.
    const result = await favroRun('cards list --board shell');

    expect(result.isError).toBeUndefined();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  test('--help still reaches the CLI rather than matching the empty-argv menu', async () => {
    // `favro --help` prints help; only ZERO arguments opens the menu, which is
    // how `cli.ts` decides it. A matcher keying on "no non-flag words" would
    // break every help lookup.
    const result = await favroRun('--help');

    expect(result.isError).toBeUndefined();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });
});
