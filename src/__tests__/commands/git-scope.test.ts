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
import BoardsAPI from '../../lib/boards-api';
import { RefusalError } from '../../lib/refusal';
import { passThroughScopeResolution } from '../../test-support/scope-passthrough';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../lib/safety');
jest.mock('../../lib/cards-api');
jest.mock('../../lib/boards-api');
jest.mock('../../lib/git-integration');
jest.mock('../../lib/todo-scanner');

const MockCardsAPI = CardsAPI as jest.MockedClass<typeof CardsAPI>;
const MockBoardsAPI = BoardsAPI as jest.MockedClass<typeof BoardsAPI>;

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
  (config.readConfig as jest.Mock).mockResolvedValue({ scopeCollectionId: 'coll-1' });
  (safety.checkScope as jest.Mock).mockResolvedValue(undefined);
  (safety.confirmAction as jest.Mock).mockResolvedValue(true);
  // `git todos --board` takes a NAME or an id (#82), so the board settles before
  // the lock sees it. `checkResolvedScope` IS that seam — auto-mocked it resolves
  // nothing and every assertion below would pass against a stub.
  passThroughScopeResolution(safety, config, MockCardsAPI as never);
  MockBoardsAPI.prototype.resolveBoardId = jest.fn(async (board: string) =>
    board === 'Backlog - Web Hub' ? 'board-z' : board,
  );

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

  it('dry-run checks scope for every target board, and still writes nothing', async () => {
    // It used to check NOTHING on this path — the guard sat below the `--dry-run`
    // return, so a repo whose branches point outside the lock planned the whole
    // sweep at exit 0 while the real run refused (#155). The title of this test
    // asserted that as correct. Both boards are checked before the preview now;
    // the "writes nothing" half is unchanged and still the point of `--dry-run`.
    await runCli(['git', 'sync', '--dry-run']);

    expect(safety.checkScope).toHaveBeenCalledWith('board-a', expect.anything(), expect.anything(), undefined);
    expect(safety.checkScope).toHaveBeenCalledWith('board-b', expect.anything(), expect.anything(), undefined);
    expect(MockCardsAPI.prototype.updateCard).not.toHaveBeenCalled();
  });

  it('a sync with nothing to move resolves nothing, even under a lock', async () => {
    // The second conjunct of the hoisted guard's condition (#155): a lock alone
    // is not enough, there has to be something to check. Every mapping here is
    // `current`, so `targets` is empty.
    //
    // This arm does NOT kill the deletion of `targets.length > 0` on its own,
    // measured: with the conjunct gone the loops still iterate empty sets, so
    // nothing here is called either way and the whole suite stayed green. What
    // the deletion changes is that the CLIENT gets constructed — a credential
    // demanded for a sync with nothing to sync — and the arm that fails on it is
    // `git sync with nothing to move needs no credential` in
    // `dry-run-scope-order-wire.test.ts`, where the credential is absent for
    // real. Kept as the cheap statement of intent next to the code it describes.
    (gitIntegration.analyzeBranches as jest.Mock).mockReturnValue([
      { branch: 'feature/one', cardId: 'card-1', status: 'current' },
    ]);

    await runCli(['git', 'sync', '--dry-run']);

    expect(safety.checkScope).not.toHaveBeenCalled();
    expect(MockCardsAPI.prototype.getCard).not.toHaveBeenCalled();
    expect(MockCardsAPI.prototype.updateCard).not.toHaveBeenCalled();
  });

  it('dry-run with NO lock configured checks nothing and resolves no card', async () => {
    // The gate, in the polarity that pays for it: the per-card GETs and the
    // credential are eager, so an unlocked `--dry-run` must stay free (#102/#104,
    // #135).
    (config.readConfig as jest.Mock).mockResolvedValue({});

    await runCli(['git', 'sync', '--dry-run']);

    expect(safety.checkScope).not.toHaveBeenCalled();
    expect(MockCardsAPI.prototype.getCard).not.toHaveBeenCalled();
    expect(MockCardsAPI.prototype.updateCard).not.toHaveBeenCalled();
  });

  it('does not abort the whole sync when one target card cannot be read', async () => {
    // A stale branch mapping pointing at a deleted card. The batch must still
    // run — the old behaviour printed "✗ Could not update card X" for the bad
    // one and synced the rest.
    //
    // A LOCK IS CONFIGURED here (the outer `beforeEach`), and since #155 that is
    // the only way this path is reachable at all: the resolve loop is gated on
    // the lock, so with nothing locked no card is read and there is no failure to
    // survive. `card-1` resolves to `''` and reaches the check fail-closed; the
    // check itself is a stub here, so what this arm pins is that the LOOP carries
    // on, not what the real refusal would do with `''`.
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

  it('a --board NAME settles to an id before the lock sees it (#82)', async () => {
    await runCli(['git', 'todos', '--create', '--yes', '--board', 'Backlog - Web Hub']);

    // The lock GETs `/widgets/<id>`; handed the name it 404s and reports
    // "Board Backlog - Web Hub not found" — the wrong problem, named confidently.
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

  it('dry-run takes the lock on the target board, and creates nothing', async () => {
    // The lock ran below the `--dry-run` return until #155, so
    // `git todos --board <outside-the-lock> --dry-run` printed `Would create N
    // cards on board <outside-the-lock>` and every card title at exit 0.
    await runCli(['git', 'todos', '--dry-run']);

    expect(safety.checkScope).toHaveBeenCalledWith('board-a', expect.anything(), expect.anything(), undefined);
    expect(MockCardsAPI.prototype.createCard).not.toHaveBeenCalled();
  });

  it('dry-run with NO lock configured takes nothing and resolves no board', async () => {
    (config.readConfig as jest.Mock).mockResolvedValue({});

    await runCli(['git', 'todos', '--dry-run']);

    expect(safety.checkScope).not.toHaveBeenCalled();
    expect(MockBoardsAPI.prototype.resolveBoardId).not.toHaveBeenCalled();
    expect(MockCardsAPI.prototype.createCard).not.toHaveBeenCalled();
  });
});

// ─── git commit --comment — the refusal must escape the best-effort catch ─────

/**
 * `git commit --comment` resolves its board inside a `catch` that reports
 * "(Could not add comment to card)" and carries on, because a failed comment is
 * not a failed commit. The scope check sits inside that catch.
 *
 * While the check called `process.exit(1)` the catch could not see it. #133 made
 * it THROW, and an unfiltered catch then downgraded the write guardrail to a
 * notice — measured on the built CLI under a lock: `(Could not add comment to
 * card)` and exit 0, where the same command had printed the violation and exited
 * 1. Nothing in 162 suites / 3070 tests failed on it, which is why this exists.
 *
 * Both polarities, and both on real bytes rather than on an absence alone: a
 * refusal reaches the outer boundary, an ordinary failure still does not.
 */
describe('favro git commit --comment — a refusal is not a failed comment', () => {
  const NOTICE = '  (Could not add comment to card)';
  const logged = (): string =>
    (console.log as unknown as jest.Mock).mock.calls.map((c) => String(c[0])).join('\n');
  const errored = (): string =>
    (console.error as unknown as jest.Mock).mock.calls.map((c) => String(c[0])).join('\n');

  beforeEach(() => {
    (gitIntegration.hasStagedChanges as jest.Mock).mockReturnValue(true);
    (gitIntegration.getCurrentBranch as jest.Mock).mockReturnValue('feature/card-1-x');
    (gitIntegration.commitWithMessage as jest.Mock).mockReturnValue('abc1234');
    MockCardsAPI.prototype.getCard = jest
      .fn()
      .mockResolvedValue({ cardId: 'card-1', boardId: 'board-out' });
  });

  it('exits 1 and reports the violation rather than "could not add comment"', async () => {
    (safety.checkScope as jest.Mock).mockRejectedValue(
      Object.assign(new RefusalError('Scope violation: board "board-out" is outside the lock.'), {
        name: 'ScopeError',
      }),
    );

    await runCli(['git', 'commit', '-m', 'msg', '--card', 'card-1', '--comment']);

    expect(errored()).toContain('Scope violation: board "board-out" is outside the lock.');
    expect(logged()).not.toContain(NOTICE);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('still swallows an ORDINARY comment failure, exit code untouched', async () => {
    // The foreign arm. Rethrowing everything would turn a 500 on the comment
    // POST into a failed commit, which is the behaviour this catch exists to
    // prevent — so the filter has to be a filter, not a removal.
    (safety.checkScope as jest.Mock).mockRejectedValue(new Error('socket hang up'));

    await runCli(['git', 'commit', '-m', 'msg', '--card', 'card-1', '--comment']);

    expect(logged()).toContain(NOTICE);
    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it('takes the lock at all on this path — and only under a lock', async () => {
    // The omit arm, and the guard against the two arms above passing against a
    // `checkResolvedScope` that refuses unconditionally. `--comment` is the only
    // Favro write here, so with no lock configured nothing is checked and no
    // card is read.
    (config.readConfig as jest.Mock).mockResolvedValue({});

    await runCli(['git', 'commit', '-m', 'msg', '--card', 'card-1', '--comment']);

    expect(safety.checkScope).not.toHaveBeenCalled();
    expect(MockCardsAPI.prototype.getCard).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalledWith(1);
  });
});
