/**
 * Tests for boards update command
 * CLA-1784 FAVRO-022: Advanced Boards Endpoints
 */
import { Command } from 'commander';
import { registerBoardsUpdateCommand } from '../../commands/boards-update';
import BoardsAPI, { Board } from '../../lib/boards-api';
import FavroHttpClient from '../../lib/http-client';
import * as config from '../../lib/config';

jest.mock('../../lib/boards-api');
jest.mock('../../lib/http-client');
jest.mock('../../lib/config');

const sampleBoard: Board = {
  boardId: 'board-1',
  name: 'Updated Sprint',
  description: 'Updated description',
  collectionId: 'coll-1',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-02-01T00:00:00Z',
};

function buildProgram(mockUpdate: jest.Mock) {
  (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({} as any));
  (BoardsAPI as jest.MockedClass<typeof BoardsAPI>).mockImplementation(() => ({
    updateBoard: mockUpdate,
  } as any));

  const parent = new Command();
  parent.option('--verbose', 'verbose');
  const boardsCmd = parent.command('boards');
  registerBoardsUpdateCommand(boardsCmd);
  return parent;
}

describe('boards update command', () => {
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

  test('updates board name', async () => {
    const mockUpdate = jest.fn().mockResolvedValue(sampleBoard);
    const program = buildProgram(mockUpdate);
    await program.parseAsync(['node', 'test', 'boards', 'update', 'board-1', '--name', 'Updated Sprint']);
    expect(mockUpdate).toHaveBeenCalledWith('board-1', { name: 'Updated Sprint' });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('board-1'));
  });

  test('updates board description', async () => {
    const mockUpdate = jest.fn().mockResolvedValue(sampleBoard);
    const program = buildProgram(mockUpdate);
    await program.parseAsync([
      'node', 'test', 'boards', 'update', 'board-1', '--description', 'New description',
    ]);
    expect(mockUpdate).toHaveBeenCalledWith('board-1', { description: 'New description' });
  });

  test('updates both name and description', async () => {
    const mockUpdate = jest.fn().mockResolvedValue(sampleBoard);
    const program = buildProgram(mockUpdate);
    await program.parseAsync([
      'node', 'test', 'boards', 'update', 'board-1',
      '--name', 'New Name', '--description', 'New Desc',
    ]);
    expect(mockUpdate).toHaveBeenCalledWith('board-1', { name: 'New Name', description: 'New Desc' });
  });

  test('outputs json when --json flag provided', async () => {
    const mockUpdate = jest.fn().mockResolvedValue(sampleBoard);
    const program = buildProgram(mockUpdate);
    await program.parseAsync([
      'node', 'test', 'boards', 'update', 'board-1', '--name', 'Sprint', '--json',
    ]);
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(sampleBoard, null, 2));
  });

  test('dry-run does not call API', async () => {
    const mockUpdate = jest.fn();
    const program = buildProgram(mockUpdate);
    await program.parseAsync([
      'node', 'test', 'boards', 'update', 'board-1', '--name', 'Sprint', '--dry-run',
    ]);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[dry-run]'), expect.anything());
  });

  test('dry-run shows update data', async () => {
    const mockUpdate = jest.fn();
    const program = buildProgram(mockUpdate);
    await program.parseAsync([
      'node', 'test', 'boards', 'update', 'board-1', '--name', 'Sprint', '--dry-run',
    ]);
    const logCalls = consoleSpy.mock.calls.map(c => c.join(' '));
    expect(logCalls.some(c => c.includes('board-1') && c.includes('Sprint'))).toBe(true);
  });

  test('exits with error when no update fields provided', async () => {
    const mockUpdate = jest.fn();
    const program = buildProgram(mockUpdate);
    await expect(
      program.parseAsync(['node', 'test', 'boards', 'update', 'board-1'])
    ).rejects.toThrow('process.exit');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('No update fields'));
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('--json outputs JSON only (no text before JSON for piping)', async () => {
    const mockUpdate = jest.fn().mockResolvedValue(sampleBoard);
    const program = buildProgram(mockUpdate);
    await program.parseAsync([
      'node', 'test', 'boards', 'update', 'board-1', '--name', 'Sprint', '--json',
    ]);
    // Only one console.log call: the JSON output
    const logCalls = consoleSpy.mock.calls;
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0][0]).toBe(JSON.stringify(sampleBoard, null, 2));
  });

  test('exits with error when name is whitespace only', async () => {
    const mockUpdate = jest.fn();
    const program = buildProgram(mockUpdate);
    await expect(
      program.parseAsync(['node', 'test', 'boards', 'update', 'board-1', '--name', '   '])
    ).rejects.toThrow('process.exit');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: Board name cannot be empty or whitespace-only');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('exits with error when api key missing', async () => {
    jest.spyOn(config, 'resolveApiKey').mockResolvedValue(null as any);
    const mockUpdate = jest.fn();
    const program = buildProgram(mockUpdate);
    await expect(
      program.parseAsync(['node', 'test', 'boards', 'update', 'board-1', '--name', 'Sprint'])
    ).rejects.toThrow('process.exit');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error:'));
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('shows 404 error message for non-existent board', async () => {
    const err = Object.assign(new Error('Not Found'), { response: { status: 404 } });
    const mockUpdate = jest.fn().mockRejectedValue(err);
    const program = buildProgram(mockUpdate);
    await expect(
      program.parseAsync(['node', 'test', 'boards', 'update', 'bad-id', '--name', 'Sprint'])
    ).rejects.toThrow('process.exit');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Board not found'));
  });

  test('propagates general API errors', async () => {
    const err = new Error('Network error');
    const mockUpdate = jest.fn().mockRejectedValue(err);
    const program = buildProgram(mockUpdate);
    await expect(
      program.parseAsync(['node', 'test', 'boards', 'update', 'board-1', '--name', 'Sprint'])
    ).rejects.toThrow('process.exit');
  });
});
