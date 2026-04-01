/**
 * Unit tests — dependencies delete/delete-all CLI commands
 */
import { Command } from 'commander';
import { registerDependenciesCommands } from '../../commands/dependencies';
import * as config from '../../lib/config';
import * as safety from '../../lib/safety';
import CardsAPI from '../../lib/cards-api';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../lib/safety');
jest.mock('../../lib/cards-api');

const MockCardsAPI = CardsAPI as jest.MockedClass<typeof CardsAPI>;

function buildProgram(): Command {
  const program = new Command();
  program.option('--verbose', 'Show stack traces');
  registerDependenciesCommands(program);
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
  (safety.checkScope as jest.Mock).mockResolvedValue(undefined);
  (safety.confirmAction as jest.Mock).mockResolvedValue(true);
  MockCardsAPI.prototype.getCard = jest.fn().mockResolvedValue({ cardId: 'card-1', boardId: 'board-1' });
});

describe('favro dependencies delete', () => {
  let consoleSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => { jest.restoreAllMocks(); });

  it('removes a single dependency', async () => {
    MockCardsAPI.prototype.unlinkCard = jest.fn().mockResolvedValue(undefined);

    await runCli(['dependencies', 'delete', 'card-1', 'card-2', '--yes']);

    expect(MockCardsAPI.prototype.unlinkCard).toHaveBeenCalledWith('card-1', 'card-2');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Dependency removed'));
  });

  it('dry-run previews', async () => {
    await runCli(['dependencies', 'delete', 'card-1', 'card-2', '--dry-run']);

    expect(safety.dryRunLog).toHaveBeenCalled();
    expect(MockCardsAPI.prototype.unlinkCard).not.toHaveBeenCalled();
  });
});

describe('favro dependencies delete-all', () => {
  let consoleSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => { jest.restoreAllMocks(); });

  it('removes all dependencies from a card', async () => {
    MockCardsAPI.prototype.deleteAllDependencies = jest.fn().mockResolvedValue(undefined);

    await runCli(['dependencies', 'delete-all', 'card-1', '--yes']);

    expect(MockCardsAPI.prototype.deleteAllDependencies).toHaveBeenCalledWith('card-1');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('All dependencies removed'));
  });

  it('aborts when user declines', async () => {
    (safety.confirmAction as jest.Mock).mockResolvedValue(false);

    await runCli(['dependencies', 'delete-all', 'card-1']);

    expect(MockCardsAPI.prototype.deleteAllDependencies).not.toHaveBeenCalled();
  });
});
