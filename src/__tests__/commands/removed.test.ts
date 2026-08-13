/**
 * The 4.0 refusal stubs (#110).
 *
 * The point of keeping the commands registered is that an agent gets a NEXT
 * MOVE, so what has to be pinned is the whole of that: exit 1, a message naming
 * the replacement, and — the half a merged-stream assertion cannot see — that
 * message reaching the stream the caller is actually reading. Under the JSON
 * default that is an envelope on STDOUT (ADR-0002): MCP hands an agent stdout
 * first, so a refusal written only to stderr reads as `(no output)`, which is
 * the same dead end one layer down. Review found `cards update --board` doing
 * exactly that, so `driven` below keeps the two streams apart.
 *
 * Driven through `buildProgram()` rather than by registering the module
 * directly, because the failure this guards is a commander-level one: without
 * `allowUnknownOption` the real invocation (`batch update --from-csv cards.csv`)
 * is answered `error: unknown option '--from-csv'` and the pointer never prints
 * — measured against the built CLI before that line existed.
 */
import { buildProgram } from '../../cli';
import { tempConfigDir } from '../../test-support/config-dir';

// No credentials anywhere near this: a removal needs no client, and the arms
// below are also what proves it.
tempConfigDir('favro-removed-config-');

/** Drive one invocation and collect each stream separately, plus the exit code. */
async function driven(argv: string[]): Promise<{ out: string[]; err: string[]; code?: number }> {
  const out: string[] = [];
  const err: string[] = [];
  let code: number | undefined;
  const log = jest.spyOn(console, 'log').mockImplementation((...a) => { out.push(String(a[0])); });
  const errSpy = jest.spyOn(console, 'error').mockImplementation((...a) => { err.push(String(a[0])); });
  const exit = jest.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c;
    throw new Error('process.exit');
  }) as never);
  const before = process.exitCode;
  try {
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(['node', 'favro', ...argv]);
  } catch (error) {
    if ((error as Error).message !== 'process.exit') throw error;
  }
  // All six are `run()`-migrated now, so the runner sets `process.exitCode`
  // rather than exiting. The `process.exit` spy stays because a REGRESSION to a
  // hand-written refusal would use it, and this has to keep reporting 1 either
  // way or the arms below would go quiet about which mechanism ran.
  code = code ?? (typeof process.exitCode === 'number' ? process.exitCode : undefined);
  process.exitCode = before;
  log.mockRestore();
  errSpy.mockRestore();
  exit.mockRestore();
  return { out, err, code };
}

/** Every spelling #110 removed, with the pointer each one owes its caller. */
const SPELLINGS: Array<[string, string[], string]> = [
  [
    'batch update, with the flags the old invocation carried',
    ['batch', 'update', '--from-csv', 'cards.csv'],
    "Use 'favro cards update --from-csv <file>'",
  ],
  [
    'batch move',
    ['batch', 'move', '--board', 'B', '--filter', 'status:Done', '--to-board', 'C', '--yes'],
    "Enumerate first with 'favro cards list --filter",
  ],
  [
    'batch assign',
    ['batch', 'assign', '--board', 'B', '--to', 'alice', '--filter', 'status:Todo', '--yes'],
    "Enumerate first with 'favro cards list --filter",
  ],
  [
    'batch-smart, with its required argument and goal',
    ['batch-smart', 'board-1', '--goal', 'close all Done cards', '--yes'],
    'Decide the operations yourself',
  ],
  [
    'cards update --board with no card id (--label form)',
    ['cards', 'update', '--board', 'Q2-Dev', '--label', 'urgent', '--status', 'done', '--yes'],
    "Enumerate first with 'favro cards list --filter",
  ],
  [
    'cards update --board with no card id (--assignee form)',
    ['cards', 'update', '--board', 'Q2-Dev', '--assignee', 'alice', '--yes'],
    "Enumerate first with 'favro cards list --filter",
  ],
];

/**
 * `run()` sets `process.exitCode` instead of exiting, and jest shares one
 * process per worker — an un-reset code leaks into the worker's own exit and
 * into the next arm's assertion.
 */
beforeEach(() => {
  process.exitCode = undefined;
});
afterEach(() => {
  process.exitCode = undefined;
});

describe('every removed spelling exits 1 naming its replacement', () => {
  it.each(SPELLINGS)('%s', async (_label, argv, pointer) => {
    const { out, err, code } = await driven(argv);
    const said = [...out, ...err].join('\n');

    expect(code).toBe(1);
    expect(said).toContain('removed in 4.0');
    expect(said).toContain(pointer);
    // The failure this replaces. `unknown command` and `unknown option` are the
    // same dead end: an agent cannot tell a removal from a typo, so it retries
    // the same call spelled differently.
    expect(said).not.toContain('unknown command');
    expect(said).not.toContain('unknown option');
  });

  it.each(SPELLINGS)('%s — the envelope is on STDOUT under the JSON default', async (_l, argv, pointer) => {
    const { out, err, code } = await driven(argv);

    // Stderr EMPTY is the load-bearing half. Without it this is the assertion the
    // merged-stream version already made, and `cards update --board` passed it
    // while writing `✗ …` to stderr and nothing at all to stdout.
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0])).toEqual({
      error: {
        message: expect.stringContaining(pointer),
        // Deterministic: running it again removes nothing. A `true` here is an
        // agent told to loop on a command that no longer exists.
        retryable: false,
      },
    });
    expect(JSON.parse(out[0]).error.message).toContain('removed in 4.0');
    expect(code).toBe(1);
  });

  it.each(SPELLINGS)('%s — `--human` moves the same refusal to STDERR', async (_l, argv, pointer) => {
    // The opposite polarity. Without it, "the envelope is on stdout" would also
    // pass for a command that writes to stdout unconditionally and has no human
    // mode at all.
    const { out, err, code } = await driven([...argv, '--human']);

    expect(out).toEqual([]);
    expect(err.join('\n')).toContain(pointer);
    expect(code).toBe(1);
  });

  it('says nothing about a missing API key — a removal needs no credential', async () => {
    // Measured against the built CLI: `cards update --board Q2-Dev --label
    // urgent` resolved the client FIRST and answered
    // `✗ API key not found. Run 'favro auth login' first` — a refusal naming the
    // wrong problem, on the one input whose whole job is to name the right one.
    for (const [, argv] of SPELLINGS) {
      const { out, err } = await driven(argv);
      const said = [...out, ...err].join('\n');
      expect(said).not.toContain('API key');
      expect(said).not.toContain('auth login');
    }
  });

  it('the batch GROUP refuses too, so an unknown subcommand is not a dead end', async () => {
    // `favro batch nonsense` was `error: unknown command 'nonsense'` — the exact
    // failure the stubs exist to remove, reached by a caller who guessed. The
    // group carries an action of its own now, which is what stops commander
    // falling through to `unknownCommand()`.
    for (const argv of [['batch'], ['batch', 'nonsense']]) {
      const { out, err, code } = await driven(argv);
      expect(err).toEqual([]);
      expect(JSON.parse(out[0]).error.message).toContain('cards update --from-csv');
      expect(code).toBe(1);
    }
  });

  it('the batch group DESCRIPTION still names the replacement, which help is read from', async () => {
    // `favro --help` and `favro batch --help` print the description, not the
    // action, so the pointer has to be in both places.
    const help = buildProgram()
      .commands.find((c) => c.name() === 'batch')!
      .helpInformation();

    expect(help).toContain('Removed in 4.0');
    expect(help).toContain('cards update --from-csv');
  });
});
