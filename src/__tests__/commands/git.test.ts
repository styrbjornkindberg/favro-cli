/**
 * `favro git link|branch|commit|sync|todos` — behaviour (#100).
 *
 * The scope lock on `git sync` and `git todos --create` is covered by
 * `git-scope.test.ts` (#78). This file covers what that one does not: the
 * git-repo and staged-changes guards, the card-id resolution ladder behind
 * `git commit`, the branch → card mapping `git branch` persists, and what each
 * subcommand actually prints.
 */
import { Command } from 'commander';
import { registerGitCommands } from '../../commands/git';
import * as config from '../../lib/config';
import * as safety from '../../lib/safety';
import * as gitIntegration from '../../lib/git-integration';
import * as todoScanner from '../../lib/todo-scanner';
import CardsAPI from '../../lib/cards-api';
import BoardsAPI from '../../lib/boards-api';
import { CommentsApiClient } from '../../api/comments';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../lib/safety');
jest.mock('../../lib/cards-api');
jest.mock('../../lib/boards-api');
jest.mock('../../api/comments');
jest.mock('../../lib/git-integration');
jest.mock('../../lib/todo-scanner');

const MockCardsAPI = CardsAPI as jest.MockedClass<typeof CardsAPI>;
const MockBoardsAPI = BoardsAPI as jest.MockedClass<typeof BoardsAPI>;
const MockComments = CommentsApiClient as jest.MockedClass<typeof CommentsApiClient>;

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
let exitSpy: jest.SpyInstance;

/**
 * `process.exit` really does stop the action. A stub that returns lets the code
 * after a guard keep running, which would let "refuse and exit 1" pass while
 * the write it was guarding still happened.
 */
class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

async function runCli(args: string[]): Promise<void> {
  const program = new Command();
  program.option('--verbose', 'Show stack traces');
  registerGitCommands(program);
  program.exitOverride();
  await program.parseAsync(['node', 'favro', ...args]).catch((e) => {
    if (!(e instanceof ExitCalled)) throw e;
  });
}

const output = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const errors = () => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');

