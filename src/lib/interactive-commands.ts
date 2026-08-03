/**
 * Which favro commands need a terminal — asked once, read by both parents.
 *
 * WHY THIS EXISTS (#147). `favro` is not always the top-level process. Two
 * things run it as a child, and both hand it pipes rather than a tty:
 *
 *   - `favro shell` (`commands/shell.ts`) — `stdio: ['inherit','pipe','pipe']`,
 *     because it post-processes the child's stdout. Measured under a real pty:
 *     `favro skill edit x` gets `stdin=TTY stdout=TTY stderr=TTY`, the same
 *     command through the shell gets `stdout=pipe stderr=pipe`, and vi prints
 *     "Output is not to a terminal" and hangs.
 *   - `favro_run` (`mcp-server.ts`) — `execFile`, all three fds piped. An
 *     interactive command there burned the whole 60s timeout and came back as
 *     a generic `isError`, which tells an agent "retry", not "impossible".
 *
 * A hang is the worst failure an agent-driven CLI has: it spends the entire
 * budget and produces nothing. So both parents ask this module BEFORE spawning
 * and refuse instantly — fail-closed applied to I/O.
 *
 * WHY A LIST AND NOT A MARKER ON THE COMMAND. Both readers decide before the
 * child process exists, so neither can consult a `Command` object built inside
 * it. The list is therefore the marker, and `interactive-command-coverage.test.ts`
 * is what stops it drifting: it walks the real commander surface through the
 * TypeScript checker and fails when a registered command can reach a prompt,
 * an enquirer picker or an `stdio: 'inherit'` spawn without appearing here.
 *
 * This module imports nothing, so both readers can have it without a cycle.
 */

export interface InteractiveCommand {
  /**
   * The command path as typed after `favro`, space-separated. The empty string
   * is `favro` with no arguments at all, which opens the main menu — matched on
   * `argv.length === 0` exactly as `cli.ts` decides it, so `favro --help` is
   * still help and not a menu.
   */
  readonly path: string;
  /** Why it cannot work without a terminal. Goes verbatim into the refusal. */
  readonly reason: string;
  /** Interactive only when one of these flags is present. */
  readonly onlyWith?: readonly string[];
  /** Not interactive when ALL of these flags are present. */
  readonly notWith?: readonly string[];
}

export const INTERACTIVE_COMMANDS: readonly InteractiveCommand[] = [
  {
    path: '',
    reason: 'favro with no subcommand opens the interactive main menu',
  },
  {
    path: 'shell',
    reason: 'it is a REPL that reads the terminal until you type exit',
  },
  {
    path: 'browse',
    reason: 'it is an arrow-key picker',
  },
  {
    // The flags are the whole point: `auth login --email … --api-key …` skips
    // both prompts and is a perfectly good non-interactive path. Refusing it
    // would break the one way an agent can authenticate.
    path: 'auth login',
    reason: 'it prompts for an email address and an API token',
    notWith: ['--email', '--api-key'],
  },
  {
    path: 'skill edit',
    reason: 'it opens $EDITOR on the terminal and waits for it to close',
  },
  {
    // `favro board <id>` renders once and returns — usable from anywhere, and
    // `--json` is the shape built for the runner. Only `--watch` never returns,
    // and `--watch --json` returns early before the loop, so it does not count.
    path: 'board',
    reason: '--watch repaints the terminal every interval and only Ctrl+C ends it',
    onlyWith: ['--watch'],
    notWith: ['--json'],
  },
];

/**
 * The entry matching an argv, or `undefined` if the command can run on a pipe.
 *
 * Matches the command path against the leading NON-flag tokens. Every root
 * option is a boolean (`--verbose`, `--human`, `--pretty`), so no option value
 * can occupy a path position and be mistaken for a subcommand.
 */
export function findInteractiveCommand(argv: readonly string[]): InteractiveCommand | undefined {
  const flags = new Set(argv.filter((t) => t.startsWith('-')).map((t) => t.split('=')[0]));
  const words = argv.filter((t) => !t.startsWith('-'));

  return INTERACTIVE_COMMANDS.find((entry) => {
    if (entry.path === '') return argv.length === 0;
    if (entry.path.split(' ').some((part, i) => words[i] !== part)) return false;
    if (entry.onlyWith && !entry.onlyWith.some((flag) => flags.has(flag))) return false;
    if (entry.notWith && entry.notWith.every((flag) => flags.has(flag))) return false;
    return true;
  });
}

/**
 * The refusal text. One wording for both readers — ADR-0002: say what was
 * refused and why, and name the way out.
 */
export function interactiveRefusal(entry: InteractiveCommand): string {
  const name = entry.path === '' ? 'favro with no subcommand' : `favro ${entry.path}`;
  return `${name} needs a terminal — ${entry.reason}. It cannot run here; run it directly in a terminal.`;
}
