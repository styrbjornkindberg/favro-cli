/**
 * Unit tests — collections delete and boards delete CLI commands
 */
import { Command } from 'commander';
import { registerCollectionsDeleteCommand } from '../../commands/collections-delete';
import { registerBoardsDeleteCommand } from '../../commands/boards-delete';
import * as config from '../../lib/config';
import * as safety from '../../lib/safety';
import CollectionsAPI from '../../lib/collections-api';
import BoardsAPI from '../../lib/boards-api';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../lib/safety');
jest.mock('../../lib/collections-api');
jest.mock('../../lib/boards-api');

const MockCollectionsAPI = CollectionsAPI as jest.MockedClass<typeof CollectionsAPI>;
const MockBoardsAPI = BoardsAPI as jest.MockedClass<typeof BoardsAPI>;

beforeEach(() => {
  jest.clearAllMocks();
  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  (config.readConfig as jest.Mock).mockResolvedValue({});
  (safety.checkScope as jest.Mock).mockResolvedValue(undefined);
  (safety.checkCollectionScope as jest.Mock).mockImplementation(() => {});
  (safety.confirmAction as jest.Mock).mockResolvedValue(true);
});

describe('favro collections delete', () => {
  let consoleSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  function buildProgram(): Command {
    const program = new Command();
    program.option('--verbose', 'Show stack traces');
    const collectionsCmd = program.command('collections').description('Collection operations');
    registerCollectionsDeleteCommand(collectionsCmd);
    return program;
  }

  async function runCli(args: string[]): Promise<void> {
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(['node', 'favro', ...args]);
  }

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => { jest.restoreAllMocks(); });

  it('deletes a collection', async () => {
    MockCollectionsAPI.prototype.deleteCollection = jest.fn().mockResolvedValue(undefined);

    await runCli(['collections', 'delete', 'col-1', '--yes']);

    expect(MockCollectionsAPI.prototype.deleteCollection).toHaveBeenCalledWith('col-1');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Collection deleted'));
  });

  it('dry-run previews', async () => {
    await runCli(['collections', 'delete', 'col-1', '--dry-run']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[dry-run]'));
    expect(MockCollectionsAPI.prototype.deleteCollection).not.toHaveBeenCalled();
  });

  it('aborts when user declines', async () => {
    (safety.confirmAction as jest.Mock).mockResolvedValue(false);

    await runCli(['collections', 'delete', 'col-1']);

    expect(MockCollectionsAPI.prototype.deleteCollection).not.toHaveBeenCalled();
  });
});

describe('favro boards delete', () => {
  let consoleSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  function buildProgram(): Command {
    const program = new Command();
    program.option('--verbose', 'Show stack traces');
    const boardsCmd = program.command('boards').description('Board operations');
    registerBoardsDeleteCommand(boardsCmd);
    return program;
  }

  async function runCli(args: string[]): Promise<void> {
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(['node', 'favro', ...args]);
  }

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => { jest.restoreAllMocks(); });

  it('deletes a board', async () => {
    MockBoardsAPI.prototype.deleteBoard = jest.fn().mockResolvedValue(undefined);

    await runCli(['boards', 'delete', 'board-1', '--yes']);

    expect(MockBoardsAPI.prototype.deleteBoard).toHaveBeenCalledWith('board-1');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Board deleted'));
  });

  it('dry-run previews', async () => {
    await runCli(['boards', 'delete', 'board-1', '--dry-run']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[dry-run]'));
    expect(MockBoardsAPI.prototype.deleteBoard).not.toHaveBeenCalled();
  });

  it('aborts when user declines', async () => {
    (safety.confirmAction as jest.Mock).mockResolvedValue(false);

    await runCli(['boards', 'delete', 'board-1']);

    expect(MockBoardsAPI.prototype.deleteBoard).not.toHaveBeenCalled();
  });
});
