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
  // `clearAllMocks` clears CALLS, not implementations, so an arm that makes the
  // lock reject would leak into every arm after it. The routed writes take
  // `assertScope` rather than `checkScope`, so it needs the same reset (#109).
  (safety.assertScope as jest.Mock).mockResolvedValue(undefined);
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
  // `git sync` is routed through the `update` intent (#109), so the lock it takes
  // is the table's own `assertScope` and the write it makes is `moveColumn`'s
  // `PUT {columnId}` — Favro's status IS the column, and the intent translates
  // rather than forwarding `{status}`. The stand below has to move the card for
  // real, because `moveColumn` RE-READS the card and throws when it did not land
  // there; a stand that answered a static column would fail every arm here.
  const columnOf: Record<string, string | undefined> = {};
  const boardOf: Record<string, string> = { 'card-1': 'board-a', 'card-2': 'board-b' };

  beforeEach(() => {
    for (const key of Object.keys(columnOf)) delete columnOf[key];
    (gitIntegration.analyzeBranches as jest.Mock).mockReturnValue([
      { branch: 'feature/one', cardId: 'card-1', status: 'merged' },
      { branch: 'feature/two', cardId: 'card-2', status: 'open' },
    ]);
    MockCardsAPI.prototype.getCard = jest.fn().mockImplementation(async (id: string) => ({
      cardId: id,
      boardId: boardOf[id] ?? 'board-a',
      columnId: columnOf[id],
    }));
    MockCardsAPI.prototype.resolveColumnId = jest.fn(async (name: string) => `col-${name}`);
    MockCardsAPI.prototype.updateCard = jest.fn().mockImplementation(async (id: string, data: any) => {
      if (data.columnId !== undefined) columnOf[id] = data.columnId;
      return { cardId: id, ...data };
    });
  });

  it('checks scope for every target board before updating cards', async () => {
    await runCli(['git', 'sync', '--yes']);

    expect(safety.assertScope).toHaveBeenCalledWith('board-a', expect.anything(), expect.anything(), undefined);
    expect(safety.assertScope).toHaveBeenCalledWith('board-b', expect.anything(), expect.anything(), undefined);
    // The wire shape is a COLUMN write, not `{status}`.
    expect(MockCardsAPI.prototype.updateCard).toHaveBeenCalledWith('card-1', { columnId: 'col-Done' });
    expect(MockCardsAPI.prototype.updateCard).toHaveBeenCalledWith('card-2', { columnId: 'col-In Progress' });

    // Every scope check must precede every write — a straddling batch refuses whole.
    const lastCheck = Math.max(...(safety.assertScope as jest.Mock).mock.invocationCallOrder);
    const firstWrite = Math.min(...(MockCardsAPI.prototype.updateCard as jest.Mock).mock.invocationCallOrder);
    expect(lastCheck).toBeLessThan(firstWrite);
  });

  it('writes nothing when any target is out of scope', async () => {
    (safety.assertScope as jest.Mock).mockImplementation(async (boardId: string) => {
      if (boardId === 'board-b') throw new Error('out of scope');
    });

    await runCli(['git', 'sync', '--yes']);

    expect(MockCardsAPI.prototype.updateCard).not.toHaveBeenCalled();
  });

  it('forwards --force to the lock', async () => {
    await runCli(['git', 'sync', '--yes', '--force']);

    expect(safety.assertScope).toHaveBeenCalledWith('board-a', expect.anything(), expect.anything(), true);
  });

  it('dry-run checks scope for every target board, and still writes nothing', async () => {
    // It used to check NOTHING on this path — the guard sat below the `--dry-run`
    // return, so a repo whose branches point outside the lock planned the whole
    // sweep at exit 0 while the real run refused (#155). Both boards are checked
    // before the preview now, and since #109 that ordering is structural: the
    // table takes the lock before it returns a preview.
    await runCli(['git', 'sync', '--dry-run']);

    expect(safety.assertScope).toHaveBeenCalledWith('board-a', expect.anything(), expect.anything(), undefined);
    expect(safety.assertScope).toHaveBeenCalledWith('board-b', expect.anything(), expect.anything(), undefined);
    expect(MockCardsAPI.prototype.updateCard).not.toHaveBeenCalled();
  });

  it('a sync with nothing to move resolves nothing, even under a lock', async () => {
    // The second conjunct of the dry-run gate: a lock alone is not enough, there
    // has to be something to move. Every mapping here is `current`, so the
    // enumerated list is empty and no dispatch happens at all — which also keeps
    // the empty list away from `boundEntries`' empty-list refusal.
    (gitIntegration.analyzeBranches as jest.Mock).mockReturnValue([
      { branch: 'feature/one', cardId: 'card-1', status: 'current' },
    ]);

    await runCli(['git', 'sync', '--dry-run']);

    expect(safety.assertScope).not.toHaveBeenCalled();
    expect(MockCardsAPI.prototype.getCard).not.toHaveBeenCalled();
    expect(MockCardsAPI.prototype.updateCard).not.toHaveBeenCalled();
  });

  it('dry-run with NO lock configured checks nothing and resolves no card', async () => {
    // The gate, in the polarity that pays for it: the per-card GETs and the
    // credential are eager, so an unlocked `--dry-run` must stay free (#102/#104,
    // #135).
    (config.readConfig as jest.Mock).mockResolvedValue({});

    await runCli(['git', 'sync', '--dry-run']);

    expect(safety.assertScope).not.toHaveBeenCalled();
    expect(MockCardsAPI.prototype.getCard).not.toHaveBeenCalled();
    expect(MockCardsAPI.prototype.updateCard).not.toHaveBeenCalled();
  });

  it('a target card that cannot be read aborts the WHOLE sync, and writes nothing', async () => {
    // BEHAVIOUR CHANGE, #109, and the direction is deliberate. This used to
    // report "✗ Could not update card card-1" and sync the rest — a partial write
    // reported as a success count. The pass is one transaction now: the intent
    // resolves every entry's board before anything is written, so a card that
    // cannot be read takes the batch down with it and nothing is written at all.
    //
    // Under a configured lock the old code aborted here too, just later and for a
    // different reason: it handed `''` to `checkScope`, which refuses an
    // unresolvable board rather than exempting it. What changes is the UNLOCKED
    // case, which used to half-sync.
    MockCardsAPI.prototype.getCard = jest.fn().mockImplementation(async (id: string) => {
      if (id === 'card-1') throw new Error('404 Not Found');
      return { cardId: 'card-2', boardId: 'board-b', columnId: columnOf['card-2'] };
    });

    await runCli(['git', 'sync', '--yes']);

    expect(MockCardsAPI.prototype.updateCard).not.toHaveBeenCalled();
  });

  it('two branches on one card are ONE write, and one board is ONE check', async () => {
    (gitIntegration.analyzeBranches as jest.Mock).mockReturnValue([
      { branch: 'feature/one', cardId: 'card-1', status: 'merged' },
      { branch: 'feature/one-again', cardId: 'card-1', status: 'merged' },
      { branch: 'feature/two', cardId: 'card-2', status: 'open' },
    ]);
    boardOf['card-2'] = 'board-a';

    await runCli(['git', 'sync', '--yes']);

    // The duplicate branch is collapsed before the batch is built, so it neither
    // writes twice nor spends two of the twenty the cap allows.
    expect((MockCardsAPI.prototype.updateCard as jest.Mock).mock.calls.map((c) => c[0])).toEqual([
      'card-1',
      'card-2',
    ]);
    // Two cards, one board → the table de-duplicates the boards it checks.
    expect((safety.assertScope as jest.Mock).mock.calls.map((c) => c[0])).toEqual(['board-a']);
    boardOf['card-2'] = 'board-b';
  });

  it('refuses over the multi-write cap, naming it, and writes nothing', async () => {
    // Twenty-one card-linked branches. The cap lives in the intent, so it refuses
    // the batch WHOLE rather than moving the first twenty — and `boundEntries`
    // runs before the intent's first request, so the refusal costs nothing.
    const many = Array.from({ length: 21 }, (_, i) => ({
      branch: `feature/${i}`,
      cardId: `card-${i}`,
      status: 'merged',
    }));
    (gitIntegration.analyzeBranches as jest.Mock).mockReturnValue(many);

    await runCli(['git', 'sync', '--yes']);

    expect(MockCardsAPI.prototype.getCard).not.toHaveBeenCalled();
    expect(MockCardsAPI.prototype.updateCard).not.toHaveBeenCalled();
    const said = (console.error as unknown as jest.Mock).mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toMatch(/capped at 20/);
    expect(said).toMatch(/not a page size/);
    expect(process.exit).toHaveBeenCalledWith(1);
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
