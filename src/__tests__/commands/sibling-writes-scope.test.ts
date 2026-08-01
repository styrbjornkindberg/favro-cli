/**
 * Unit tests — scope lock on the three sibling writes (issue #104)
 *
 * Each of these is the unlocked twin of a command locked in 32e6b93:
 *   `batch update --from-csv`  twin of `cards update --from-csv` (#79)
 *   `git branch <card>`        twin of `git sync` (#78)
 *   `git commit --comment`     twin of `git sync` (#78)
 *
 * Same contract as the siblings: every DISTINCT board resolved and checked
 * before the FIRST write, nothing written when any one target refuses, `--force`
 * forwarded as the 4th argument, and a resolving GET that rejects reaching the
 * shared check as `''` rather than killing the command.
 */
import { Command } from 'commander';
import { registerGitCommands } from '../../commands/git';
import { registerBatchUpdateCommand } from '../../commands/batch';
import * as config from '../../lib/config';
import * as safety from '../../lib/safety';
import * as gitIntegration from '../../lib/git-integration';
import * as fsPromises from 'fs/promises';
import CardsAPI from '../../lib/cards-api';
import { CommentsApiClient } from '../../api/comments';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../lib/safety');
jest.mock('../../lib/cards-api');
jest.mock('../../lib/git-integration');
jest.mock('../../lib/todo-scanner');
jest.mock('../../api/comments');
jest.mock('fs/promises');

const MockCardsAPI = CardsAPI as jest.MockedClass<typeof CardsAPI>;
const MockComments = CommentsApiClient as jest.MockedClass<typeof CommentsApiClient>;
const mockReadFile = fsPromises.readFile as jest.MockedFunction<typeof fsPromises.readFile>;

async function runGit(args: string[]): Promise<void> {
  const program = new Command();
  program.option('--verbose', 'Show stack traces');
  registerGitCommands(program);
  program.exitOverride();
  await program.parseAsync(['node', 'favro', ...args]);
}

async function runBatch(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  const batch = program.command('batch');
  registerBatchUpdateCommand(batch);
  await program.parseAsync(['node', 'favro', 'batch', ...args]);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  (config.readConfig as jest.Mock).mockResolvedValue({ scopeCollectionId: 'col-1' });
  (safety.checkScope as jest.Mock).mockResolvedValue(undefined);
  (safety.confirmAction as jest.Mock).mockResolvedValue(true);

  (gitIntegration.isGitRepo as jest.Mock).mockReturnValue(true);
  (gitIntegration.readProjectConfig as jest.Mock).mockReturnValue({ boardId: 'board-a', branches: {} });
  (gitIntegration.generateBranchName as jest.Mock).mockReturnValue('feature/card-1-thing');
  (gitIntegration.createBranch as jest.Mock).mockReturnValue(undefined);
  (gitIntegration.writeProjectConfig as jest.Mock).mockReturnValue('/repo/.favro.json');
  (gitIntegration.hasStagedChanges as jest.Mock).mockReturnValue(true);
  (gitIntegration.getCurrentBranch as jest.Mock).mockReturnValue('feature/card-1-thing');
  (gitIntegration.commitWithMessage as jest.Mock).mockReturnValue('abc1234');
  (gitIntegration.extractCardIdFromBranch as jest.Mock).mockReturnValue('card-1');

  MockCardsAPI.prototype.getCard = jest.fn().mockResolvedValue({ cardId: 'card-1', name: 'Thing', boardId: 'board-a' });
  MockCardsAPI.prototype.updateCard = jest.fn().mockResolvedValue({});
  MockComments.prototype.addComment = jest.fn().mockResolvedValue({});
});

afterEach(() => { jest.restoreAllMocks(); });

// ---------------------------------------------------------------------------
// git branch <card>
// ---------------------------------------------------------------------------

