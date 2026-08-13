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
let stderrSpy: jest.SpyInstance;

/**
 * The human path, which is what almost every arm below asserts on. `--human` is
 * explicit since #119 moved this file onto `run()`: JSON is the default, so a
 * bare `runCli` would hand every one of these a machine envelope.
 */
async function runCli(args: string[]): Promise<void> {
  await drive(['--human', ...args]);
}

/** The machine path — the DEFAULT for a real invocation (ADR-0002). */
async function runJson(args: string[]): Promise<void> {
  await drive(args);
}

async function drive(args: string[]): Promise<void> {
  const program = new Command();
  program.option('--human').option('--pretty').option('--verbose', 'Show stack traces');
  registerGitCommands(program);
  program.exitOverride();
  await program.parseAsync(['node', 'favro', ...args]);
}

const output = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const errors = () => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
/**
 * What the command wrote to STDERR while it was still working — the branch
 * analysis, the TODO listing under `--create`, the progress lines. #119 moved
 * all of it off stdout, which now carries the envelope alone.
 */
const noted = () => stderrSpy.mock.calls.map((c) => String(c[0])).join('');
/** The one JSON document on stdout. Nothing may precede it. */
const parsed = () => JSON.parse(output());

beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = undefined;
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  jest.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit must not be called under run()');
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
  process.exitCode = undefined;
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
    expect(process.exitCode).toBe(1);
  });

  test('an unreadable board links nothing', async () => {
    MockBoardsAPI.prototype.getBoard = jest.fn().mockRejectedValue(new Error('404 board not found'));

    await runCli(['git', 'link', '--board', 'ghost']);

    expect(gitIntegration.writeProjectConfig).not.toHaveBeenCalled();
    expect(errors()).toContain('404 board not found');
    expect(process.exitCode).toBe(1);
  });
});

describe('git branch', () => {
  // The move is routed through the `update` intent (#109): the wire shape is
  // `PUT {columnId}`, because Favro's status IS the column, and `moveColumn`
  // re-reads the card afterwards — so the stand has to move it for real.
  let column: string | undefined;
  beforeEach(() => {
    column = undefined;
    MockCardsAPI.prototype.getCard = jest.fn().mockImplementation(async () => ({
      cardId: 'card-1', name: 'Fix login', boardId: 'board-a', columnId: column,
    }));
    MockCardsAPI.prototype.resolveColumnId = jest.fn(async (name: string) => `col-${name}`);
    MockCardsAPI.prototype.updateCard = jest.fn().mockImplementation(async (id: string, data: any) => {
      if (data.columnId !== undefined) column = data.columnId;
      return { cardId: id, ...data };
    });
    (gitIntegration.generateBranchName as jest.Mock).mockReturnValue('feature/card-1-fix-login');
    (gitIntegration.createBranch as jest.Mock).mockReturnValue(undefined);
  });

  test('creates the branch, records the branch → card mapping, and moves the card', async () => {
    await runCli(['git', 'branch', 'card-1', '-y']);

    expect(gitIntegration.createBranch).toHaveBeenCalledWith('feature/card-1-fix-login');
    expect(gitIntegration.writeProjectConfig).toHaveBeenCalledWith(
      expect.objectContaining({ branches: { 'feature/card-1-fix-login': 'card-1' } }),
    );
    expect(MockCardsAPI.prototype.updateCard).toHaveBeenCalledWith('card-1', { columnId: 'col-In Progress' });
    expect(output()).toContain('✓ Created and checked out: feature/card-1-fix-login');
  });

  test('--no-move creates a local branch and writes nothing to Favro — no board, so no lock', async () => {
    await runCli(['git', 'branch', 'card-1', '-y', '--no-move']);

    expect(gitIntegration.createBranch).toHaveBeenCalled();
    expect(MockCardsAPI.prototype.updateCard).not.toHaveBeenCalled();
    expect(safety.assertScope).not.toHaveBeenCalled();
  });

  test('declining the confirm creates no branch and moves no card', async () => {
    (safety.confirmAction as jest.Mock).mockResolvedValue(false);

    await runCli(['git', 'branch', 'card-1']);

    expect(gitIntegration.createBranch).not.toHaveBeenCalled();
    expect(MockCardsAPI.prototype.updateCard).not.toHaveBeenCalled();
    expect(output()).toContain('Aborted.');
  });

  test('the scope check runs before the branch exists, not after', async () => {
    // The check is the TABLE's now, reached by dispatching the same `update`
    // intent with `dryRun` ahead of the confirm — so this pins the ordering the
    // hand-rolled `checkScope` used to buy, against the guard that now governs
    // the write. A LOCK has to be configured for it to be reachable at all: the
    // pre-flight is gated on one, because with nothing locked it would be a read
    // billed for a verdict nobody can produce.
    (config.readConfig as jest.Mock).mockResolvedValue({ scopeCollectionId: 'coll-1' });

    await runCli(['git', 'branch', 'card-1', '-y']);

    const check = (safety.assertScope as jest.Mock).mock.invocationCallOrder[0];
    const branch = (gitIntegration.createBranch as jest.Mock).mock.invocationCallOrder[0];
    expect(check).toBeLessThan(branch);
  });

  test('a failed move is reported but does not fail the command — the branch is already real', async () => {
    MockCardsAPI.prototype.updateCard = jest.fn().mockRejectedValue(new Error('no such column'));

    await runCli(['git', 'branch', 'card-1', '-y']);

    expect(output()).toContain('(Could not move card');
    expect(process.exitCode).toBeUndefined();
  });

  test('an unreadable card exits 1 and creates no branch', async () => {
    MockCardsAPI.prototype.getCard = jest.fn().mockRejectedValue(new Error('404 card not found'));

    await runCli(['git', 'branch', 'ghost', '-y']);

    expect(gitIntegration.createBranch).not.toHaveBeenCalled();
    expect(errors()).toContain('404 card not found');
    expect(process.exitCode).toBe(1);
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
    expect(process.exitCode).toBe(1);
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
    expect(process.exitCode).toBeUndefined();
  });
});

