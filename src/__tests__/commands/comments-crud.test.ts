/**
 * Unit tests — comments get/update CLI commands
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

function buildProgram(): Command {
  const program = new Command();
  // The runner's three flags live on the root (ADR-0002).
  program.option('--verbose', 'Show stack traces').option('--human').option('--pretty');
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
  process.exitCode = undefined;
  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  (config.readConfig as jest.Mock).mockResolvedValue({});
  (safety.checkScope as jest.Mock).mockResolvedValue(undefined);
  (safety.confirmAction as jest.Mock).mockResolvedValue(true);
});

// ─── comments get ─────────────────────────────────────────────────────────────

describe('favro comments get', () => {
  let consoleSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('gets a single comment by ID', async () => {
    MockCommentsApiClient.prototype.getComment = jest.fn().mockResolvedValue({
      commentId: 'cmt-1',
      cardId: 'card-abc',
      text: 'Hello world',
      author: 'alice',
      createdAt: '2026-03-25T10:00:00.000Z',
    });

    await runCli(['comments', 'get', 'cmt-1', '--human']);

    expect(MockCommentsApiClient.prototype.getComment).toHaveBeenCalledWith('cmt-1');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('cmt-1'));
  });

  it('outputs JSON when --json is set', async () => {
    MockCommentsApiClient.prototype.getComment = jest.fn().mockResolvedValue({
      commentId: 'cmt-1',
      cardId: 'card-abc',
      text: 'Hello',
      createdAt: '2026-03-25T10:00:00.000Z',
    });

    await runCli(['comments', 'get', 'cmt-1']);

    const jsonCall = consoleSpy.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('commentId')
    );
    expect(jsonCall).toBeDefined();
    const parsed = JSON.parse(jsonCall![0]);
    expect(parsed.commentId).toBe('cmt-1');
  });

  it('answers an error envelope when the API call fails', async () => {
    MockCommentsApiClient.prototype.getComment = jest.fn().mockRejectedValue(new Error('Not found'));

    await runCli(['comments', 'get', 'cmt-bad']);

    // `process.exitCode`, never a hard exit — that is what #113 took away.
    expect(processExitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const envelope = JSON.parse(
      consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).find((l: string) => l.startsWith('{"error"'))!,
    );
    expect(envelope.error.message).toBe('Not found');
  });
});

// ─── comments update ──────────────────────────────────────────────────────────

describe('favro comments update', () => {
  let consoleSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('updates a comment', async () => {
    MockCommentsApiClient.prototype.updateComment = jest.fn().mockResolvedValue({
      commentId: 'cmt-1',
      text: 'Updated',
      createdAt: '2026-01-01T00:00:00Z',
    });

    await runCli(['comments', 'update', 'cmt-1', '--text', 'Updated', '--yes', '--human']);

    expect(MockCommentsApiClient.prototype.updateComment).toHaveBeenCalledWith('cmt-1', 'Updated');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Comment updated'));
  });

  it('dry-run previews without API call', async () => {
    await runCli(['comments', 'update', 'cmt-1', '--text', 'New text', '--dry-run', '--human']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[dry-run]'));
    expect(MockCommentsApiClient.prototype.updateComment).not.toHaveBeenCalled();
  });

  it('outputs JSON when --json is set', async () => {
    MockCommentsApiClient.prototype.updateComment = jest.fn().mockResolvedValue({
      commentId: 'cmt-1',
      text: 'Updated',
      createdAt: '2026-01-01T00:00:00Z',
    });

    await runCli(['comments', 'update', 'cmt-1', '--text', 'Updated', '--yes']);

    const jsonCall = consoleSpy.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('commentId')
    );
    expect(jsonCall).toBeDefined();
  });
});
