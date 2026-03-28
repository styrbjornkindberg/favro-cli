/**
 * Unit tests — sprint-plan CLI command
 * CLA-1799 / FAVRO-037: Standup & Sprint Commands
 */
import { Command } from 'commander';
import { registerSprintPlanCommand } from '../../commands/sprint-plan';
import * as config from '../../lib/config';
import * as sprintPlanApi from '../../api/sprint-plan';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../api/sprint-plan');

const MockSprintPlanAPI = sprintPlanApi.SprintPlanAPI as jest.MockedClass<typeof sprintPlanApi.SprintPlanAPI>;

const SAMPLE_RESULT: sprintPlanApi.SprintPlanResult = {
  board: { id: 'boards-1234', name: 'Sprint 42' },
  budget: 40,
  totalSuggested: 7,
  suggestions: [
    { id: 'c1', title: 'High priority task', status: 'Backlog', assignees: [], priority: 'high', effort: 5, priorityScore: 3, cumulative: 5, withinBudget: true },
    { id: 'c2', title: 'Medium task', status: 'Backlog', assignees: ['alice'], priority: 'medium', effort: 2, priorityScore: 2, cumulative: 7, withinBudget: true },
  ],
  overflow: [
    { id: 'c3', title: 'Big task', status: 'Backlog', assignees: [], priority: 'low', effort: 50, priorityScore: 1, cumulative: 57, withinBudget: false },
  ],
  generatedAt: '2026-03-28T12:00:00.000Z',
};

function buildProgram(): Command {
  const program = new Command();
  program.option('--verbose', 'Show stack traces');
  registerSprintPlanCommand(program);
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
  MockSprintPlanAPI.prototype.getSuggestions.mockResolvedValue(SAMPLE_RESULT);
});

describe('favro sprint-plan', () => {
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

  it('calls getSuggestions with correct board name and default budget', async () => {
    await runCli(['sprint-plan', '--board', 'Sprint 42']);

    expect(MockSprintPlanAPI.prototype.getSuggestions).toHaveBeenCalledWith('Sprint 42', 40, 500);
  });

  it('passes custom budget to getSuggestions', async () => {
    await runCli(['sprint-plan', '--board', 'Sprint 42', '--budget', '20']);

    expect(MockSprintPlanAPI.prototype.getSuggestions).toHaveBeenCalledWith('Sprint 42', 20, 500);
  });

  it('outputs JSON with --json flag', async () => {
    await runCli(['sprint-plan', '--board', 'Sprint 42', '--json']);

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(SAMPLE_RESULT, null, 2));
  });

  it('outputs human-readable sprint plan by default', async () => {
    await runCli(['sprint-plan', '--board', 'Sprint 42']);

    const allCalls = consoleSpy.mock.calls.map(c => c[0] as string).join('\n');
    expect(allCalls).toContain('Sprint 42');
    expect(allCalls).toContain('Within budget');
    expect(allCalls).toContain('Over budget');
  });

  it('shows card titles in output', async () => {
    await runCli(['sprint-plan', '--board', 'Sprint 42']);

    const allCalls = consoleSpy.mock.calls.map(c => c[0] as string).join('\n');
    expect(allCalls).toContain('High priority task');
  });

  it('exits with error when --board is missing', async () => {
    await runCli(['sprint-plan']).catch(() => {});

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with error when API key is missing', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);

    await runCli(['sprint-plan', '--board', 'Sprint 42']).catch(() => {});

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with error when getSuggestions throws', async () => {
    MockSprintPlanAPI.prototype.getSuggestions.mockRejectedValue(new Error('Board not found'));

    await runCli(['sprint-plan', '--board', 'unknown-board']).catch(() => {});

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with error for invalid budget', async () => {
    await runCli(['sprint-plan', '--board', 'Sprint 42', '--budget', 'abc']).catch(() => {});

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('passes custom limit to getSuggestions', async () => {
    await runCli(['sprint-plan', '--board', 'Sprint 42', '--limit', '200']);

    expect(MockSprintPlanAPI.prototype.getSuggestions).toHaveBeenCalledWith('Sprint 42', 40, 200);
  });

  it('shows (no backlog cards found) when both lists are empty', async () => {
    MockSprintPlanAPI.prototype.getSuggestions.mockResolvedValue({
      ...SAMPLE_RESULT,
      suggestions: [],
      overflow: [],
      totalSuggested: 0,
    });

    await runCli(['sprint-plan', '--board', 'Sprint 42']);

    const allCalls = consoleSpy.mock.calls.map(c => c[0] as string).join('\n');
    expect(allCalls).toContain('no backlog cards found');
  });
});
