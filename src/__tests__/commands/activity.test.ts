/**
 * Unit tests — activity CLI command
 * CLA-1789 FAVRO-027: Comments & Activity API
 *
 * Rewritten for issue #18: the command is card-scoped (`favro activity <cardId>`),
 * because Favro has no board-level activity feed. The previous suite asserted
 * `getBoardActivity` and a row shape Favro never sends — see the wire test at
 * `src/__tests__/api/activity-wire.test.ts` for the real shape.
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
(apiActivity.formatTimestamp as jest.Mock) = jest.fn().mockImplementation(
  (iso: string | undefined) => iso ?? '(unknown time)'
);

const CARD = '0471a5fb295ef7e6a98fabbf';

const SAMPLE_ACTIVITY = [
  {
    type: 'card description changed',
    source: 'news and follow',
    cardId: CARD,
    cardCommonId: 'ce979d6e6913916fbebe84b3',
    cardName: 'Fix login bug',
    widgetCommonId: '77a732ee70173a24439818ca',
    widgetName: 'Kanban',
    columnId: 'a7c8e6d2cd492bb49a35f88d',
    columnName: 'To Do',
    time: '2026-03-26T12:00:00.000Z',
    byUserId: 'pk3qK36WHjnJt5jwr',
  },
  {
    type: 'create',
    source: 'news and follow',
    cardId: CARD,
    cardName: 'Fix login bug',
    widgetName: 'Kanban',
    columnName: 'To Do',
    time: '2026-03-25T10:00:00.000Z',
    byUserId: 'pk3qK36WHjnJt5jwr',
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

describe('favro activity <cardId>', () => {
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

  it('shows activity for a card', async () => {
    MockActivityApiClient.prototype.getCardActivity = jest.fn().mockResolvedValue(SAMPLE_ACTIVITY);

    await runCli(['activity', CARD]);

    // No cap reaches the client (#99) — `--limit` caps the print, not the read.
    expect(MockActivityApiClient.prototype.getCardActivity).toHaveBeenCalledWith(
      CARD,
      { since: undefined, until: undefined }
    );
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('CARD DESCRIPTION CHANGED');
    expect(output).toContain('Fix login bug');
    expect(output).toContain('Kanban / To Do');
  });

  it('reports the viewer-scoping caveat when the feed is empty', async () => {
    MockActivityApiClient.prototype.getCardActivity = jest.fn().mockResolvedValue([]);

    await runCli(['activity', CARD]);

    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('No activity found');
    expect(output).toContain('follows or has news for');
  });

  it('outputs JSON with --format json', async () => {
    MockActivityApiClient.prototype.getCardActivity = jest.fn().mockResolvedValue(SAMPLE_ACTIVITY);

    await runCli(['activity', CARD, '--format', 'json']);

    // An envelope, not a bare array — the shape every list read emits (#99).
    const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.truncated).toBeUndefined();
    expect(parsed.rows[0].time).toBe('2026-03-26T12:00:00.000Z');
    expect(parsed.rows[0].byUserId).toBe('pk3qK36WHjnJt5jwr');
  });

  it('accepts --json as shorthand', async () => {
    MockActivityApiClient.prototype.getCardActivity = jest.fn().mockResolvedValue(SAMPLE_ACTIVITY);

    await runCli(['activity', CARD, '--json']);

    expect(() => JSON.parse(consoleSpy.mock.calls[0][0])).not.toThrow();
  });

  it('passes --since through as a Date', async () => {
    MockActivityApiClient.prototype.getCardActivity = jest.fn().mockResolvedValue(SAMPLE_ACTIVITY);

    await runCli(['activity', CARD, '--since', '2h']);

    const options = MockActivityApiClient.prototype.getCardActivity.mock.calls[0][1]!;
    expect(options.since).toBeInstanceOf(Date);
    expect(options.until).toBeUndefined();
  });

  it('passes --until through as a Date', async () => {
    MockActivityApiClient.prototype.getCardActivity = jest.fn().mockResolvedValue(SAMPLE_ACTIVITY);

    await runCli(['activity', CARD, '--until', '1d']);

    const options = MockActivityApiClient.prototype.getCardActivity.mock.calls[0][1]!;
    expect(options.until).toBeInstanceOf(Date);
  });

  it('caps what --limit prints and marks the cut in JSON (#99)', async () => {
    MockActivityApiClient.prototype.getCardActivity = jest.fn().mockResolvedValue(SAMPLE_ACTIVITY);

    await runCli(['activity', CARD, '--limit', '1', '--json']);

    // No limit reaches the client at all — the read returns the whole feed.
    const options = MockActivityApiClient.prototype.getCardActivity.mock.calls[0][1]!;
    expect(options).not.toHaveProperty('limit');

    const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.truncated).toBe(true);
  });

  it('says in human mode what `truncated` says in JSON mode', async () => {
    MockActivityApiClient.prototype.getCardActivity = jest.fn().mockResolvedValue(SAMPLE_ACTIVITY);

    await runCli(['activity', CARD, '--limit', '1']);

    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('truncated to 1 of 2');
  });

  it('rejects an unparseable --since before calling the API', async () => {
    MockActivityApiClient.prototype.getCardActivity = jest.fn();

    await runCli(['activity', CARD, '--since', 'bad-format']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid --since'));
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('names --until in the error when --until is unparseable', async () => {
    MockActivityApiClient.prototype.getCardActivity = jest.fn();

    await runCli(['activity', CARD, '--until', 'bad-format']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid --until'));
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('rejects an unknown --format', async () => {
    MockActivityApiClient.prototype.getCardActivity = jest.fn();

    await runCli(['activity', CARD, '--format', 'xml']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid format'));
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('exits non-zero when the API errors', async () => {
    MockActivityApiClient.prototype.getCardActivity = jest
      .fn()
      .mockRejectedValue(new Error('403 Forbidden'));

    await runCli(['activity', CARD]);

    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('rejects the old `activity log <boardId>` form with a migration hint', async () => {
    MockActivityApiClient.prototype.getCardActivity = jest.fn();

    await runCli(['activity', 'log', 'board-123']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('is gone'));
    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(MockActivityApiClient.prototype.getCardActivity).not.toHaveBeenCalled();
  });
});
