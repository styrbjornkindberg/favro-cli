/**
 * Unit tests — sprint-plan CLI command
 * CLA-1799 / FAVRO-037: Standup & Sprint Commands
 */
import { Command } from 'commander';
import { registerSprintPlanCommand, sprintPlanHandler } from '../../commands/sprint-plan';
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
  // The runner's three flags live on the root (ADR-0002).
  program.option('--verbose', 'Show stack traces').option('--human').option('--pretty');
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
    process.exitCode = undefined;
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
    process.exitCode = undefined;
  });

  it('calls getSuggestions with correct board name and default budget', async () => {
    await runCli(['sprint-plan', '--board', 'Sprint 42']);

    expect(MockSprintPlanAPI.prototype.getSuggestions).toHaveBeenCalledWith('Sprint 42', 40, 500);
  });

  it('passes custom budget to getSuggestions', async () => {
    await runCli(['sprint-plan', '--board', 'Sprint 42', '--budget', '20']);

    expect(MockSprintPlanAPI.prototype.getSuggestions).toHaveBeenCalledWith('Sprint 42', 20, 500);
  });

  it('outputs compact JSON by default; --pretty is the only way to widen it', async () => {
    await runCli(['sprint-plan', '--board', 'Sprint 42']);
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(SAMPLE_RESULT));

    consoleSpy.mockClear();
    await runCli(['sprint-plan', '--board', 'Sprint 42', '--pretty']);
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(SAMPLE_RESULT, null, 2));
  });

  it('outputs human-readable sprint plan under --human', async () => {
    await runCli(['sprint-plan', '--board', 'Sprint 42', '--human']);

    const allCalls = consoleSpy.mock.calls.map(c => c[0] as string).join('\n');
    expect(allCalls).toContain('Sprint 42');
    expect(allCalls).toContain('Within budget');
    expect(allCalls).toContain('Over budget');
  });

  it('shows card titles in output', async () => {
    await runCli(['sprint-plan', '--board', 'Sprint 42', '--human']);

    const allCalls = consoleSpy.mock.calls.map(c => c[0] as string).join('\n');
    expect(allCalls).toContain('High priority task');
  });

  const envelope = (spy: jest.SpyInstance) =>
    JSON.parse(spy.mock.calls.map((c) => c[0] as string).find((l) => l?.startsWith?.('{"error"'))!);

  it('refuses a missing --board, and says it is not worth retrying', async () => {
    await runCli(['sprint-plan']).catch(() => {});

    expect(envelope(consoleSpy).error.message).toContain('--board <name> is required');
    expect(envelope(consoleSpy).error.retryable).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('answers an error envelope when the API key is missing', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);

    await runCli(['sprint-plan', '--board', 'Sprint 42']).catch(() => {});

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/^\{"error":/));
    expect(process.exitCode).toBe(1);
  });

  it('answers an error envelope when getSuggestions throws', async () => {
    MockSprintPlanAPI.prototype.getSuggestions.mockRejectedValue(new Error('Board not found'));

    await runCli(['sprint-plan', '--board', 'unknown-board']).catch(() => {});

    expect(envelope(consoleSpy).error.message).toBe('Board not found');
    expect(process.exitCode).toBe(1);
  });

  it('refuses an invalid budget before any request goes out', async () => {
    await runCli(['sprint-plan', '--board', 'Sprint 42', '--budget', 'abc']).catch(() => {});

    expect(envelope(consoleSpy).error.message).toContain('--budget must be a positive number');
    expect(envelope(consoleSpy).error.retryable).toBe(false);
    expect(MockSprintPlanAPI.prototype.getSuggestions).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('names an unreadable part of the board rather than calling the backlog empty', async () => {
    // #116: "(no backlog cards found)" over a dead cards fetch is advice.
    MockSprintPlanAPI.prototype.getSuggestions.mockResolvedValue({
      ...SAMPLE_RESULT,
      suggestions: [], overflow: [], totalSuggested: 0,
      unreachable: [{ id: 'cards', reason: 'Request timed out' }],
    });

    await runCli(['sprint-plan', '--board', 'Sprint 42', '--human']);

    const all = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(all).toContain('no backlog cards found');
    expect(all).toContain('1 part(s) of this board could not be read');
    expect(all).toContain('cards — Request timed out');
  });

  it('the handler returns the plan as an item with a human formatter', async () => {
    const getSuggestions = jest.fn().mockResolvedValue(SAMPLE_RESULT);
    const result = await sprintPlanHandler(
      { api: { sprintPlan: { getSuggestions } } } as never,
      { board: 'Sprint 42', budget: '20', limit: '200' },
    );

    expect(getSuggestions).toHaveBeenCalledWith('Sprint 42', 20, 200);
    expect(result.item).toBe(SAMPLE_RESULT);
    expect(typeof result.human).toBe('function');
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

    await runCli(['sprint-plan', '--board', 'Sprint 42', '--human']);

    const allCalls = consoleSpy.mock.calls.map(c => c[0] as string).join('\n');
    expect(allCalls).toContain('no backlog cards found');
  });
});
