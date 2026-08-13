/**
 * Unit tests — scope lock on the sibling writes (issue #104)
 *
 * Each of these is the unlocked twin of a command locked in 32e6b93:
 *   `git branch <card>`        twin of `git sync` (#78)
 *   `git commit --comment`     twin of `git sync` (#78)
 *
 * `batch update --from-csv` was the third, and it is gone: #110 deleted the
 * command. Its twin `cards update --from-csv` survives and keeps the arms, now
 * against the intent's own `assertScope`, in `cli-cards-csv-scope.test.ts`.
 *
 * Same contract as the siblings: every DISTINCT board resolved and checked
 * before the FIRST write, nothing written when any one target refuses, `--force`
 * forwarded as the 4th argument, and a resolving GET that rejects reaching the
 * shared check as `''` rather than killing the command.
 */
import { Command } from 'commander';
import { registerGitCommands } from '../../commands/git';
import * as config from '../../lib/config';
import * as safety from '../../lib/safety';
import * as gitIntegration from '../../lib/git-integration';
import CardsAPI from '../../lib/cards-api';
import { passThroughScopeResolution } from '../../test-support/scope-passthrough';
import { CommentsApiClient } from '../../api/comments';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../lib/safety');
jest.mock('../../lib/cards-api');
jest.mock('../../lib/git-integration');
jest.mock('../../lib/todo-scanner');
jest.mock('../../api/comments');

const MockCardsAPI = CardsAPI as jest.MockedClass<typeof CardsAPI>;
const MockComments = CommentsApiClient as jest.MockedClass<typeof CommentsApiClient>;

async function runGit(args: string[]): Promise<void> {
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
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  (config.readConfig as jest.Mock).mockResolvedValue({ scopeCollectionId: 'col-1' });
  passThroughScopeResolution(safety, config, MockCardsAPI);
  (safety.checkScope as jest.Mock).mockResolvedValue(undefined);
  // `clearAllMocks` clears CALLS, not implementations, so an arm that makes the
  // lock reject would leak into every arm after it. The routed writes take
  // `assertScope` rather than `checkScope`, so it needs the same reset (#109).
  (safety.assertScope as jest.Mock).mockResolvedValue(undefined);
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
  // Routed through the `update` intent (#109), so the lock is the table's own
  // `assertScope` and the write is `moveColumn`'s `PUT {columnId}` — Favro's
  // status IS the column. The stand has to MOVE the card, because `moveColumn`
  // re-reads it and throws when it did not land there.
  let column: string | undefined;
  beforeEach(() => {
    column = undefined;
    MockCardsAPI.prototype.getCard = jest.fn().mockImplementation(async () => ({
      cardId: 'card-1', name: 'Thing', boardId: 'board-a', columnId: column,
    }));
    MockCardsAPI.prototype.resolveColumnId = jest.fn(async (name: string) => `col-${name}`);
    MockCardsAPI.prototype.updateCard = jest.fn().mockImplementation(async (id: string, data: any) => {
      if (data.columnId !== undefined) column = data.columnId;
      return { cardId: id, ...data };
    });
  });

  it('checks the card\'s board before moving the card', async () => {
    await runGit(['git', 'branch', 'card-1', '--yes']);

    expect(safety.assertScope).toHaveBeenCalledWith('board-a', expect.anything(), expect.anything(), undefined);
    expect(MockCardsAPI.prototype.updateCard).toHaveBeenCalledWith('card-1', { columnId: 'col-In Progress' });

    const lastCheck = Math.max(...(safety.assertScope as jest.Mock).mock.invocationCallOrder);
    const firstWrite = Math.min(...(MockCardsAPI.prototype.updateCard as jest.Mock).mock.invocationCallOrder);
    expect(lastCheck).toBeLessThan(firstWrite);
  });

  it('writes nothing — and creates no branch — when the board is out of scope', async () => {
    // The branch must not exist either. The lock is inside the intent now, so the
    // ordering is bought by dispatching the SAME intent with `dryRun` before the
    // confirm: it takes the lock and returns without writing.
    (safety.assertScope as jest.Mock).mockRejectedValue(new Error('out of scope'));

    await runGit(['git', 'branch', 'card-1', '--yes']);

    expect(MockCardsAPI.prototype.updateCard).not.toHaveBeenCalled();
    expect(gitIntegration.createBranch).not.toHaveBeenCalled();
  });

  it('forwards --force to the lock', async () => {
    await runGit(['git', 'branch', 'card-1', '--yes', '--force']);

    expect(safety.assertScope).toHaveBeenCalledWith('board-a', expect.anything(), expect.anything(), true);
  });

  it('a card that cannot be read refuses before the branch exists', async () => {
    // It used to resolve `''` and hand that to `checkScope`, which refuses an
    // unresolvable board. The intent makes the read itself, so the refusal is now
    // the wire's own error — still before the branch, still nothing written, and
    // it names the real problem instead of "this write names no board".
    MockCardsAPI.prototype.getCard = jest.fn().mockRejectedValue(new Error('404 Not Found'));

    await expect(runGit(['git', 'branch', 'card-1', '--yes'])).resolves.toBeUndefined();

    expect(MockCardsAPI.prototype.updateCard).not.toHaveBeenCalled();
    expect(gitIntegration.createBranch).not.toHaveBeenCalled();
  });

  it('with NO lock configured it makes no pre-flight dispatch', async () => {
    // The pre-flight dispatch is gated on a configured lock, like every sibling
    // hoist in `git.ts`: with nothing locked there is no verdict to produce, so
    // the extra card read it costs is not charged. The WRITE still dispatches, so
    // the table still reaches `assertScope` — which returns immediately when
    // nothing is locked — and that one call is the difference this pins: two
    // under a lock, one without.
    (config.readConfig as jest.Mock).mockResolvedValue({});

    await runGit(['git', 'branch', 'card-1', '--yes']);

    expect((safety.assertScope as jest.Mock).mock.calls).toHaveLength(1);
    expect(gitIntegration.createBranch).toHaveBeenCalled();
    expect(MockCardsAPI.prototype.updateCard).toHaveBeenCalledWith('card-1', { columnId: 'col-In Progress' });
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
