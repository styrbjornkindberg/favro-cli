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

    await runCli(['comments', 'get', 'cmt-1']);

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

    await runCli(['comments', 'get', 'cmt-1', '--json']);

    const jsonCall = consoleSpy.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('commentId')
    );
    expect(jsonCall).toBeDefined();
    const parsed = JSON.parse(jsonCall![0]);
    expect(parsed.commentId).toBe('cmt-1');
  });

  it('exits with error when API call fails', async () => {
    MockCommentsApiClient.prototype.getComment = jest.fn().mockRejectedValue(new Error('Not found'));

    await runCli(['comments', 'get', 'cmt-bad']);

    expect(processExitSpy).toHaveBeenCalledWith(1);
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

    await runCli(['comments', 'update', 'cmt-1', '--text', 'Updated', '--yes']);

    expect(MockCommentsApiClient.prototype.updateComment).toHaveBeenCalledWith('cmt-1', 'Updated');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Comment updated'));
  });

  it('dry-run previews without API call', async () => {
    await runCli(['comments', 'update', 'cmt-1', '--text', 'New text', '--dry-run']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[dry-run]'));
    expect(MockCommentsApiClient.prototype.updateComment).not.toHaveBeenCalled();
  });

  it('outputs JSON when --json is set', async () => {
    MockCommentsApiClient.prototype.updateComment = jest.fn().mockResolvedValue({
      commentId: 'cmt-1',
      text: 'Updated',
      createdAt: '2026-01-01T00:00:00Z',
    });

    await runCli(['comments', 'update', 'cmt-1', '--text', 'Updated', '--yes', '--json']);

    const jsonCall = consoleSpy.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('commentId')
    );
    expect(jsonCall).toBeDefined();
  });
});
