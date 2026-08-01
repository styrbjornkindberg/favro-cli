/**
 * Unit tests — scope lock on the card-child write paths (issue #104)
 *
 * Nine writes hang off a card without ever naming a board: tasks add/update/
 * complete/delete, tasklists create/update/delete, comments update/delete.
 * Each must resolve a board and take the lock before the first write.
 */
import { Command } from 'commander';
import { registerTasksCommands } from '../../commands/tasks';
import { registerTaskListsCommands } from '../../commands/tasklists';
import { registerCommentsCommand } from '../../commands/comments';
import * as config from '../../lib/config';
import * as safety from '../../lib/safety';
import CardsAPI from '../../lib/cards-api';
import { passThroughScopeResolution } from '../../test-support/scope-passthrough';
import TasksAPI from '../../lib/tasks-api';
import TaskListsAPI from '../../lib/tasklists-api';
import CommentsApiClient from '../../api/comments';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../lib/safety');
jest.mock('../../lib/cards-api');
jest.mock('../../lib/tasks-api');
jest.mock('../../lib/tasklists-api');
jest.mock('../../api/comments');

const MockCardsAPI = CardsAPI as jest.MockedClass<typeof CardsAPI>;
const MockTasksAPI = TasksAPI as jest.MockedClass<typeof TasksAPI>;
const MockTaskListsAPI = TaskListsAPI as jest.MockedClass<typeof TaskListsAPI>;
const MockComments = CommentsApiClient as jest.MockedClass<typeof CommentsApiClient>;

async function runCli(args: string[]): Promise<void> {
  const program = new Command();
  program.option('--verbose', 'Show stack traces');
  registerTasksCommands(program);
  registerTaskListsCommands(program);
  registerCommentsCommand(program);
  program.exitOverride();
  await program.parseAsync(['node', 'favro', ...args]);
}

const order = (fn: any): number => (fn as jest.Mock).mock.invocationCallOrder[0];

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  (config.readConfig as jest.Mock).mockResolvedValue({ scopeCollectionId: 'col-a' });
  passThroughScopeResolution(safety, config, MockCardsAPI, MockComments);
  (safety.checkScope as jest.Mock).mockResolvedValue(undefined);
  (safety.confirmAction as jest.Mock).mockResolvedValue(true);

  MockCardsAPI.prototype.getCard = jest.fn().mockResolvedValue({ cardId: 'card-1', boardId: 'board-a' });

  MockTasksAPI.prototype.createTask = jest.fn().mockResolvedValue({ taskId: 't-1', name: 'x' });
  MockTasksAPI.prototype.updateTask = jest.fn().mockResolvedValue({ taskId: 't-1', name: 'x' });
  MockTasksAPI.prototype.deleteTask = jest.fn().mockResolvedValue(undefined);

  MockTaskListsAPI.prototype.listTaskLists = jest.fn().mockResolvedValue([{ taskListId: 'tl-1' }]);
  MockTaskListsAPI.prototype.createTaskList = jest.fn().mockResolvedValue({ taskListId: 'tl-1', name: 'x' });
  MockTaskListsAPI.prototype.updateTaskList = jest.fn().mockResolvedValue({ taskListId: 'tl-1', name: 'x' });
  MockTaskListsAPI.prototype.deleteTaskList = jest.fn().mockResolvedValue(undefined);
  MockTaskListsAPI.prototype.getTaskList = jest.fn().mockResolvedValue({
    taskListId: 'tl-1', name: 'x', cardCommonId: 'card-1',
  });

  MockComments.prototype.getComment = jest.fn().mockResolvedValue({ commentId: 'c-1', cardId: 'card-1' });
  MockComments.prototype.updateComment = jest.fn().mockResolvedValue({ commentId: 'c-1' });
  MockComments.prototype.deleteComment = jest.fn().mockResolvedValue(undefined);
});

afterEach(() => { jest.restoreAllMocks(); });

/**
 * One shared shape per command: the check precedes the write, a refusal blocks
 * the write, --force is forwarded, and an unreadable resolving GET degrades to
 * '' rather than crashing.
 */
interface Case {
  name: string;
  argv: string[];
  write: () => jest.Mock;
  /** GET whose failure must degrade to '' */
  breakResolve?: () => void;
  expectBoard?: string;
}

