/**
 * Unit tests — tasklists CLI commands (full CRUD)
 */
import { Command } from 'commander';
import { registerTaskListsCommands } from '../../commands/tasklists';
import * as config from '../../lib/config';
import * as safety from '../../lib/safety';
import TaskListsAPI from '../../lib/tasklists-api';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../lib/safety');
jest.mock('../../lib/tasklists-api');

const MockTaskListsAPI = TaskListsAPI as jest.MockedClass<typeof TaskListsAPI>;

function buildProgram(): Command {
  const program = new Command();
  program.option('--verbose', 'Show stack traces');
  registerTaskListsCommands(program);
  return program;
}

async function runCli(args: string[]): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  await program.parseAsync(['node', 'favro', ...args]);
}

beforeEach(() => {
  jest.clearAllMocks();
  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  (config.readConfig as jest.Mock).mockResolvedValue({});
  (safety.confirmAction as jest.Mock).mockResolvedValue(true);
});

describe('favro tasklists list', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'table').mockImplementation(() => {});
  });

  afterEach(() => { jest.restoreAllMocks(); });

  it('lists task lists for a card', async () => {
    MockTaskListsAPI.prototype.listTaskLists = jest.fn().mockResolvedValue([
      { taskListId: 'tl-1', name: 'Checklist', cardCommonId: 'card-1' },
    ]);

    await runCli(['tasklists', 'list', 'card-1']);

    expect(MockTaskListsAPI.prototype.listTaskLists).toHaveBeenCalledWith('card-1');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('1 task list'));
  });

  it('outputs JSON', async () => {
    MockTaskListsAPI.prototype.listTaskLists = jest.fn().mockResolvedValue([
      { taskListId: 'tl-1', name: 'Checklist', cardCommonId: 'card-1' },
    ]);

    await runCli(['tasklists', 'list', 'card-1', '--json']);

    const jsonCall = consoleSpy.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('taskListId')
    );
    expect(jsonCall).toBeDefined();
  });
});

describe('favro tasklists get', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => { jest.restoreAllMocks(); });

  it('gets a task list by ID', async () => {
    MockTaskListsAPI.prototype.getTaskList = jest.fn().mockResolvedValue({
      taskListId: 'tl-1',
      name: 'Checklist',
      cardCommonId: 'card-1',
    });

    await runCli(['tasklists', 'get', 'tl-1']);

    expect(MockTaskListsAPI.prototype.getTaskList).toHaveBeenCalledWith('tl-1');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Checklist'));
  });
});

describe('favro tasklists create', () => {
  let consoleSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => { jest.restoreAllMocks(); });

  it('creates a task list', async () => {
    MockTaskListsAPI.prototype.createTaskList = jest.fn().mockResolvedValue({
      taskListId: 'tl-new',
      name: 'New List',
      cardCommonId: 'card-1',
    });

    await runCli(['tasklists', 'create', 'card-1', '--name', 'New List', '--yes']);

    expect(MockTaskListsAPI.prototype.createTaskList).toHaveBeenCalledWith('card-1', 'New List', undefined);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Task list created'));
  });

  it('dry-run previews', async () => {
    await runCli(['tasklists', 'create', 'card-1', '--name', 'Test', '--dry-run']);

    expect(safety.dryRunLog).toHaveBeenCalled();
    expect(MockTaskListsAPI.prototype.createTaskList).not.toHaveBeenCalled();
  });
});

describe('favro tasklists update', () => {
  let consoleSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => { jest.restoreAllMocks(); });

  it('updates a task list', async () => {
    MockTaskListsAPI.prototype.updateTaskList = jest.fn().mockResolvedValue({
      taskListId: 'tl-1',
      name: 'Renamed',
      cardCommonId: 'card-1',
    });

    await runCli(['tasklists', 'update', 'tl-1', '--name', 'Renamed', '--yes']);

    expect(MockTaskListsAPI.prototype.updateTaskList).toHaveBeenCalledWith('tl-1', { name: 'Renamed' });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Task list updated'));
  });

  it('errors when no fields provided', async () => {
    await runCli(['tasklists', 'update', 'tl-1']);

    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});

describe('favro tasklists delete', () => {
  let consoleSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => { jest.restoreAllMocks(); });

  it('deletes a task list', async () => {
    MockTaskListsAPI.prototype.deleteTaskList = jest.fn().mockResolvedValue(undefined);

    await runCli(['tasklists', 'delete', 'tl-1', '--yes']);

    expect(MockTaskListsAPI.prototype.deleteTaskList).toHaveBeenCalledWith('tl-1');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Task list deleted'));
  });

  it('aborts when user declines', async () => {
    (safety.confirmAction as jest.Mock).mockResolvedValue(false);

    await runCli(['tasklists', 'delete', 'tl-1']);

    expect(MockTaskListsAPI.prototype.deleteTaskList).not.toHaveBeenCalled();
  });
});
