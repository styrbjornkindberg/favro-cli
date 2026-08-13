/**
 * `favro cards archive` / `cards unarchive` at the COMMANDER layer (#75).
 *
 * What the wire receives is pinned in `dispatch-tx-wire.test.ts` against the
 * `node:http` stand-in — including the fact that the body carries `archive` and
 * never the read-side `archived`, which is the whole hazard of this ticket. This
 * file pins what lives above the table and nowhere else: the confirmation, that
 * nothing is dispatched without it, and that the two spellings reach the ONE
 * intent with opposite directions.
 *
 * `dispatch` is the seam mocked here on purpose, exactly as in
 * `cards-delete.test.ts`. The observable is "the write never got as far as the
 * table", and the table is where the wire assertions already live.
 */
import { mkdtempSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

// FILE level, before any require that could read a real config. These commands
// WRITE: no test in this file may be able to reach a live workspace.
const TMP = mkdtempSync(path.join(os.tmpdir(), 'favro-cards-archive-test-'));
const ORIGINAL_CONFIG_DIR = process.env.FAVRO_CONFIG_DIR;
process.env.FAVRO_CONFIG_DIR = TMP;

import { Command } from 'commander';
import { registerCardsArchiveCommands } from '../../commands/cards-archive';
import * as safety from '../../lib/safety';
import * as dispatchModule from '../../lib/dispatch';

jest.mock('../../lib/http-client');
jest.mock('../../lib/client-factory');
jest.mock('../../lib/config');
jest.mock('../../lib/safety');
jest.mock('../../lib/dispatch');

const mockDispatch = dispatchModule.dispatch as jest.MockedFunction<typeof dispatchModule.dispatch>;

afterAll(() => {
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.FAVRO_CONFIG_DIR;
  else process.env.FAVRO_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
  rmSync(TMP, { recursive: true, force: true });
});

function buildProgram(): Command {
  const program = new Command();
  // `--human`/`--pretty` at the root: #119 put this command on `run()`, so JSON
  // is the default (ADR-0002) and the ✓ lines below live on the formatter.
  program.option('--human').option('--pretty').option('--verbose', 'Show stack traces');
  const cards = program.command('cards').description('Card operations');
  registerCardsArchiveCommands(cards);
  program.exitOverride();
  return program;
}

const runCli = (args: string[]) =>
  buildProgram().parseAsync(['node', 'favro', '--human', ...args]);

/** The machine path — the DEFAULT since #119. */
const runJson = (args: string[]) => buildProgram().parseAsync(['node', 'favro', ...args]);

let logSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  (safety.confirmAction as jest.Mock).mockResolvedValue(true);
  mockDispatch.mockResolvedValue({
    intent: 'archive',
    outcome: 'ok',
    retryable: false,
    value: { cardId: 'card-1', archived: true },
  });
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit must not be called under run()');
  }) as never);
});

afterEach(() => { jest.restoreAllMocks(); });

