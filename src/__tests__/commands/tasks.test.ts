/**
 * Unit tests — tasks update/delete CLI commands
 */
import { Command } from 'commander';
import { registerTasksCommands } from '../../commands/tasks';
import * as config from '../../lib/config';
import * as safety from '../../lib/safety';
import TasksAPI from '../../lib/tasks-api';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../lib/safety');
jest.mock('../../lib/tasks-api');

const MockTasksAPI = TasksAPI as jest.MockedClass<typeof TasksAPI>;

function buildProgram(): Command {
  const program = new Command();
  // `--human` and `--pretty` declared at the root, and `--human` PREPENDED to
  // every drive: #119 moved this command onto `run()`, so JSON is the default
  // (ADR-0002) and the prose these arms assert lives on the `human` formatter.
  program.option('--human').option('--pretty').option('--verbose', 'Show stack traces');
  registerTasksCommands(program);
  return program;
}

async function runCli(args: string[]): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  await program.parseAsync(['node', 'favro', '--human', ...args]);
}

beforeEach(() => {
  jest.clearAllMocks();
  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  (config.readConfig as jest.Mock).mockResolvedValue({});
  (safety.confirmAction as jest.Mock).mockResolvedValue(true);
});

/**
 * `run()` sets `process.exitCode` instead of exiting, and jest shares one
 * process per worker — an un-reset code leaks into the worker's own exit and
 * into the next arm's assertion.
 */
beforeEach(() => {
  process.exitCode = undefined;
});
afterEach(() => {
  process.exitCode = undefined;
});

describe('favro tasks update', () => {
  let consoleSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit must not be called under run()');
  }) as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('updates a task with name', async () => {
    MockTasksAPI.prototype.updateTask = jest.fn().mockResolvedValue({
      taskId: 'task-1',
      name: 'Renamed',
      cardCommonId: 'card-1',
    });

    await runCli(['tasks', 'update', 'task-1', '--name', 'Renamed', '--yes']);

    expect(MockTasksAPI.prototype.updateTask).toHaveBeenCalledWith('task-1', { name: 'Renamed' });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Task updated'));
  });

  it('updates a task with --completed flag', async () => {
    MockTasksAPI.prototype.updateTask = jest.fn().mockResolvedValue({
      taskId: 'task-1',
      name: 'My Task',
      completed: true,
      cardCommonId: 'card-1',
    });

    await runCli(['tasks', 'update', 'task-1', '--completed', '--yes']);

    expect(MockTasksAPI.prototype.updateTask).toHaveBeenCalledWith('task-1', { completed: true });
  });

  it('dry-run previews without API call', async () => {
    await runCli(['tasks', 'update', 'task-1', '--name', 'New', '--dry-run']);

    expect(safety.dryRunLog).toHaveBeenCalled();
    expect(MockTasksAPI.prototype.updateTask).not.toHaveBeenCalled();
  });

  it('errors when no fields provided', async () => {
    await runCli(['tasks', 'update', 'task-1']);

    expect(process.exitCode).toBe(1);
  });
});

describe('favro tasks delete', () => {
  let consoleSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit must not be called under run()');
  }) as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('deletes a task', async () => {
    MockTasksAPI.prototype.deleteTask = jest.fn().mockResolvedValue(undefined);

    await runCli(['tasks', 'delete', 'task-1', '--yes']);

    expect(MockTasksAPI.prototype.deleteTask).toHaveBeenCalledWith('task-1');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Task deleted'));
  });

  it('dry-run previews without API call', async () => {
    await runCli(['tasks', 'delete', 'task-1', '--dry-run']);

    expect(safety.dryRunLog).toHaveBeenCalled();
    expect(MockTasksAPI.prototype.deleteTask).not.toHaveBeenCalled();
  });

  it('aborts when user declines', async () => {
    (safety.confirmAction as jest.Mock).mockResolvedValue(false);

    await runCli(['tasks', 'delete', 'task-1']);

    expect(MockTasksAPI.prototype.deleteTask).not.toHaveBeenCalled();
  });
});