const cases: Case[] = [
  {
    name: 'tasks add',
    argv: ['tasks', 'add', 'card-1', 'Do the thing', '--yes'],
    write: () => MockTasksAPI.prototype.createTask as jest.Mock,
    breakResolve: () => { MockCardsAPI.prototype.getCard = jest.fn().mockRejectedValue(new Error('404')); },
  },
  {
    name: 'tasks update',
    argv: ['tasks', 'update', 't-1', '--name', 'New', '--card', 'card-1', '--yes'],
    write: () => MockTasksAPI.prototype.updateTask as jest.Mock,
    breakResolve: () => { MockCardsAPI.prototype.getCard = jest.fn().mockRejectedValue(new Error('404')); },
  },
  {
    name: 'tasks complete',
    argv: ['tasks', 'complete', 't-1', '--card', 'card-1', '--yes'],
    write: () => MockTasksAPI.prototype.updateTask as jest.Mock,
    breakResolve: () => { MockCardsAPI.prototype.getCard = jest.fn().mockRejectedValue(new Error('404')); },
  },
  {
    name: 'tasks delete',
    argv: ['tasks', 'delete', 't-1', '--card', 'card-1', '--yes'],
    write: () => MockTasksAPI.prototype.deleteTask as jest.Mock,
    breakResolve: () => { MockCardsAPI.prototype.getCard = jest.fn().mockRejectedValue(new Error('404')); },
  },
  {
    name: 'tasklists create',
    argv: ['tasklists', 'create', 'card-1', '--name', 'Checklist', '--yes'],
    write: () => MockTaskListsAPI.prototype.createTaskList as jest.Mock,
    breakResolve: () => { MockCardsAPI.prototype.getCard = jest.fn().mockRejectedValue(new Error('404')); },
  },
  {
    name: 'tasklists update',
    argv: ['tasklists', 'update', 'tl-1', '--name', 'New', '--yes'],
    write: () => MockTaskListsAPI.prototype.updateTaskList as jest.Mock,
    breakResolve: () => { MockTaskListsAPI.prototype.getTaskList = jest.fn().mockRejectedValue(new Error('404')); },
  },
  {
    name: 'tasklists delete',
    argv: ['tasklists', 'delete', 'tl-1', '--yes'],
    write: () => MockTaskListsAPI.prototype.deleteTaskList as jest.Mock,
    breakResolve: () => { MockTaskListsAPI.prototype.getTaskList = jest.fn().mockRejectedValue(new Error('404')); },
  },
  {
    name: 'comments update',
    argv: ['comments', 'update', 'c-1', '--text', 'New text', '--yes'],
    write: () => MockComments.prototype.updateComment as jest.Mock,
    breakResolve: () => { MockComments.prototype.getComment = jest.fn().mockRejectedValue(new Error('404')); },
  },
  {
    name: 'comments delete',
    argv: ['comments', 'delete', 'c-1', '--yes'],
    write: () => MockComments.prototype.deleteComment as jest.Mock,
    breakResolve: () => { MockComments.prototype.getComment = jest.fn().mockRejectedValue(new Error('404')); },
  },
];

describe.each(cases)('favro $name — scope lock', (tc) => {
  it('checks the resolved board before writing', async () => {
    await runCli(tc.argv);

    expect(safety.checkScope).toHaveBeenCalledWith(
      tc.expectBoard ?? 'board-a', expect.anything(), expect.anything(), undefined
    );
    expect(tc.write()).toHaveBeenCalled();
    expect(order(safety.checkScope)).toBeLessThan(order(tc.write()));
  });

  it('writes nothing when the board is out of scope', async () => {
    (safety.checkScope as jest.Mock).mockRejectedValue(new Error('out of scope'));

    await runCli(tc.argv);

    expect(tc.write()).not.toHaveBeenCalled();
  });

  it('forwards --force to checkScope', async () => {
    await runCli([...tc.argv, '--force']);

    expect(safety.checkScope).toHaveBeenCalledWith(
      tc.expectBoard ?? 'board-a', expect.anything(), expect.anything(), true
    );
  });

  it('resolves to an empty board and still checks when the resolving GET fails', async () => {
    tc.breakResolve!();

    await runCli(tc.argv);

    expect(safety.checkScope).toHaveBeenCalledWith('', expect.anything(), expect.anything(), undefined);
  });

  it('checks scope before asking the user to confirm', async () => {
    await runCli(tc.argv);

    expect(order(safety.checkScope)).toBeLessThan(order(safety.confirmAction));
  });
});

describe('task commands without --card', () => {
  it.each([
    ['update', ['tasks', 'update', 't-1', '--name', 'New', '--yes']],
    ['complete', ['tasks', 'complete', 't-1', '--yes']],
    ['delete', ['tasks', 'delete', 't-1', '--yes']],
  ])('tasks %s passes an empty board id when --card is omitted', async (_name, argv) => {
    await runCli(argv as string[]);

    expect(safety.checkScope).toHaveBeenCalledWith('', expect.anything(), expect.anything(), undefined);
    expect(MockCardsAPI.prototype.getCard).not.toHaveBeenCalled();
  });
});