describe('favro git branch <card> — scope lock', () => {
  it('checks the card\'s board before moving the card', async () => {
    await runGit(['git', 'branch', 'card-1', '--yes']);

    expect(safety.checkScope).toHaveBeenCalledWith('board-a', expect.anything(), expect.anything(), undefined);
    expect(MockCardsAPI.prototype.updateCard).toHaveBeenCalledWith('card-1', { status: 'In Progress' });

    const lastCheck = Math.max(...(safety.checkScope as jest.Mock).mock.invocationCallOrder);
    const firstWrite = Math.min(...(MockCardsAPI.prototype.updateCard as jest.Mock).mock.invocationCallOrder);
    expect(lastCheck).toBeLessThan(firstWrite);
  });

  it('writes nothing when the board is out of scope', async () => {
    (safety.checkScope as jest.Mock).mockRejectedValue(new Error('out of scope'));

    await runGit(['git', 'branch', 'card-1', '--yes']);

    expect(MockCardsAPI.prototype.updateCard).not.toHaveBeenCalled();
    expect(gitIntegration.createBranch).not.toHaveBeenCalled();
  });

  it('forwards --force to checkScope', async () => {
    await runGit(['git', 'branch', 'card-1', '--yes', '--force']);

    expect(safety.checkScope).toHaveBeenCalledWith('board-a', expect.anything(), expect.anything(), true);
  });

  it('a card that cannot be read still reaches the check as an empty board', async () => {
    MockCardsAPI.prototype.getCard = jest.fn().mockRejectedValue(new Error('404 Not Found'));

    await expect(runGit(['git', 'branch', 'card-1', '--yes'])).resolves.toBeUndefined();

    expect(safety.checkScope).toHaveBeenCalledWith('', expect.anything(), expect.anything(), undefined);
    expect(MockCardsAPI.prototype.updateCard).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// git commit --comment
// ---------------------------------------------------------------------------

describe('favro git commit --comment — scope lock', () => {
  it('checks the card\'s board before adding the comment', async () => {
    await runGit(['git', 'commit', '-m', 'msg', '--card', 'card-1', '--comment']);

    expect(safety.checkScope).toHaveBeenCalledWith('board-a', expect.anything(), expect.anything(), undefined);
    expect(MockComments.prototype.addComment).toHaveBeenCalled();

    const lastCheck = Math.max(...(safety.checkScope as jest.Mock).mock.invocationCallOrder);
    const firstWrite = Math.min(...(MockComments.prototype.addComment as jest.Mock).mock.invocationCallOrder);
    expect(lastCheck).toBeLessThan(firstWrite);
  });

  it('writes no comment when the board is out of scope', async () => {
    (safety.checkScope as jest.Mock).mockRejectedValue(new Error('out of scope'));

    await runGit(['git', 'commit', '-m', 'msg', '--card', 'card-1', '--comment']);

    expect(MockComments.prototype.addComment).not.toHaveBeenCalled();
  });

  it('forwards --force to checkScope', async () => {
    await runGit(['git', 'commit', '-m', 'msg', '--card', 'card-1', '--comment', '--force']);

    expect(safety.checkScope).toHaveBeenCalledWith('board-a', expect.anything(), expect.anything(), true);
  });

  it('a card that cannot be read still reaches the check as an empty board', async () => {
    MockCardsAPI.prototype.getCard = jest.fn().mockRejectedValue(new Error('404 Not Found'));

    await expect(
      runGit(['git', 'commit', '-m', 'msg', '--card', 'card-1', '--comment'])
    ).resolves.toBeUndefined();

    expect(safety.checkScope).toHaveBeenCalledWith('', expect.anything(), expect.anything(), undefined);
  });

  it('takes no lock when --comment is not passed (no Favro write)', async () => {
    await runGit(['git', 'commit', '-m', 'msg', '--card', 'card-1']);

    expect(safety.checkScope).not.toHaveBeenCalled();
    expect(MockComments.prototype.addComment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// batch update --from-csv
// ---------------------------------------------------------------------------

describe('favro batch update --from-csv — scope lock', () => {
  beforeEach(() => {
    MockCardsAPI.prototype.getCard = jest.fn().mockImplementation(async (id: string) => ({
      cardId: id,
      name: id,
      boardId: id === 'card-2' ? 'board-b' : 'board-a',
    }));
  });

  it('checks every distinct board before the first write', async () => {
    mockReadFile.mockResolvedValue('card_id,status\ncard-1,Done\ncard-2,In Progress' as any);

    await runBatch(['update', '--from-csv', 'cards.csv', '--yes']);

    expect(safety.checkScope).toHaveBeenCalledWith('board-a', expect.anything(), expect.anything(), undefined);
    expect(safety.checkScope).toHaveBeenCalledWith('board-b', expect.anything(), expect.anything(), undefined);
    expect(MockCardsAPI.prototype.updateCard).toHaveBeenCalledTimes(2);

    const lastCheck = Math.max(...(safety.checkScope as jest.Mock).mock.invocationCallOrder);
    const firstWrite = Math.min(...(MockCardsAPI.prototype.updateCard as jest.Mock).mock.invocationCallOrder);
    expect(lastCheck).toBeLessThan(firstWrite);
  });

  it('writes nothing when any one row is out of scope', async () => {
    mockReadFile.mockResolvedValue('card_id,status\ncard-1,Done\ncard-2,In Progress' as any);
    (safety.checkScope as jest.Mock).mockImplementation(async (boardId: string) => {
      if (boardId === 'board-b') throw new Error('out of scope');
    });

    await runBatch(['update', '--from-csv', 'cards.csv', '--yes']);

    expect(MockCardsAPI.prototype.updateCard).not.toHaveBeenCalled();
  });

  it('forwards --force to checkScope', async () => {
    mockReadFile.mockResolvedValue('card_id,status\ncard-1,Done' as any);

    await runBatch(['update', '--from-csv', 'cards.csv', '--yes', '--force']);

    expect(safety.checkScope).toHaveBeenCalledWith('board-a', expect.anything(), expect.anything(), true);
  });

  it('a row whose card cannot be read still reaches the check as an empty board', async () => {
    mockReadFile.mockResolvedValue('card_id,status\ncard-1,Done' as any);
    MockCardsAPI.prototype.getCard = jest.fn().mockRejectedValue(new Error('404 Not Found'));

    await expect(runBatch(['update', '--from-csv', 'cards.csv', '--yes'])).resolves.toBeUndefined();

    expect(safety.checkScope).toHaveBeenCalledWith('', expect.anything(), expect.anything(), undefined);
  });

  it('two rows on the same board produce ONE check', async () => {
    mockReadFile.mockResolvedValue('card_id,status\ncard-1,Done\ncard-3,Done' as any);

    await runBatch(['update', '--from-csv', 'cards.csv', '--yes']);

    expect((safety.checkScope as jest.Mock).mock.calls.map((c) => c[0])).toEqual(['board-a']);
  });

  it('two rows on different boards produce two checks, both before the first write', async () => {
    mockReadFile.mockResolvedValue('card_id,status\ncard-1,Done\ncard-2,Done' as any);

    await runBatch(['update', '--from-csv', 'cards.csv', '--yes']);

    expect((safety.checkScope as jest.Mock).mock.calls.map((c) => c[0])).toEqual(['board-a', 'board-b']);
    const lastCheck = Math.max(...(safety.checkScope as jest.Mock).mock.invocationCallOrder);
    const firstWrite = Math.min(...(MockCardsAPI.prototype.updateCard as jest.Mock).mock.invocationCallOrder);
    expect(lastCheck).toBeLessThan(firstWrite);
  });
});
