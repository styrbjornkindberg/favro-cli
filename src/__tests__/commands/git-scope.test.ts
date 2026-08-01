/**
 * Unit tests — scope lock on the `git` write paths (issue #78)
 *
 * `git sync` and `git todos --create` both write cards; both must take the
 * scope lock before any write happens.
 */
import { Command } from 'commander';
import { registerGitCommands } from '../../commands/git';
import * as config from '../../lib/config';
import * as safety from '../../lib/safety';
import * as gitIntegration from '../../lib/git-integration';
import * as todoScanner from '../../lib/todo-scanner';
import CardsAPI from '../../lib/cards-api';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../lib/safety');
jest.mock('../../lib/cards-api');
jest.mock('../../lib/git-integration');
jest.mock('../../lib/todo-scanner');

const MockCardsAPI = CardsAPI as jest.MockedClass<typeof CardsAPI>;

async function runCli(args: string[]): Promise<void> {
  const program = new Command();
  program.option('--verbose', 'Show stack traces');
  registerGitCommands(program);
  program.exitOverride();
  await program.parseAsync(['node', 'favro', ...args]);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  (config.readConfig as jest.Mock).mockResolvedValue({ scopeBoardId: 'board-a' });
  (safety.checkScope as jest.Mock).mockResolvedValue(undefined);
  (safety.confirmAction as jest.Mock).mockResolvedValue(true);

  (gitIntegration.isGitRepo as jest.Mock).mockReturnValue(true);
  (gitIntegration.findProjectRoot as jest.Mock).mockReturnValue('/repo');
  (gitIntegration.readProjectConfig as jest.Mock).mockReturnValue({ boardId: 'board-a' });
});

afterEach(() => { jest.restoreAllMocks(); });

