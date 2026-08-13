/**
 * The 4.0 refusal stubs (#110).
 *
 * The point of keeping the commands registered is that an agent gets a NEXT
 * MOVE, so what has to be pinned is the whole of that: exit 1, and a message
 * naming the replacement — not merely that the command still exists.
 *
 * Driven through `buildProgram()` rather than by registering the module
 * directly, because the failure this guards is a commander-level one: without
 * `allowUnknownOption` the real invocation (`batch update --from-csv cards.csv`)
 * is answered `error: unknown option '--from-csv'` and the pointer never prints
 * — measured against the built CLI before those two lines existed.
 */
import { buildProgram } from '../../cli';
import { tempConfigDir } from '../../test-support/config-dir';

// No credentials anywhere near this: a removal needs no client, and the arms
// below are also what proves it.
tempConfigDir('favro-removed-config-');

/** Drive one invocation and collect both streams plus the exit code. */
async function driven(argv: string[]): Promise<{ said: string; code?: number }> {
  const out: string[] = [];
  let code: number | undefined;
  const log = jest.spyOn(console, 'log').mockImplementation((...a) => { out.push(String(a[0])); });
  const err = jest.spyOn(console, 'error').mockImplementation((...a) => { out.push(String(a[0])); });
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
  // The stubs are `run()`-migrated, so the runner sets `process.exitCode`
  // rather than exiting; the unmigrated `cards update` still hard-exits.
  code = code ?? (typeof process.exitCode === 'number' ? process.exitCode : undefined);
  process.exitCode = before;
  log.mockRestore();
  err.mockRestore();
  exit.mockRestore();
  return { said: out.join('\n'), code };
}

describe('every removed spelling exits 1 naming its replacement', () => {
  it.each([
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
  ])('%s', async (_label, argv, pointer) => {
    const { said, code } = await driven(argv as string[]);

    expect(code).toBe(1);
    expect(said).toContain('removed in 4.0');
    expect(said).toContain(pointer as string);
    // The failure this replaces. `unknown command` and `unknown option` are the
    // same dead end: an agent cannot tell a removal from a typo, so it retries
    // the same call spelled differently.
    expect(said).not.toContain('unknown command');
    expect(said).not.toContain('unknown option');
  });

  it('says nothing about a missing API key — a removal needs no credential', async () => {
    // Measured against the built CLI: `cards update --board Q2-Dev --label
    // urgent` resolved the client FIRST and answered
    // `✗ API key not found. Run 'favro auth login' first` — a refusal naming the
    // wrong problem, on the one input whose whole job is to name the right one.
    for (const argv of [
      ['cards', 'update', '--board', 'Q2-Dev', '--label', 'urgent', '--status', 'done', '--yes'],
      ['batch', 'update', '--from-csv', 'cards.csv'],
    ]) {
      const { said } = await driven(argv);
      expect(said).not.toContain('API key');
      expect(said).not.toContain('auth login');
    }
  });

  it('the batch GROUP with no subcommand still names the replacement', async () => {
    // `favro batch` prints commander's help, so the pointer has to be in the
    // group's description — otherwise the one invocation a confused caller is
    // most likely to try is the one that says nothing.
    const help = buildProgram()
      .commands.find((c) => c.name() === 'batch')!
      .helpInformation();

    expect(help).toContain('Removed in 4.0');
    expect(help).toContain('cards update --from-csv');
  });
});