describe('git sync — reporting', () => {
  // Routed through the `update` intent, so the write is `PUT {columnId}` and
  // `moveColumn` re-reads the card: the stand has to move it for real.
  const column: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of Object.keys(column)) delete column[key];
    (gitIntegration.analyzeBranches as jest.Mock).mockReturnValue([
      { branch: 'feature/one', cardId: 'card-1', status: 'merged' },
      { branch: 'feature/two', cardId: 'card-2', status: 'open' },
      { branch: 'main', cardId: undefined, status: 'current' },
    ]);
    MockCardsAPI.prototype.getCard = jest.fn().mockImplementation(async (id: string) => ({
      cardId: id, boardId: 'board-a', columnId: column[id],
    }));
    MockCardsAPI.prototype.resolveColumnId = jest.fn(async (name: string) => `col-${name}`);
    MockCardsAPI.prototype.updateCard = jest.fn().mockImplementation(async (id: string, data: any) => {
      if (data.columnId !== undefined) column[id] = data.columnId;
      return { cardId: id, ...data };
    });
  });

  test('groups card-linked branches by git status and counts only those', async () => {
    await runCli(['git', 'sync', '-y']);

    // On STDERR since #119: the analysis describes the local repo and prints
    // while the command is still working, so leaving it on stdout would put
    // prose in front of the envelope this command now writes there.
    expect(noted()).toContain('Branch analysis (2 card-linked branches)');
    expect(noted()).toContain('feature/one → card card-1');
    expect(noted()).toContain('feature/two → card card-2');
    // The branch with no card reference is not counted or listed.
    expect(noted()).not.toContain('main → card');
  });

  test('one failed write UNWINDS the pass rather than reporting a partial count', async () => {
    // It used to print "✗ Could not update card card-2" and "✓ Updated 1/2
    // cards." — a half-applied sweep reported as a success count, with no record
    // of what the successful half did. The pass is ONE transaction since #109:
    // the card that did move is moved back, LIFO, and the run says `rolled-back`.
    MockCardsAPI.prototype.updateCard = jest.fn().mockImplementation(async (id: string, data: any) => {
      if (id === 'card-2') throw new Error('409');
      if (data.columnId !== undefined) column[id] = data.columnId;
      return { cardId: id, ...data };
    });

    await runCli(['git', 'sync', '-y']);

    expect(errors()).toContain('✗ update failed');
    expect(errors()).toContain('Rolled back — nothing was left behind');
    expect(output()).not.toContain('✓ Updated');
    // card-1 moved, then moved back to the column it held.
    expect((MockCardsAPI.prototype.updateCard as jest.Mock).mock.calls.filter((c) => c[0] === 'card-1'))
      .toHaveLength(2);
  });

  test('--dry-run emits the raw mappings and the linked board, and writes nothing', async () => {
    // The successor to `git sync --json`, which #119 deleted. That flag was an
    // early return ABOVE the confirm and the write, so with JSON the default a
    // mechanical rename would have made the plain `favro git sync` report and
    // never sync. `--dry-run` already meant "report, write nothing", and unlike
    // `--json` it takes the scope lock before promising anything (#155).
    await runJson(['git', 'sync', '--dry-run']);

    const printed = parsed();
    expect(printed.linkedBoard).toBe('board-a');
    expect(printed.branches).toHaveLength(3);
    expect(printed.wouldMove).toEqual([
      { card: 'card-1', status: 'Done' },
      { card: 'card-2', status: 'In Progress' },
    ]);
    expect(MockCardsAPI.prototype.updateCard).not.toHaveBeenCalled();
  });

  test('the plain invocation SYNCS — the machine default is not a report', async () => {
    // The regression #119's rename would have shipped: `git sync --json` used
    // to return above the write, and `--json` was on its way to becoming the
    // default. If this ever goes green with `updateCard` uncalled, the JSON arm
    // has grown an early return again.
    await runJson(['git', 'sync', '-y']);

    expect(MockCardsAPI.prototype.updateCard).toHaveBeenCalledWith('card-1', { columnId: 'col-Done' });
    // And stdout is the envelope alone — the branch analysis went to stderr.
    expect(parsed()).toHaveLength(2);
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

  test('a --limit it cannot read refuses even when the codebase is CLEAN', async () => {
    // The clean arm returns before ever reading `limit`, so the parse used to sit
    // below it: `--limit banana` refused on a repo with TODOs and exited 0 with
    // "No TODO/FIXME/HACK comments found" on a repo without. Whether a typo was
    // caught depended on the codebase (#142/#143 review).
    (todoScanner.scanTodos as jest.Mock).mockReturnValue([]);

    await runCli(['git', 'todos', '--limit', 'banana']);

    expect(errors()).toContain('banana');
    expect(output()).not.toContain('No TODO/FIXME/HACK comments found.');
    // And it costs no scan at all — the refusal is decided from the flag alone.
    expect(todoScanner.scanTodos).not.toHaveBeenCalled();
  });

  test('--limit caps the listing and says how many were withheld', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...item, line: i + 1 }));
    (todoScanner.scanTodos as jest.Mock).mockReturnValue(many);
    (todoScanner.groupByFile as jest.Mock).mockImplementation((items: unknown[]) => [
      { file: 'src/a.ts', items },
    ]);

    await runCli(['git', 'todos', '--limit', '2']);

    // The runner's wording now (`noteTruncation`), not a hand-rolled
    // "... and 3 more": the listing became a `rows` result in #119, so the cut
    // and the sentence about it are `capRows`'s, shared with every list read.
    expect(output()).toContain('(truncated to 2 of 5 — raise --limit to see the rest)');
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
    expect(process.exitCode).toBe(1);
  });

  test('the listing arm IS the envelope — what --json used to hand-roll', async () => {
    // `git todos --json` returned `{total, items}` from above the `--create`
    // block, so `--json --create` printed the scan and created nothing. #119
    // deleted the flag: without `--create` the listing is the answer and goes
    // through `rows`/`truncated` like every other list read.
    await runJson(['git', 'todos']);

    expect(parsed()).toEqual({ rows: [item] });
    expect(MockCardsAPI.prototype.createCard).not.toHaveBeenCalled();
  });

  test('--create WRITES on the machine default — the report arm no longer swallows it', async () => {
    // The other half of the same regression: `--json --create` created nothing.
    await runJson(['git', 'todos', '--create', '-y']);

    expect(MockCardsAPI.prototype.createCard).toHaveBeenCalledTimes(1);
    // The scan listing went to stderr, so stdout parses as the created cards.
    expect(parsed()).toEqual([{ cardId: 'new-1' }]);
    expect(noted()).toContain('L3 [TODO] fix me');
  });

  test('more than twenty TODOs REFUSES, and the refusal names --limit', async () => {
    // A CLIFF, not a corner: the listing's `--limit` defaults to 100 and the
    // multi-write cap is 20, so any repo with more than twenty TODOs refuses
    // `--create` by default. Refusing is right — creating twenty and dropping the
    // rest reports success for cards nobody made — but the table's own sentence
    // ends "split an enumerated list, or act on a derived one entry at a time",
    // and a codebase SCAN is neither. `--limit` is the only remedy here and the
    // table cannot know that, so the command says it.
    const many = Array.from({ length: 21 }, (_, i) => ({ ...item, line: i + 1 }));
    (todoScanner.scanTodos as jest.Mock).mockReturnValue(many);
    (todoScanner.groupByFile as jest.Mock).mockReturnValue([{ file: 'src/a.ts', items: many }]);
    MockCardsAPI.prototype.createCard = jest.fn();

    await runCli(['git', 'todos', '--create', '-y']);

    expect(MockCardsAPI.prototype.createCard).not.toHaveBeenCalled();
    expect(errors()).toContain('capped at 20');
    expect(errors()).toContain('--limit 20');
    expect(process.exitCode).toBe(1);
  });

  test('--limit 20 is the remedy the refusal names, and it works', async () => {
    // The other polarity: advice that does not work is worse than no advice.
    const many = Array.from({ length: 21 }, (_, i) => ({ ...item, line: i + 1 }));
    (todoScanner.scanTodos as jest.Mock).mockReturnValue(many);
    (todoScanner.groupByFile as jest.Mock).mockReturnValue([{ file: 'src/a.ts', items: many }]);
    MockCardsAPI.prototype.createCard = jest.fn().mockResolvedValue({ cardId: 'new-1' });

    await runCli(['git', 'todos', '--create', '-y', '--limit', '20']);

    expect((MockCardsAPI.prototype.createCard as jest.Mock).mock.calls).toHaveLength(20);
    expect(output()).toContain('✓ Created 20/20 cards.');
  });

  test('a failed create UNWINDS the batch rather than creating the rest', async () => {
    // It used to print "✗ Failed to create card for src/a.ts:3" and "✓ Created
    // 1/2 cards.", leaving whatever did get created behind. The scan is an
    // ENUMERATED list, so #109 dispatches it as one `create` transaction: the
    // cards already made are deleted, LIFO, and the run says `rolled-back`.
    const two = [item, { ...item, line: 9 }];
    (todoScanner.scanTodos as jest.Mock).mockReturnValue(two);
    (todoScanner.groupByFile as jest.Mock).mockReturnValue([{ file: 'src/a.ts', items: two }]);
    MockCardsAPI.prototype.createCard = jest
      .fn()
      .mockResolvedValueOnce({ cardId: 'new-1' })
      .mockRejectedValueOnce(new Error('500'));
    MockCardsAPI.prototype.deleteCard = jest.fn().mockResolvedValue(undefined);

    await runCli(['git', 'todos', '--create', '-y']);

    expect(errors()).toContain('✗ create failed');
    expect(errors()).toContain('Rolled back — nothing was left behind');
    expect(MockCardsAPI.prototype.deleteCard).toHaveBeenCalledWith('new-1');
    expect(output()).not.toContain('✓ Created');
  });
});
