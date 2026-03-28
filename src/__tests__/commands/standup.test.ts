/**
 * Unit tests — standup CLI command
 * CLA-1799 / FAVRO-037: Standup & Sprint Commands
 */
import { Command } from 'commander';
import { registerStandupCommand } from '../../commands/standup';
import * as config from '../../lib/config';
import * as standupApi from '../../api/standup';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../api/standup');

const MockStandupAPI = standupApi.StandupAPI as jest.MockedClass<typeof standupApi.StandupAPI>;

const SAMPLE_RESULT: standupApi.StandupResult = {
  board: { id: 'boards-1234', name: 'Sprint 42' },
  completed: [
    { id: 'c1', title: 'Fix login bug', status: 'Done', assignees: ['alice'], group: 'completed' },
  ],
  inProgress: [
    { id: 'c2', title: 'Add dashboard', status: 'In Progress', assignees: [], group: 'in-progress' },
  ],
  blocked: [
    { id: 'c3', title: 'API integration', status: 'Blocked', assignees: ['bob'], group: 'blocked' },
  ],
  dueSoon: [],
  total: 10,
  generatedAt: '2026-03-28T12:00:00.000Z',
};

function buildProgram(): Command {
  const program = new Command();
  program.option('--verbose', 'Show stack traces');
  registerStandupCommand(program);
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
  MockStandupAPI.prototype.getStandup.mockResolvedValue(SAMPLE_RESULT);
});

describe('favro standup', () => {
  let consoleSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('calls getStandup with correct board name', async () => {
    await runCli(['standup', '--board', 'Sprint 42']);

    expect(MockStandupAPI.prototype.getStandup).toHaveBeenCalledWith('Sprint 42', 500);
  });

  it('outputs JSON with --json flag', async () => {
    await runCli(['standup', '--board', 'Sprint 42', '--json']);

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(SAMPLE_RESULT, null, 2));
  });

  it('outputs human-readable standup by default', async () => {
    await runCli(['standup', '--board', 'Sprint 42']);

    // Should print board name and groups
    const allCalls = consoleSpy.mock.calls.map(c => c[0] as string).join('\n');
    expect(allCalls).toContain('Sprint 42');
    expect(allCalls).toContain('Completed');
    expect(allCalls).toContain('In Progress');
    expect(allCalls).toContain('Blocked');
  });

  it('exits with error when --board is missing', async () => {
    await runCli(['standup']).catch(() => {});

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with error when API key is missing', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);

    await runCli(['standup', '--board', 'Sprint 42']).catch(() => {});

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with error when getStandup throws', async () => {
    MockStandupAPI.prototype.getStandup.mockRejectedValue(new Error('Board not found'));

    await runCli(['standup', '--board', 'unknown-board']).catch(() => {});

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('passes custom limit to getStandup', async () => {
    await runCli(['standup', '--board', 'Sprint 42', '--limit', '100']);

    expect(MockStandupAPI.prototype.getStandup).toHaveBeenCalledWith('Sprint 42', 100);
  });

  it('shows (none) when group is empty', async () => {
    MockStandupAPI.prototype.getStandup.mockResolvedValue({
      ...SAMPLE_RESULT,
      dueSoon: [],
    });

    await runCli(['standup', '--board', 'Sprint 42']);

    const allCalls = consoleSpy.mock.calls.map(c => c[0] as string).join('\n');
    expect(allCalls).toContain('(none)');
  });
});