describe('favro git sync — scope lock', () => {
  beforeEach(() => {
    (gitIntegration.analyzeBranches as jest.Mock).mockReturnValue([
      { branch: 'feature/one', cardId: 'card-1', status: 'merged' },
      { branch: 'feature/two', cardId: 'card-2', status: 'open' },
    ]);
    MockCardsAPI.prototype.getCard = jest.fn().mockImplementation(async (id: string) =>
      id === 'card-1' ? { cardId: 'card-1', boardId: 'board-a' } : { cardId: 'card-2', boardId: 'board-b' }
    );
    MockCardsAPI.prototype.updateCard = jest.fn().mockResolvedValue({});
  });

  it('checks scope for every target board before updating cards', async () => {
    await runCli(['git', 'sync', '--yes']);

    expect(safety.checkScope).toHaveBeenCalledWith('board-a', expect.anything(), expect.anything(), undefined);
    expect(safety.checkScope).toHaveBeenCalledWith('board-b', expect.anything(), expect.anything(), undefined);
    expect(MockCardsAPI.prototype.updateCard).toHaveBeenCalledWith('card-1', { status: 'Done' });
    expect(MockCardsAPI.prototype.updateCard).toHaveBeenCalledWith('card-2', { status: 'In Progress' });

    // Every scope check must precede every write — a straddling batch refuses whole.
    const lastCheck = Math.max(...(safety.checkScope as jest.Mock).mock.invocationCallOrder);
    const firstWrite = Math.min(...(MockCardsAPI.prototype.updateCard as jest.Mock).mock.invocationCallOrder);
    expect(lastCheck).toBeLessThan(firstWrite);
  });

  it('writes nothing when any target is out of scope', async () => {
    (safety.checkScope as jest.Mock).mockImplementation(async (boardId: string) => {
      if (boardId === 'board-b') throw new Error('out of scope');
    });

    await runCli(['git', 'sync', '--yes']);

    expect(MockCardsAPI.prototype.updateCard).not.toHaveBeenCalled();
  });

  it('forwards --force to checkScope', async () => {
    await runCli(['git', 'sync', '--yes', '--force']);

    expect(safety.checkScope).toHaveBeenCalledWith('board-a', expect.anything(), expect.anything(), true);
  });

  it('dry-run neither checks scope nor writes', async () => {
    await runCli(['git', 'sync', '--dry-run']);

    expect(MockCardsAPI.prototype.updateCard).not.toHaveBeenCalled();
  });

  it('does not abort the whole sync when one target card cannot be read', async () => {
    // A stale branch mapping pointing at a deleted card. With no lock
    // configured this is a no-op, and the batch must still run — the old
    // behaviour printed "✗ Could not update card X" for the bad one and synced
    // the rest.
    MockCardsAPI.prototype.getCard = jest.fn().mockImplementation(async (id: string) => {
      if (id === 'card-1') throw new Error('404 Not Found');
      return { cardId: 'card-2', boardId: 'board-b' };
    });

    await runCli(['git', 'sync', '--yes']);

    expect(safety.checkScope).toHaveBeenCalledWith('', expect.anything(), expect.anything(), undefined);
    expect(MockCardsAPI.prototype.updateCard).toHaveBeenCalledWith('card-2', { status: 'In Progress' });
    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it('resolves each card once and checks each DISTINCT board once', async () => {
    (gitIntegration.analyzeBranches as jest.Mock).mockReturnValue([
      { branch: 'feature/one', cardId: 'card-1', status: 'merged' },
      { branch: 'feature/one-again', cardId: 'card-1', status: 'merged' },
      { branch: 'feature/two', cardId: 'card-2', status: 'open' },
    ]);
    MockCardsAPI.prototype.getCard = jest.fn().mockImplementation(async (id: string) => ({
      cardId: id,
      boardId: 'board-a',
    }));

    await runCli(['git', 'sync', '--yes']);

    // Two branches, one card → one GET. Two cards, one board → one check.
    expect((MockCardsAPI.prototype.getCard as jest.Mock).mock.calls.map((c) => c[0])).toEqual([
      'card-1',
      'card-2',
    ]);
    expect((safety.checkScope as jest.Mock).mock.calls.map((c) => c[0])).toEqual(['board-a']);
  });
});

describe('favro git todos --create — scope lock', () => {
  beforeEach(() => {
    (todoScanner.scanTodos as jest.Mock).mockReturnValue([
      { file: 'src/a.ts', line: 3, type: 'TODO', text: 'fix me' },
    ]);
    (todoScanner.groupByFile as jest.Mock).mockReturnValue([
      { file: 'src/a.ts', items: [{ file: 'src/a.ts', line: 3, type: 'TODO', text: 'fix me' }] },
    ]);
    (todoScanner.todoToCardTitle as jest.Mock).mockReturnValue('TODO: fix me');
    (todoScanner.formatTodoAsCardDescription as jest.Mock).mockReturnValue('description');
    MockCardsAPI.prototype.createCard = jest.fn().mockResolvedValue({ cardId: 'new-1' });
  });

  it('checks scope for the target board before creating cards', async () => {
    await runCli(['git', 'todos', '--create', '--yes']);

    expect(safety.checkScope).toHaveBeenCalledWith('board-a', expect.anything(), expect.anything(), undefined);
    expect(MockCardsAPI.prototype.createCard).toHaveBeenCalled();

    const check = (safety.checkScope as jest.Mock).mock.invocationCallOrder[0];
    const write = (MockCardsAPI.prototype.createCard as jest.Mock).mock.invocationCallOrder[0];
    expect(check).toBeLessThan(write);
  });

  it('checks scope against --board when given', async () => {
    await runCli(['git', 'todos', '--create', '--yes', '--board', 'board-z']);

    expect(safety.checkScope).toHaveBeenCalledWith('board-z', expect.anything(), expect.anything(), undefined);
  });

  it('creates nothing when the board is out of scope', async () => {
    (safety.checkScope as jest.Mock).mockRejectedValue(new Error('out of scope'));

    await runCli(['git', 'todos', '--create', '--yes']);

    expect(MockCardsAPI.prototype.createCard).not.toHaveBeenCalled();
  });

  it('forwards --force to checkScope', async () => {
    await runCli(['git', 'todos', '--create', '--yes', '--force']);

    expect(safety.checkScope).toHaveBeenCalledWith('board-a', expect.anything(), expect.anything(), true);
  });

  it('checks scope BEFORE asking the user to confirm the create', async () => {
    await runCli(['git', 'todos', '--create', '--yes']);

    const check = (safety.checkScope as jest.Mock).mock.invocationCallOrder[0];
    const confirm = (safety.confirmAction as jest.Mock).mock.invocationCallOrder[0];
    expect(check).toBeLessThan(confirm);
  });

  it('dry-run creates nothing', async () => {
    await runCli(['git', 'todos', '--dry-run']);

    expect(MockCardsAPI.prototype.createCard).not.toHaveBeenCalled();
  });
});
