/**
 * Unit tests — standup CLI command
 * CLA-1799 / FAVRO-037: Standup & Sprint Commands
 */
import { Command } from 'commander';
import { registerStandupCommand, standupHandler } from '../../commands/standup';
import * as config from '../../lib/config';
import * as standupApi from '../../api/standup';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../api/standup');

const MockStandupAPI = standupApi.StandupAPI as jest.MockedClass<typeof standupApi.StandupAPI>;

const SAMPLE_RESULT: standupApi.StandupResult = {
  board: { id: 'boards-1234', name: 'Sprint 42' },
  completed: [
    { id: 'c1', title: 'Fix login bug', status: 'Done', assignees: ['alice'], dependencies: 0, group: 'completed' },
  ],
  inProgress: [
    { id: 'c2', title: 'Add dashboard', status: 'In Progress', assignees: [], dependencies: 0, group: 'in-progress' },
  ],
  blocked: [
    { id: 'c3', title: 'API integration', status: 'Blocked', assignees: ['bob'], dependencies: 1, group: 'blocked' },
  ],
  dueSoon: [],
  total: 10,
  generatedAt: '2026-03-28T12:00:00.000Z',
};

function buildProgram(): Command {
  const program = new Command();
  // The runner's three flags live on the root (ADR-0002).
  program.option('--verbose', 'Show stack traces').option('--human').option('--pretty');
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
    process.exitCode = undefined;
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
    process.exitCode = undefined;
  });

  it('calls getStandup with correct board name', async () => {
    await runCli(['standup', '--board', 'Sprint 42']);

    expect(MockStandupAPI.prototype.getStandup).toHaveBeenCalledWith('Sprint 42', 500);
  });

  it('outputs compact JSON by default; --pretty is the only way to widen it', async () => {
    // `--json` is gone from the leaf (#116): JSON is the default and `--human`
    // is the way out (ADR-0002).
    await runCli(['standup', '--board', 'Sprint 42']);
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(SAMPLE_RESULT));

    consoleSpy.mockClear();
    await runCli(['standup', '--board', 'Sprint 42', '--pretty']);
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(SAMPLE_RESULT, null, 2));
  });

  it('outputs human-readable standup under --human', async () => {
    await runCli(['standup', '--board', 'Sprint 42', '--human']);

    // Should print board name and groups
    const allCalls = consoleSpy.mock.calls.map(c => c[0] as string).join('\n');
    expect(allCalls).toContain('Sprint 42');
    expect(allCalls).toContain('Completed');
    expect(allCalls).toContain('In Progress');
    expect(allCalls).toContain('Blocked');
  });

  it('shows the dependency edge count on cards that carry one', async () => {
    await runCli(['standup', '--board', 'Sprint 42', '--human']);

    const lines = consoleSpy.mock.calls.map(c => c[0] as string);
    // c3 carries one edge; c2 carries none and must stay clean.
    expect(lines.find(l => l?.includes?.('API integration'))).toContain('[deps: 1]');
    expect(lines.find(l => l?.includes?.('Add dashboard'))).not.toContain('deps');
  });

  it('refuses a missing --board, and says it is not worth retrying', async () => {
    await runCli(['standup']).catch(() => {});

    const envelope = JSON.parse(consoleSpy.mock.calls.map((c) => c[0] as string).find((l) => l?.startsWith?.('{"error"'))!);
    expect(envelope.error.message).toContain('--board <name> is required');
    // A deterministic decline: the same call refuses identically (`refusal.ts`).
    expect(envelope.error.retryable).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('answers an error envelope when the API key is missing', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);

    await runCli(['standup', '--board', 'Sprint 42']).catch(() => {});

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/^\{"error":/));
    expect(process.exitCode).toBe(1);
  });

  it('answers an error envelope when getStandup throws', async () => {
    MockStandupAPI.prototype.getStandup.mockRejectedValue(new Error('Board not found'));

    await runCli(['standup', '--board', 'unknown-board']).catch(() => {});

    const envelope = JSON.parse(consoleSpy.mock.calls.map((c) => c[0] as string).find((l) => l?.startsWith?.('{"error"'))!);
    expect(envelope.error.message).toBe('Board not found');
    expect(process.exitCode).toBe(1);
  });

  it('names an unreadable part of the board instead of reporting it as zero cards', async () => {
    // #116: `total: 0` from a dead cards fetch used to be indistinguishable
    // from an empty board.
    MockStandupAPI.prototype.getStandup.mockResolvedValue({
      ...SAMPLE_RESULT,
      completed: [], inProgress: [], blocked: [], total: 0,
      unreachable: [{ id: 'cards', reason: 'Request timed out' }],
    });

    await runCli(['standup', '--board', 'Sprint 42', '--human']);

    const all = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(all).toContain('1 part(s) of this board could not be read');
    expect(all).toContain('cards — Request timed out');
  });

  it('the handler returns the result as an item with a human formatter', async () => {
    const getStandup = jest.fn().mockResolvedValue(SAMPLE_RESULT);
    const result = await standupHandler(
      { api: { standup: { getStandup } } } as never,
      { board: 'Sprint 42', limit: '250' },
    );

    expect(getStandup).toHaveBeenCalledWith('Sprint 42', 250);
    expect(result.item).toBe(SAMPLE_RESULT);
    expect(typeof result.human).toBe('function');
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

    await runCli(['standup', '--board', 'Sprint 42', '--human']);

    const allCalls = consoleSpy.mock.calls.map(c => c[0] as string).join('\n');
    expect(allCalls).toContain('(none)');
  });
});
