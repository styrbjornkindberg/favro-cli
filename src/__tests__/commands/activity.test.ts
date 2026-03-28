/**
 * Unit tests — activity CLI commands
 * CLA-1789 FAVRO-027: Comments & Activity API
 */
import { Command } from 'commander';
import { registerActivityCommand } from '../../commands/activity';
import * as config from '../../lib/config';
import * as apiActivity from '../../api/activity';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../api/activity');

const MockActivityApiClient = apiActivity.default as jest.MockedClass<typeof apiActivity.default>;

// Mock parseSince to avoid import side effects
(apiActivity.parseSince as jest.Mock) = jest.fn().mockImplementation(
  (since: string | undefined) => {
    if (!since) return undefined;
    const match = since.match(/^(\d+)(h|d|w)$/i);
    if (!match) throw new Error(`Invalid --since value "${since}".`);
    const amount = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const multipliers: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 604_800_000 };
    return new Date(Date.now() - amount * multipliers[unit]);
  }
);

const SAMPLE_ACTIVITY = [
  {
    activityId: 'act-1',
    boardId: 'board-123',
    cardId: 'card-abc',
    cardName: 'Fix login bug',
    type: 'updated',
    description: 'Card "Fix login bug" was updated',
    author: 'alice',
    createdAt: '2026-03-25T10:00:00.000Z',
  },
  {
    activityId: 'act-2',
    boardId: 'board-123',
    cardId: 'card-def',
    cardName: 'Add tests',
    type: 'created',
    description: 'Card "Add tests" was created',
    createdAt: '2026-03-26T12:00:00.000Z',
  },
];

function buildProgram(): Command {
  const program = new Command();
  program.option('--verbose', 'Show stack traces');
  registerActivityCommand(program);
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
});

// ─── activity log ─────────────────────────────────────────────────────────────

describe('favro activity log', () => {
  let consoleSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  it('shows activity log for a board', async () => {
    MockActivityApiClient.prototype.getBoardActivity = jest.fn().mockResolvedValue(SAMPLE_ACTIVITY);

    await runCli(['activity', 'log', 'board-123']);

    expect(MockActivityApiClient.prototype.getBoardActivity).toHaveBeenCalledWith(
      'board-123',
      undefined,
      200,
      0
    );
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('2 entry'));
  });

  it('shows "no activity" when board has no entries', async () => {
    MockActivityApiClient.prototype.getBoardActivity = jest.fn().mockResolvedValue([]);

    await runCli(['activity', 'log', 'board-empty']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No activity found'));
  });

  it('outputs JSON when --format json is set', async () => {
    MockActivityApiClient.prototype.getBoardActivity = jest.fn().mockResolvedValue(SAMPLE_ACTIVITY);

    await runCli(['activity', 'log', 'board-123', '--format', 'json']);

    const jsonCall = consoleSpy.mock.calls.find(call =>
      typeof call[0] === 'string' && call[0].includes('activityId')
    );
    expect(jsonCall).toBeDefined();
    const parsed = JSON.parse(jsonCall![0]);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
  });

  it('outputs JSON when --json flag is set', async () => {
    MockActivityApiClient.prototype.getBoardActivity = jest.fn().mockResolvedValue(SAMPLE_ACTIVITY);

    await runCli(['activity', 'log', 'board-123', '--json']);

    const jsonCall = consoleSpy.mock.calls.find(call =>
      typeof call[0] === 'string' && call[0].includes('activityId')
    );
    expect(jsonCall).toBeDefined();
  });

  it('passes --since filter correctly', async () => {
    MockActivityApiClient.prototype.getBoardActivity = jest.fn().mockResolvedValue(SAMPLE_ACTIVITY);

    await runCli(['activity', 'log', 'board-123', '--since', '1d']);

    expect(MockActivityApiClient.prototype.getBoardActivity).toHaveBeenCalledWith(
      'board-123',
      expect.any(Date),
      200,
      0
    );
  });

  it('rejects invalid --since format', async () => {
    (apiActivity.parseSince as jest.Mock).mockImplementationOnce(() => {
      throw new Error('Invalid --since value "bad-format".');
    });

    await runCli(['activity', 'log', 'board-123', '--since', 'bad-format']);

    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error'));
  });

  it('respects --limit option', async () => {
    MockActivityApiClient.prototype.getBoardActivity = jest.fn().mockResolvedValue([SAMPLE_ACTIVITY[0]]);

    await runCli(['activity', 'log', 'board-123', '--limit', '50']);

    expect(MockActivityApiClient.prototype.getBoardActivity).toHaveBeenCalledWith(
      'board-123',
      undefined,
      50,
      0
    );
  });

  it('respects --offset option', async () => {
    MockActivityApiClient.prototype.getBoardActivity = jest.fn().mockResolvedValue([SAMPLE_ACTIVITY[1]]);

    await runCli(['activity', 'log', 'board-123', '--offset', '10']);

    expect(MockActivityApiClient.prototype.getBoardActivity).toHaveBeenCalledWith(
      'board-123',
      undefined,
      200,
      10
    );
  });

  it('exits with error when API key is missing', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);

    await runCli(['activity', 'log', 'board-123']);

    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error'));
  });

  it('exits with error when API call fails', async () => {
    MockActivityApiClient.prototype.getBoardActivity = jest.fn().mockRejectedValue(
      new Error('API error')
    );

    await runCli(['activity', 'log', 'board-123']);

    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('rejects invalid --format value', async () => {
    MockActivityApiClient.prototype.getBoardActivity = jest.fn().mockResolvedValue([]);

    await runCli(['activity', 'log', 'board-123', '--format', 'xml']);

    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid format'));
  });
});
