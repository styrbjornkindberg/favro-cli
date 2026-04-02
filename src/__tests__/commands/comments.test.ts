/**
 * Unit tests — comments CLI commands
 * CLA-1789 FAVRO-027: Comments & Activity API
 */
import { Command } from 'commander';
import { registerCommentsCommand } from '../../commands/comments';
import * as config from '../../lib/config';
import * as apiComments from '../../api/comments';
import * as safety from '../../lib/safety';
import CardsAPI from '../../lib/cards-api';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../api/comments');
jest.mock('../../lib/safety');
jest.mock('../../lib/cards-api');

const MockCommentsApiClient = apiComments.default as jest.MockedClass<typeof apiComments.default>;
const MockCardsAPI = CardsAPI as jest.MockedClass<typeof CardsAPI>;

const SAMPLE_COMMENTS = [
  {
    commentId: 'cmt-1',
    cardId: 'card-abc',
    text: 'This is the first comment',
    author: 'alice',
    createdAt: '2026-03-25T10:00:00.000Z',
  },
  {
    commentId: 'cmt-2',
    cardId: 'card-abc',
    text: 'Second comment here',
    author: 'bob',
    createdAt: '2026-03-26T12:00:00.000Z',
  },
];

function buildProgram(): Command {
  const program = new Command();
  program.option('--verbose', 'Show stack traces');
  registerCommentsCommand(program);
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
  MockCardsAPI.prototype.getCard = jest.fn().mockResolvedValue({ cardId: 'card-abc', boardId: 'board-1' });
});

// ─── comments list ────────────────────────────────────────────────────────────

describe('favro comments list', () => {
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

  it('lists comments for a card', async () => {
    MockCommentsApiClient.prototype.listComments = jest.fn().mockResolvedValue(SAMPLE_COMMENTS);

    await runCli(['comments', 'list', 'card-abc']);

    expect(MockCommentsApiClient.prototype.listComments).toHaveBeenCalledWith('card-abc', 100);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('2 comment'));
  });

  it('shows "no comments" when card has no comments', async () => {
    MockCommentsApiClient.prototype.listComments = jest.fn().mockResolvedValue([]);

    await runCli(['comments', 'list', 'card-empty']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No comments found'));
  });

  it('outputs JSON when --json flag is set', async () => {
    MockCommentsApiClient.prototype.listComments = jest.fn().mockResolvedValue(SAMPLE_COMMENTS);

    await runCli(['comments', 'list', 'card-abc', '--json']);

    const jsonCall = consoleSpy.mock.calls.find(call =>
      typeof call[0] === 'string' && call[0].includes('commentId')
    );
    expect(jsonCall).toBeDefined();
    const parsed = JSON.parse(jsonCall![0]);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
  });

  it('respects --limit option', async () => {
    MockCommentsApiClient.prototype.listComments = jest.fn().mockResolvedValue([SAMPLE_COMMENTS[0]]);

    await runCli(['comments', 'list', 'card-abc', '--limit', '1']);

    expect(MockCommentsApiClient.prototype.listComments).toHaveBeenCalledWith('card-abc', 1);
  });

  it('exits with error when API key is missing', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);

    await runCli(['comments', 'list', 'card-abc']);

    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error'));
  });

  it('exits with error when API call fails', async () => {
    MockCommentsApiClient.prototype.listComments = jest.fn().mockRejectedValue(
      new Error('API error')
    );

    await runCli(['comments', 'list', 'card-abc']);

    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});

// ─── comments add ─────────────────────────────────────────────────────────────

describe('favro comments add', () => {
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

  it('adds a comment to a card', async () => {
    const newComment = { ...SAMPLE_COMMENTS[0], commentId: 'cmt-new', text: 'Hello world' };
    MockCommentsApiClient.prototype.addComment = jest.fn().mockResolvedValue(newComment);

    await runCli(['comments', 'add', 'card-abc', '--text', 'Hello world']);

    expect(MockCommentsApiClient.prototype.addComment).toHaveBeenCalledWith('card-abc', 'Hello world');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('cmt-new'));
  });

  it('outputs JSON when --json is set', async () => {
    const newComment = { ...SAMPLE_COMMENTS[0], commentId: 'cmt-new', text: 'Hello world' };
    MockCommentsApiClient.prototype.addComment = jest.fn().mockResolvedValue(newComment);

    await runCli(['comments', 'add', 'card-abc', '--text', 'Hello world', '--json']);

    const jsonCall = consoleSpy.mock.calls.find(call =>
      typeof call[0] === 'string' && call[0].includes('commentId')
    );
    expect(jsonCall).toBeDefined();
    const parsed = JSON.parse(jsonCall![0]);
    expect(parsed.commentId).toBe('cmt-new');
  });

  it('exits with error when API key is missing', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);

    await runCli(['comments', 'add', 'card-abc', '--text', 'Test']);

    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error'));
  });

  it('exits with error when API call fails', async () => {
    MockCommentsApiClient.prototype.addComment = jest.fn().mockRejectedValue(
      new Error('API error')
    );

    await runCli(['comments', 'add', 'card-abc', '--text', 'Test']);

    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});
