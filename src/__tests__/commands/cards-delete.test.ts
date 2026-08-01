/**
 * `favro cards delete` at the COMMANDER layer (#73).
 *
 * What the wire receives is pinned in `dispatch-tx-wire.test.ts` against the
 * `node:http` stand-in — including the absence of `?everywhere=true`, which is
 * the only thing on the wire that says this is an instance-scoped delete. This
 * file pins the one thing that lives above the table and nowhere else: the
 * confirmation, and that nothing is dispatched without it.
 *
 * `dispatch` is the seam mocked here on purpose. The observable being asserted
 * is "the delete never got as far as the table", and the table is exactly where
 * the wire assertions already live — a second stand-in here would test the same
 * DELETE twice and the prompt not at all.
 */
import { mkdtempSync } from 'fs';
import { rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

// FILE level, before any require that could read a real config. This is a
// DELETE command: no test in this file may be able to reach a live workspace.
const TMP = mkdtempSync(path.join(os.tmpdir(), 'favro-cards-delete-test-'));
const ORIGINAL_CONFIG_DIR = process.env.FAVRO_CONFIG_DIR;
process.env.FAVRO_CONFIG_DIR = TMP;

import { Command } from 'commander';
import { registerCardsDeleteCommand } from '../../commands/cards-delete';
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
  program.option('--verbose', 'Show stack traces');
  const cards = program.command('cards').description('Card operations');
  registerCardsDeleteCommand(cards);
  program.exitOverride();
  return program;
}

const runCli = (args: string[]) => buildProgram().parseAsync(['node', 'favro', ...args]);

let logSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  (safety.confirmAction as jest.Mock).mockResolvedValue(true);
  mockDispatch.mockResolvedValue({
    intent: 'delete',
    outcome: 'ok',
    retryable: false,
    value: { cardId: 'card-1', boardId: 'board-a' },
  });
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
});

afterEach(() => { jest.restoreAllMocks(); });

describe('favro cards delete', () => {
  it('takes <card>, not <cardId> — the reference goes to the table untouched', async () => {
    // A sequential reference, a cardId and a cardCommonId are all valid here;
    // the resolver behind the intent settles which. The command must not
    // pre-empt that by demanding one spelling.
    await runCli(['cards', 'delete', 'CLA-1804', '--yes']);

    expect(mockDispatch).toHaveBeenCalledWith('delete', { card: 'CLA-1804' }, expect.anything());
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('deleted'));
  });

  it('prompts, and dispatches nothing when the user declines', async () => {
    (safety.confirmAction as jest.Mock).mockResolvedValue(false);

    await runCli(['cards', 'delete', 'CLA-1804']);

    expect(safety.confirmAction).toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('Aborted.');
  });

  it('the prompt says it is one instance and cannot be undone', async () => {
    await runCli(['cards', 'delete', 'CLA-1804', '--yes']);

    const [prompt] = (safety.confirmAction as jest.Mock).mock.calls[0];
    expect(prompt).toMatch(/ONE board instance/);
    expect(prompt).toMatch(/CANNOT be undone/);
  });

  it('-y passes through as `yes`, so the prompt does not block', async () => {
    await runCli(['cards', 'delete', 'CLA-1804', '-y']);

    expect(safety.confirmAction).toHaveBeenCalledWith(expect.any(String), { yes: true });
    expect(mockDispatch).toHaveBeenCalled();
  });

  it('--dry-run previews without prompting — previewing is not writing', async () => {
    mockDispatch.mockResolvedValue({
      intent: 'delete',
      outcome: 'ok',
      retryable: false,
      preview: ['delete card CLA-1804'],
    });

    await runCli(['cards', 'delete', 'CLA-1804', '--dry-run']);

    expect(safety.confirmAction).not.toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith(
      'delete',
      { card: 'CLA-1804' },
      expect.objectContaining({ dryRun: true }),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[dry-run]'));
  });

  it('--force reaches the table, where the lock is — never a local bypass', async () => {
    await runCli(['cards', 'delete', 'CLA-1804', '-y', '--force']);

    expect(mockDispatch).toHaveBeenCalledWith(
      'delete',
      { card: 'CLA-1804' },
      expect.objectContaining({ force: true }),
    );
  });

  it('--help states the instance semantics and the boardless refusal', async () => {
    const cards = buildProgram().commands.find((c) => c.name() === 'cards')!;
    const help = cards.commands.find((c) => c.name() === 'delete')!.description();

    expect(help).toMatch(/ONE BOARD INSTANCE/);
    expect(help).toMatch(/everywhere=true/);
    expect(help).toMatch(/IRREVERSIBLE/);
    expect(help).toMatch(/--force does not rescue it/);
  });
});