describe('favro cards archive / unarchive', () => {
  it('both spellings reach the ONE intent, with opposite directions', async () => {
    // Two CLI spellings, one wire op. A second intent name here would be a
    // second place for the guardrail to drift.
    await runCli(['cards', 'archive', 'CLA-1804', '--yes']);
    expect(mockDispatch).toHaveBeenCalledWith(
      'archive', { card: 'CLA-1804', archived: true }, expect.anything(),
    );

    jest.clearAllMocks();
    (safety.confirmAction as jest.Mock).mockResolvedValue(true);
    mockDispatch.mockResolvedValue({
      intent: 'archive', outcome: 'ok', retryable: false, value: { cardId: 'card-1', archived: false },
    });

    await runCli(['cards', 'unarchive', 'CLA-1804', '--yes']);
    expect(mockDispatch).toHaveBeenCalledWith(
      'archive', { card: 'CLA-1804', archived: false }, expect.anything(),
    );
  });

  it('takes <card>, not <cardId> — the reference goes to the table untouched', async () => {
    await runCli(['cards', 'archive', 'CLA-1804', '--yes']);

    expect(mockDispatch).toHaveBeenCalledWith('archive', { card: 'CLA-1804', archived: true }, expect.anything());
  });

  it('the success line names the side the TABLE reported, distinctly per direction', async () => {
    // `stringContaining('archived')` was the assertion here and could not tell
    // the two directions apart — 'un-archived' contains 'archived' — so hardcoding
    // the line to one direction passed. Anchored on the whole line instead, and
    // both directions are pinned, because this is the one line a human reads to
    // learn which side of the archive line the card ended up on.
    await runCli(['cards', 'archive', 'CLA-1804', '--yes']);
    expect(logSpy).toHaveBeenCalledWith('✓ Card card-1 is archived');
    expect(logSpy).not.toHaveBeenCalledWith('✓ Card card-1 is un-archived');

    jest.clearAllMocks();
    (safety.confirmAction as jest.Mock).mockResolvedValue(true);
    // The table's answer is the OBSERVED side (#75 finding 2), so the command
    // must print what it was handed and never re-derive it from the spelling the
    // user typed.
    mockDispatch.mockResolvedValue({
      intent: 'archive', outcome: 'ok', retryable: false, value: { cardId: 'card-1', archived: false },
    });

    await runCli(['cards', 'unarchive', 'CLA-1804', '--yes']);
    expect(logSpy).toHaveBeenCalledWith('✓ Card card-1 is un-archived');
    expect(logSpy).not.toHaveBeenCalledWith('✓ Card card-1 is archived');
  });

  it('prompts, and dispatches nothing when the user declines', async () => {
    (safety.confirmAction as jest.Mock).mockResolvedValue(false);

    await runCli(['cards', 'archive', 'CLA-1804']);

    expect(safety.confirmAction).toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('Aborted.');
  });

  it('unarchive prompts too — it is a write in its own right', async () => {
    (safety.confirmAction as jest.Mock).mockResolvedValue(false);

    await runCli(['cards', 'unarchive', 'CLA-1804']);

    expect(safety.confirmAction).toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('the prompt names the direction and says it is reversible', async () => {
    await runCli(['cards', 'archive', 'CLA-1804', '--yes']);

    const [prompt] = (safety.confirmAction as jest.Mock).mock.calls[0];
    expect(prompt).toMatch(/^Archive card CLA-1804\?/);
    expect(prompt).toMatch(/ONE board instance/);
    expect(prompt).toMatch(/cards unarchive CLA-1804/);
  });

  it('-y passes through as `yes`, so the prompt does not block', async () => {
    await runCli(['cards', 'archive', 'CLA-1804', '-y']);

    expect(safety.confirmAction).toHaveBeenCalledWith(expect.any(String), { yes: true });
    expect(mockDispatch).toHaveBeenCalled();
  });

  it('--dry-run previews without prompting and dispatches dryRun — previewing is not writing', async () => {
    mockDispatch.mockResolvedValue({
      intent: 'archive',
      outcome: 'ok',
      retryable: false,
      preview: ['archive card CLA-1804'],
    });

    await runCli(['cards', 'archive', 'CLA-1804', '--dry-run']);

    expect(safety.confirmAction).not.toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith(
      'archive',
      { card: 'CLA-1804', archived: true },
      expect.objectContaining({ dryRun: true }),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[dry-run]'));
  });

  it('--force reaches the table, where the lock is — never a local bypass', async () => {
    await runCli(['cards', 'unarchive', 'CLA-1804', '-y', '--force']);

    expect(mockDispatch).toHaveBeenCalledWith(
      'archive',
      { card: 'CLA-1804', archived: false },
      expect.objectContaining({ force: true }),
    );
  });

  it('--help records the archive-vs-archived asymmetry on both spellings', async () => {
    const cards = buildProgram().commands.find((c) => c.name() === 'cards')!;
    const help = (name: string) => cards.commands.find((c) => c.name() === name)!.description();

    for (const name of ['archive', 'unarchive']) {
      // The read-side spelling is the one a reader reaches for, so the help has
      // to say out loud that it writes nothing.
      expect(help(name)).toMatch(/PUT \{archived: true\} answers 200 and\nchanges nothing/);
      expect(help(name)).toMatch(/ONE BOARD INSTANCE/);
      expect(help(name)).toMatch(/--force does\nnot rescue it/);
    }
    expect(help('archive')).toMatch(/REVERSIBLE/);
  });
});
