/**
 * Tests for boards get command
 * CLA-1784 FAVRO-022: Advanced Boards Endpoints
 */
import { Command } from 'commander';
import { registerBoardsGetCommand } from '../../commands/boards-get';
import BoardsAPI, { ExtendedBoard } from '../../lib/boards-api';
import FavroHttpClient from '../../lib/http-client';
import * as config from '../../lib/config';

jest.mock('../../lib/boards-api');
jest.mock('../../lib/http-client');
jest.mock('../../lib/config');

const sampleBoard: ExtendedBoard = {
  boardId: 'board-1',
  name: 'Sprint Board',
  description: 'Active sprint',
  type: 'board',
  collectionId: 'coll-1',
  cardCount: 10,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-02-01T00:00:00Z',
};

function buildProgram(mockGetBoardWithIncludes: jest.Mock) {
  (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({} as any));
  (BoardsAPI as jest.MockedClass<typeof BoardsAPI>).mockImplementation(() => ({
    getBoardWithIncludes: mockGetBoardWithIncludes,
  } as any));

  const parent = new Command();
  parent.option('--verbose', 'verbose');
  const boardsCmd = parent.command('boards');
  registerBoardsGetCommand(boardsCmd);
  return parent;
}

describe('boards get command', () => {
  let consoleSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    jest.spyOn(config, 'resolveApiKey').mockResolvedValue('test-token');
  });

  afterEach(() => jest.restoreAllMocks());

  test('gets board by id and prints details', async () => {
    const mockGet = jest.fn().mockResolvedValue(sampleBoard);
    const program = buildProgram(mockGet);
    await program.parseAsync(['node', 'test', 'boards', 'get', 'board-1']);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Sprint Board'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('board-1'));
    expect(mockGet).toHaveBeenCalledWith('board-1', undefined);
  });

  test('gets board with --include option', async () => {
    const mockGet = jest.fn().mockResolvedValue(sampleBoard);
    const program = buildProgram(mockGet);
    await program.parseAsync(['node', 'test', 'boards', 'get', 'board-1', '--include', 'members,stats']);
    expect(mockGet).toHaveBeenCalledWith('board-1', ['members', 'stats']);
  });

  test('gets board with all include options', async () => {
    const mockGet = jest.fn().mockResolvedValue(sampleBoard);
    const program = buildProgram(mockGet);
    await program.parseAsync([
      'node', 'test', 'boards', 'get', 'board-1',
      '--include', 'custom-fields,cards,members,stats,velocity',
    ]);
    expect(mockGet).toHaveBeenCalledWith('board-1', ['custom-fields', 'cards', 'members', 'stats', 'velocity']);
  });

  test('outputs json when --json flag provided', async () => {
    const mockGet = jest.fn().mockResolvedValue(sampleBoard);
    const program = buildProgram(mockGet);
    await program.parseAsync(['node', 'test', 'boards', 'get', 'board-1', '--json']);
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(sampleBoard, null, 2));
  });

  test('shows 404 error message for non-existent board', async () => {
    const err = Object.assign(new Error('Not Found'), { response: { status: 404 } });
    const mockGet = jest.fn().mockRejectedValue(err);
    const program = buildProgram(mockGet);
    await expect(
      program.parseAsync(['node', 'test', 'boards', 'get', 'bad-id'])
    ).rejects.toThrow('process.exit');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Board not found'));
  });

  test('exits with error for invalid include option', async () => {
    const mockGet = jest.fn().mockResolvedValue(sampleBoard);
    const program = buildProgram(mockGet);
    await expect(
      program.parseAsync(['node', 'test', 'boards', 'get', 'board-1', '--include', 'invalid-option'])
    ).rejects.toThrow('process.exit');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid include option'));
  });

  test('exits with error when api key missing', async () => {
    jest.spyOn(config, 'resolveApiKey').mockResolvedValue(null as any);
    const mockGet = jest.fn();
    const program = buildProgram(mockGet);
    await expect(
      program.parseAsync(['node', 'test', 'boards', 'get', 'board-1'])
    ).rejects.toThrow('process.exit');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error:'));
    expect(mockGet).not.toHaveBeenCalled();
  });

  test('shows members when included in response', async () => {
    const boardWithMembers: ExtendedBoard = {
      ...sampleBoard,
      members: [{ userId: 'u1', name: 'Alice', email: 'alice@example.com', role: 'admin' }],
    };
    const mockGet = jest.fn().mockResolvedValue(boardWithMembers);
    const program = buildProgram(mockGet);
    await program.parseAsync(['node', 'test', 'boards', 'get', 'board-1', '--include', 'members']);
    // Should print members table - just check it called console.log multiple times
    expect(consoleSpy.mock.calls.length).toBeGreaterThan(2);
  });

  test('shows stats when included in response', async () => {
    const boardWithStats: ExtendedBoard = {
      ...sampleBoard,
      stats: { totalCards: 10, doneCards: 5, openCards: 5, overdueCards: 1 },
    };
    const mockGet = jest.fn().mockResolvedValue(boardWithStats);
    const program = buildProgram(mockGet);
    await program.parseAsync(['node', 'test', 'boards', 'get', 'board-1', '--include', 'stats']);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Stats'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('10'));
  });

  test('shows velocity when included in response', async () => {
    const boardWithVelocity: ExtendedBoard = {
      ...sampleBoard,
      velocity: [{ period: '2026-01-01 to 2026-01-07', completed: 3, added: 2, netChange: 3 }],
    };
    const mockGet = jest.fn().mockResolvedValue(boardWithVelocity);
    const program = buildProgram(mockGet);
    await program.parseAsync(['node', 'test', 'boards', 'get', 'board-1', '--include', 'velocity']);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Velocity'));
  });

  test('shows custom fields when included in response', async () => {
    const boardWithFields: ExtendedBoard = {
      ...sampleBoard,
      customFields: [{ fieldId: 'f1', name: 'Priority', type: 'select', options: ['High', 'Low'] }],
    };
    const mockGet = jest.fn().mockResolvedValue(boardWithFields);
    const program = buildProgram(mockGet);
    await program.parseAsync(['node', 'test', 'boards', 'get', 'board-1', '--include', 'custom-fields']);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Custom Fields'));
  });

  test('propagates general API errors', async () => {
    const err = new Error('Network error');
    const mockGet = jest.fn().mockRejectedValue(err);
    const program = buildProgram(mockGet);
    await expect(
      program.parseAsync(['node', 'test', 'boards', 'get', 'board-1'])
    ).rejects.toThrow('process.exit');
  });
});
