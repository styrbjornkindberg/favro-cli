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
  // The root flags the real CLI declares (cli.ts) — all three are read off the
  // root here exactly as they are there.
  program.option('--verbose', 'Show stack traces').option('--human').option('--pretty');
  registerCommentsCommand(program);
  return program;
}

async function runCli(args: string[]): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  await program.parseAsync(['node', 'favro', ...args]);
}

/** The runner's error envelope, off whatever went to stdout. */
const errorEnvelope = (spy: jest.SpyInstance) =>
  JSON.parse(spy.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('{"error"'))!);

beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = undefined;
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

    await runCli(['comments', 'list', 'card-abc', '--human']);

    // No limit reaches the client at all (#136) — the fetch runs to completion.
    expect(MockCommentsApiClient.prototype.listComments).toHaveBeenCalledWith('card-abc');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('2 comment'));
  });

  it('shows "no comments" when card has no comments', async () => {
    MockCommentsApiClient.prototype.listComments = jest.fn().mockResolvedValue([]);

    await runCli(['comments', 'list', 'card-empty', '--human']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No comments found'));
  });

  it('outputs the JSON envelope by default — --json is gone from the leaf', async () => {
    MockCommentsApiClient.prototype.listComments = jest.fn().mockResolvedValue(SAMPLE_COMMENTS);

    await runCli(['comments', 'list', 'card-abc']);

    const jsonCall = consoleSpy.mock.calls.find(call =>
      typeof call[0] === 'string' && call[0].includes('commentId')
    );
    expect(jsonCall).toBeDefined();
    const parsed = JSON.parse(jsonCall![0]);
    // An envelope, not a bare array — the shape every list read emits (#136).
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.truncated).toBeUndefined();
    // Compact unless `--pretty` asks otherwise.
    expect(jsonCall![0]).not.toContain('\n');
  });

  it('honours the root --pretty flag (#136)', async () => {
    MockCommentsApiClient.prototype.listComments = jest.fn().mockResolvedValue(SAMPLE_COMMENTS);

    await runCli(['--pretty', 'comments', 'list', 'card-abc']);

    const jsonCall = consoleSpy.mock.calls.find(call =>
      typeof call[0] === 'string' && call[0].includes('commentId')
    );
    expect(jsonCall![0]).toContain('\n  "rows"');
  });

  it('caps what --limit prints and marks the cut in JSON', async () => {
    MockCommentsApiClient.prototype.listComments = jest.fn().mockResolvedValue(SAMPLE_COMMENTS);

    await runCli(['comments', 'list', 'card-abc', '--limit', '1']);

    expect(MockCommentsApiClient.prototype.listComments).toHaveBeenCalledWith('card-abc');
    const jsonCall = consoleSpy.mock.calls.find(call =>
      typeof call[0] === 'string' && call[0].includes('commentId')
    );
    const parsed = JSON.parse(jsonCall![0]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.truncated).toBe(true);
  });

  it('never prints a capped count as the total', async () => {
    MockCommentsApiClient.prototype.listComments = jest.fn().mockResolvedValue(SAMPLE_COMMENTS);

    await runCli(['comments', 'list', 'card-abc', '--limit', '1', '--human']);

    // #136's guarantee, now written by the runner's `noteTruncation` rather
    // than by this command (#99): a `human` formatter is handed rows and cannot
    // see the cut, so one place says it for every migrated list read.
    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('truncated to 1 of 2');
    expect(output).not.toContain('2 comment(s)');
  });

  it('a non-numeric --limit refuses rather than falling back (#99 → #142)', async () => {
    const read = jest.fn().mockResolvedValue(SAMPLE_COMMENTS);
    MockCommentsApiClient.prototype.listComments = read;

    await runCli(['comments', 'list', 'card-abc', '--limit', '1e9']);

    // #99 stopped it capping at 1; #142 stopped it answering at all. The old
    // fallback to 100 was a number invented from a value we could not read.
    const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0]));
    expect(parsed.rows).toBeUndefined();
    expect(parsed.error.message).toContain('1e9');
    expect(parsed.error.retryable).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(read).not.toHaveBeenCalled();
  });

  it('answers an error envelope when the API key is missing', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);

    await runCli(['comments', 'list', 'card-abc']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/^\{"error":/));
    expect(process.exitCode).toBe(1);
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('answers an error envelope when the API call fails', async () => {
    MockCommentsApiClient.prototype.listComments = jest.fn().mockRejectedValue(
      new Error('API error')
    );

    await runCli(['comments', 'list', 'card-abc']);

    expect(errorEnvelope(consoleSpy).error.message).toBe('API error');
    expect(process.exitCode).toBe(1);
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

    await runCli(['comments', 'add', 'card-abc', '--text', 'Hello world', '--human']);

    expect(MockCommentsApiClient.prototype.addComment).toHaveBeenCalledWith('card-abc', 'Hello world');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('cmt-new'));
  });

  it('outputs the created comment as JSON by default', async () => {
    const newComment = { ...SAMPLE_COMMENTS[0], commentId: 'cmt-new', text: 'Hello world' };
    MockCommentsApiClient.prototype.addComment = jest.fn().mockResolvedValue(newComment);

    await runCli(['comments', 'add', 'card-abc', '--text', 'Hello world']);

    const jsonCall = consoleSpy.mock.calls.find(call =>
      typeof call[0] === 'string' && call[0].includes('commentId')
    );
    expect(jsonCall).toBeDefined();
    const parsed = JSON.parse(jsonCall![0]);
    expect(parsed.commentId).toBe('cmt-new');
  });

  it('answers an error envelope when the API key is missing', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);

    await runCli(['comments', 'add', 'card-abc', '--text', 'Test']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/^\{"error":/));
    expect(process.exitCode).toBe(1);
  });

  it('answers an error envelope when the API call fails', async () => {
    MockCommentsApiClient.prototype.addComment = jest.fn().mockRejectedValue(
      new Error('API error')
    );

    await runCli(['comments', 'add', 'card-abc', '--text', 'Test']);

    expect(errorEnvelope(consoleSpy).error.message).toBe('API error');
    expect(process.exitCode).toBe(1);
  });

  it('refuses empty text before it resolves anything', async () => {
    MockCommentsApiClient.prototype.addComment = jest.fn();

    await runCli(['comments', 'add', 'card-abc', '--text', '   ']);

    expect(errorEnvelope(consoleSpy).error.message).toBe('Comment text cannot be empty.');
    expect(errorEnvelope(consoleSpy).error.retryable).toBe(false);
    expect(MockCommentsApiClient.prototype.addComment).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('a declined confirmation is exit 0 and a readable result, not silence', async () => {
    (safety.confirmAction as jest.Mock).mockResolvedValue(false);
    MockCommentsApiClient.prototype.addComment = jest.fn();

    await runCli(['comments', 'add', 'card-abc', '--text', 'Test']);

    expect(MockCommentsApiClient.prototype.addComment).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      JSON.stringify({ added: false, aborted: true, cardId: 'card-abc' }),
    );
    expect(process.exitCode).toBeUndefined();
  });
});