beforeEach(() => {
  jest.clearAllMocks();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code ?? 0);
  }) as never);

  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  (config.readConfig as jest.Mock).mockResolvedValue({});
  (safety.checkScope as jest.Mock).mockResolvedValue(undefined);
  (safety.checkResolvedScope as jest.Mock).mockResolvedValue(undefined);
  (safety.confirmAction as jest.Mock).mockResolvedValue(true);

  (gitIntegration.isGitRepo as jest.Mock).mockReturnValue(true);
  (gitIntegration.findProjectRoot as jest.Mock).mockReturnValue('/repo');
  (gitIntegration.readProjectConfig as jest.Mock).mockReturnValue({ boardId: 'board-a' });
  (gitIntegration.writeProjectConfig as jest.Mock).mockReturnValue('/repo/.favro/project.json');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('git link', () => {
  beforeEach(() => {
    MockBoardsAPI.prototype.getBoard = jest.fn().mockResolvedValue({ boardId: 'board-a', name: 'Platform' });
  });

  test('verifies the board before writing the project config, and stores its name', async () => {
    await runCli(['git', 'link', '--board', 'board-a', '--prefix', 'CARD']);

    expect(MockBoardsAPI.prototype.getBoard).toHaveBeenCalledWith('board-a');
    expect(gitIntegration.writeProjectConfig).toHaveBeenCalledWith(
      expect.objectContaining({ boardId: 'board-a', boardName: 'Platform', cardPrefix: 'CARD', branches: {} }),
    );
    expect(output()).toContain('✓ Linked to board: Platform (board-a)');
  });

  test('refuses outside a git repo — there is nowhere to write the config', async () => {
    (gitIntegration.isGitRepo as jest.Mock).mockReturnValue(false);

    await runCli(['git', 'link', '--board', 'board-a']);

    expect(gitIntegration.writeProjectConfig).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('an unreadable board links nothing', async () => {
    MockBoardsAPI.prototype.getBoard = jest.fn().mockRejectedValue(new Error('404 board not found'));

    await runCli(['git', 'link', '--board', 'ghost']);

    expect(gitIntegration.writeProjectConfig).not.toHaveBeenCalled();
    expect(errors()).toContain('404 board not found');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('git branch', () => {
  beforeEach(() => {
    MockCardsAPI.prototype.getCard = jest.fn().mockResolvedValue({ cardId: 'card-1', name: 'Fix login', boardId: 'board-a' });
    MockCardsAPI.prototype.updateCard = jest.fn().mockResolvedValue({});
    (gitIntegration.generateBranchName as jest.Mock).mockReturnValue('feature/card-1-fix-login');
    (gitIntegration.createBranch as jest.Mock).mockReturnValue(undefined);
  });

  test('creates the branch, records the branch → card mapping, and moves the card', async () => {
    await runCli(['git', 'branch', 'card-1', '-y']);

    expect(gitIntegration.createBranch).toHaveBeenCalledWith('feature/card-1-fix-login');
    expect(gitIntegration.writeProjectConfig).toHaveBeenCalledWith(
      expect.objectContaining({ branches: { 'feature/card-1-fix-login': 'card-1' } }),
    );
    expect(MockCardsAPI.prototype.updateCard).toHaveBeenCalledWith('card-1', { status: 'In Progress' });
    expect(output()).toContain('✓ Created and checked out: feature/card-1-fix-login');
  });

  test('--no-move creates a local branch and writes nothing to Favro — no board, so no lock', async () => {
    await runCli(['git', 'branch', 'card-1', '-y', '--no-move']);

    expect(gitIntegration.createBranch).toHaveBeenCalled();
    expect(MockCardsAPI.prototype.updateCard).not.toHaveBeenCalled();
    expect(safety.checkScope).not.toHaveBeenCalled();
  });

  test('declining the confirm creates no branch and moves no card', async () => {
    (safety.confirmAction as jest.Mock).mockResolvedValue(false);

    await runCli(['git', 'branch', 'card-1']);

    expect(gitIntegration.createBranch).not.toHaveBeenCalled();
    expect(MockCardsAPI.prototype.updateCard).not.toHaveBeenCalled();
    expect(output()).toContain('Aborted.');
  });

  test('the scope check runs before the branch exists, not after', async () => {
    await runCli(['git', 'branch', 'card-1', '-y']);

    const check = (safety.checkScope as jest.Mock).mock.invocationCallOrder[0];
    const branch = (gitIntegration.createBranch as jest.Mock).mock.invocationCallOrder[0];
    expect(check).toBeLessThan(branch);
  });

  test('a failed move is reported but does not fail the command — the branch is already real', async () => {
    MockCardsAPI.prototype.updateCard = jest.fn().mockRejectedValue(new Error('no such column'));

    await runCli(['git', 'branch', 'card-1', '-y']);

    expect(output()).toContain('(Could not move card');
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  test('an unreadable card exits 1 and creates no branch', async () => {
    MockCardsAPI.prototype.getCard = jest.fn().mockRejectedValue(new Error('404 card not found'));

    await runCli(['git', 'branch', 'ghost', '-y']);

    expect(gitIntegration.createBranch).not.toHaveBeenCalled();
    expect(errors()).toContain('404 card not found');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('git commit', () => {
  beforeEach(() => {
    (gitIntegration.hasStagedChanges as jest.Mock).mockReturnValue(true);
    (gitIntegration.getCurrentBranch as jest.Mock).mockReturnValue('feature/card-1-fix-login');
    (gitIntegration.commitWithMessage as jest.Mock).mockReturnValue('abc1234');
    (gitIntegration.extractCardIdFromBranch as jest.Mock).mockReturnValue(null);
    MockComments.prototype.addComment = jest.fn().mockResolvedValue({ commentId: 'cm-1' });
  });

  test('refuses with nothing staged — it must not create an empty commit', async () => {
    (gitIntegration.hasStagedChanges as jest.Mock).mockReturnValue(false);

    await runCli(['git', 'commit', '-m', 'wip']);

    expect(gitIntegration.commitWithMessage).not.toHaveBeenCalled();
    expect(errors()).toContain('No staged changes');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('prefers the explicit --card over the branch mapping', async () => {
    (gitIntegration.readProjectConfig as jest.Mock).mockReturnValue({
      boardId: 'board-a',
      branches: { 'feature/card-1-fix-login': 'card-1' },
    });

    await runCli(['git', 'commit', '-m', 'wip', '--card', 'card-9']);

    expect(gitIntegration.commitWithMessage).toHaveBeenCalledWith('[card-9] wip');
  });

  test('falls back to the branch mapping recorded by `git branch`', async () => {
    (gitIntegration.readProjectConfig as jest.Mock).mockReturnValue({
      boardId: 'board-a',
      branches: { 'feature/card-1-fix-login': 'card-1' },
    });

    await runCli(['git', 'commit', '-m', 'wip']);

    expect(gitIntegration.commitWithMessage).toHaveBeenCalledWith('[card-1] wip');
    expect(gitIntegration.extractCardIdFromBranch).not.toHaveBeenCalled();
  });

  test('falls back again to parsing the branch name when no mapping exists', async () => {
    (gitIntegration.readProjectConfig as jest.Mock).mockReturnValue({ boardId: 'board-a', cardPrefix: 'CARD' });
    (gitIntegration.extractCardIdFromBranch as jest.Mock).mockReturnValue('42');

    await runCli(['git', 'commit', '-m', 'wip']);

    expect(gitIntegration.extractCardIdFromBranch).toHaveBeenCalledWith('feature/card-1-fix-login', 'CARD');
    expect(gitIntegration.commitWithMessage).toHaveBeenCalledWith('[CARD-42] wip');
  });

  test('commits unprefixed when no card can be resolved', async () => {
    (gitIntegration.readProjectConfig as jest.Mock).mockReturnValue(undefined);

    await runCli(['git', 'commit', '-m', 'wip']);

    expect(gitIntegration.commitWithMessage).toHaveBeenCalledWith('wip');
    expect(output()).toContain('✓ Committed: abc1234 wip');
  });

  test('--no-prefix leaves the message alone even with a card in hand', async () => {
    await runCli(['git', 'commit', '-m', 'wip', '--card', 'card-9', '--no-prefix']);

    expect(gitIntegration.commitWithMessage).toHaveBeenCalledWith('wip');
  });

  test('--comment posts the raw message and hash, not the prefixed one', async () => {
    await runCli(['git', 'commit', '-m', 'wip', '--card', 'card-9', '--comment']);

    expect(MockComments.prototype.addComment).toHaveBeenCalledWith('card-9', 'Commit `abc1234`: wip');
    expect(output()).toContain('✓ Comment added to card');
  });

  test('--comment resolves the board lazily before commenting — a comment carries none', async () => {
    await runCli(['git', 'commit', '-m', 'wip', '--card', 'card-9', '--comment']);

    expect(safety.checkResolvedScope).toHaveBeenCalledWith(expect.anything(), expect.any(Function), undefined);
  });

  test('no --comment means no comment call at all', async () => {
    await runCli(['git', 'commit', '-m', 'wip', '--card', 'card-9']);

    expect(MockComments.prototype.addComment).not.toHaveBeenCalled();
    expect(safety.checkResolvedScope).not.toHaveBeenCalled();
  });

  test('a failed comment does not undo the commit that already landed', async () => {
    MockComments.prototype.addComment = jest.fn().mockRejectedValue(new Error('403'));

    await runCli(['git', 'commit', '-m', 'wip', '--card', 'card-9', '--comment']);

    expect(output()).toContain('✓ Committed: abc1234 [card-9] wip');
    expect(output()).toContain('(Could not add comment to card)');
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });
});

describe('git sync — reporting', () => {
  beforeEach(() => {
    (gitIntegration.analyzeBranches as jest.Mock).mockReturnValue([
      { branch: 'feature/one', cardId: 'card-1', status: 'merged' },
      { branch: 'feature/two', cardId: 'card-2', status: 'open' },
      { branch: 'main', cardId: undefined, status: 'current' },
    ]);
    MockCardsAPI.prototype.getCard = jest.fn().mockResolvedValue({ cardId: 'card-1', boardId: 'board-a' });
    MockCardsAPI.prototype.updateCard = jest.fn().mockResolvedValue({});
  });

  test('groups card-linked branches by git status and counts only those', async () => {
    await runCli(['git', 'sync', '-y']);

    expect(output()).toContain('Branch analysis (2 card-linked branches)');
    expect(output()).toContain('feature/one → card card-1');
    expect(output()).toContain('feature/two → card card-2');
    // The branch with no card reference is not counted or listed.
    expect(output()).not.toContain('main → card');
  });

  test('reports the partial count when one write fails rather than claiming success', async () => {
    MockCardsAPI.prototype.updateCard = jest.fn().mockImplementation(async (id: string) => {
      if (id === 'card-2') throw new Error('409');
      return {};
    });

    await runCli(['git', 'sync', '-y']);

    expect(errors()).toContain('✗ Could not update card card-2');
    expect(output()).toContain('✓ Updated 1/2 cards.');
  });

  test('--json emits the raw mappings and the linked board, and writes nothing', async () => {
    await runCli(['git', 'sync', '--json']);

    const printed = JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.trim().startsWith('{'))!);
    expect(printed.linkedBoard).toBe('board-a');
    expect(printed.branches).toHaveLength(3);
    expect(MockCardsAPI.prototype.updateCard).not.toHaveBeenCalled();
  });

  test('says so, and asks nothing, when no branch carries a card reference', async () => {
    (gitIntegration.analyzeBranches as jest.Mock).mockReturnValue([{ branch: 'main', status: 'current' }]);

    await runCli(['git', 'sync', '-y']);

    expect(output()).toContain('No branches with card references found.');
    expect(safety.confirmAction).not.toHaveBeenCalled();
  });

  test('declining the confirm writes nothing', async () => {
    (safety.confirmAction as jest.Mock).mockResolvedValue(false);

    await runCli(['git', 'sync']);

    expect(MockCardsAPI.prototype.updateCard).not.toHaveBeenCalled();
    expect(output()).toContain('Aborted.');
  });
});

describe('git todos — reporting', () => {
  const item = { file: 'src/a.ts', line: 3, type: 'TODO', text: 'fix me' };

  beforeEach(() => {
    (todoScanner.scanTodos as jest.Mock).mockReturnValue([item]);
    (todoScanner.groupByFile as jest.Mock).mockReturnValue([{ file: 'src/a.ts', items: [item] }]);
    (todoScanner.todoToCardTitle as jest.Mock).mockReturnValue('TODO: fix me');
    (todoScanner.formatTodoAsCardDescription as jest.Mock).mockReturnValue('src/a.ts:3');
    MockCardsAPI.prototype.createCard = jest.fn().mockResolvedValue({ cardId: 'new-1' });
  });

  test('lists each hit with its line and type', async () => {
    await runCli(['git', 'todos']);

    expect(output()).toContain('Found 1 TODO items in 1 files');
    expect(output()).toContain('src/a.ts:');
    expect(output()).toContain('L3 [TODO] fix me');
  });

  test('says so and stops when the codebase is clean', async () => {
    (todoScanner.scanTodos as jest.Mock).mockReturnValue([]);

    await runCli(['git', 'todos', '--create', '-y']);

    expect(output()).toContain('No TODO/FIXME/HACK comments found.');
    expect(MockCardsAPI.prototype.createCard).not.toHaveBeenCalled();
  });

  test('--limit caps the listing and says how many were withheld', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...item, line: i + 1 }));
    (todoScanner.scanTodos as jest.Mock).mockReturnValue(many);
    (todoScanner.groupByFile as jest.Mock).mockImplementation((items: unknown[]) => [
      { file: 'src/a.ts', items },
    ]);

    await runCli(['git', 'todos', '--limit', '2']);

    expect(output()).toContain('... and 3 more');
  });

  test('--limit also caps how many cards --create writes', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...item, line: i + 1 }));
    (todoScanner.scanTodos as jest.Mock).mockReturnValue(many);
    (todoScanner.groupByFile as jest.Mock).mockImplementation((items: unknown[]) => [
      { file: 'src/a.ts', items },
    ]);

    await runCli(['git', 'todos', '--create', '-y', '--limit', '2']);

    expect(MockCardsAPI.prototype.createCard).toHaveBeenCalledTimes(2);
    expect(output()).toContain('✓ Created 2/2 cards.');
  });

  test('--create builds each card on the resolved board with the scanner\'s title and body', async () => {
    await runCli(['git', 'todos', '--create', '-y']);

    expect(MockCardsAPI.prototype.createCard).toHaveBeenCalledWith({
      name: 'TODO: fix me',
      description: 'src/a.ts:3',
      boardId: 'board-a',
    });
  });

  test('--create with no board anywhere exits 1 rather than guessing one', async () => {
    (gitIntegration.readProjectConfig as jest.Mock).mockReturnValue(undefined);

    await runCli(['git', 'todos', '--create', '-y']);

    expect(errors()).toContain('No board specified');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('--json emits the total and the capped items, and creates nothing', async () => {
    await runCli(['git', 'todos', '--json', '--create']);

    const printed = JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.trim().startsWith('{'))!);
    expect(printed).toEqual({ total: 1, items: [item] });
    expect(MockCardsAPI.prototype.createCard).not.toHaveBeenCalled();
  });

  test('a failed create is reported per item and the rest still run', async () => {
    const two = [item, { ...item, line: 9 }];
    (todoScanner.scanTodos as jest.Mock).mockReturnValue(two);
    (todoScanner.groupByFile as jest.Mock).mockReturnValue([{ file: 'src/a.ts', items: two }]);
    MockCardsAPI.prototype.createCard = jest
      .fn()
      .mockRejectedValueOnce(new Error('500'))
      .mockResolvedValueOnce({ cardId: 'new-2' });

    await runCli(['git', 'todos', '--create', '-y']);

    expect(errors()).toContain('✗ Failed to create card for src/a.ts:3');
    expect(output()).toContain('✓ Created 1/2 cards.');
  });
});
