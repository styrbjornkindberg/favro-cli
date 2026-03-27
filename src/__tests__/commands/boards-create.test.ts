/**
 * Tests for boards create command
 * CLA-1784 FAVRO-022: Advanced Boards Endpoints
 */
import { Command } from 'commander';
import { registerBoardsCreateCommand } from '../../commands/boards-create';
import BoardsAPI, { Board, BoardType } from '../../lib/boards-api';
import FavroHttpClient from '../../lib/http-client';
import * as config from '../../lib/config';

jest.mock('../../lib/boards-api');
jest.mock('../../lib/http-client');
jest.mock('../../lib/config');

const sampleBoard: Board = {
  boardId: 'board-new',
  name: 'My Sprint',
  type: 'board' as BoardType,
  collectionId: 'coll-1',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function buildProgram(mockCreate: jest.Mock) {
  (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({} as any));
  (BoardsAPI as jest.MockedClass<typeof BoardsAPI>).mockImplementation(() => ({
    createBoardInCollection: mockCreate,
  } as any));

  const parent = new Command();
  parent.option('--verbose', 'verbose');
  const boardsCmd = parent.command('boards');
  registerBoardsCreateCommand(boardsCmd);
  return parent;
}

describe('boards create command', () => {
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

  test('creates board with name and collection-id', async () => {
    const mockCreate = jest.fn().mockResolvedValue(sampleBoard);
    const program = buildProgram(mockCreate);
    await program.parseAsync(['node', 'test', 'boards', 'create', 'coll-1', '--name', 'My Sprint']);
    expect(mockCreate).toHaveBeenCalledWith('coll-1', {
      name: 'My Sprint',
      type: 'board',
      description: undefined,
    });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('board-new'));
  });

  test('creates board with kanban type', async () => {
    const mockCreate = jest.fn().mockResolvedValue(sampleBoard);
    const program = buildProgram(mockCreate);
    await program.parseAsync(['node', 'test', 'boards', 'create', 'coll-1', '--name', 'Kanban', '--type', 'kanban']);
    expect(mockCreate).toHaveBeenCalledWith('coll-1', expect.objectContaining({ type: 'kanban' }));
  });

  test('creates board with list type', async () => {
    const mockCreate = jest.fn().mockResolvedValue(sampleBoard);
    const program = buildProgram(mockCreate);
    await program.parseAsync(['node', 'test', 'boards', 'create', 'coll-1', '--name', 'List', '--type', 'list']);
    expect(mockCreate).toHaveBeenCalledWith('coll-1', expect.objectContaining({ type: 'list' }));
  });

  test('creates board with description', async () => {
    const mockCreate = jest.fn().mockResolvedValue(sampleBoard);
    const program = buildProgram(mockCreate);
    await program.parseAsync([
      'node', 'test', 'boards', 'create', 'coll-1',
      '--name', 'Sprint', '--description', 'Sprint board',
    ]);
    expect(mockCreate).toHaveBeenCalledWith('coll-1', expect.objectContaining({
      description: 'Sprint board',
    }));
  });

  test('outputs json when --json flag provided', async () => {
    const mockCreate = jest.fn().mockResolvedValue(sampleBoard);
    const program = buildProgram(mockCreate);
    await program.parseAsync(['node', 'test', 'boards', 'create', 'coll-1', '--name', 'Sprint', '--json']);
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(sampleBoard, null, 2));
  });

  test('dry-run does not call API', async () => {
    const mockCreate = jest.fn();
    const program = buildProgram(mockCreate);
    await program.parseAsync([
      'node', 'test', 'boards', 'create', 'coll-1', '--name', 'Sprint', '--dry-run',
    ]);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[dry-run]'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Sprint'));
  });

  test('dry-run shows collection id', async () => {
    const mockCreate = jest.fn();
    const program = buildProgram(mockCreate);
    await program.parseAsync([
      'node', 'test', 'boards', 'create', 'coll-1', '--name', 'Sprint', '--dry-run',
    ]);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('coll-1'));
  });

  test('exits with error for invalid board type', async () => {
    const mockCreate = jest.fn();
    const program = buildProgram(mockCreate);
    await expect(
      program.parseAsync(['node', 'test', 'boards', 'create', 'coll-1', '--name', 'Board', '--type', 'invalid'])
    ).rejects.toThrow('process.exit');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid board type'));
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('exits with error when api key missing', async () => {
    jest.spyOn(config, 'resolveApiKey').mockResolvedValue(null as any);
    const mockCreate = jest.fn();
    const program = buildProgram(mockCreate);
    await expect(
      program.parseAsync(['node', 'test', 'boards', 'create', 'coll-1', '--name', 'Sprint'])
    ).rejects.toThrow('process.exit');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error:'));
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('shows 404 error message for non-existent collection', async () => {
    const err = Object.assign(new Error('Not Found'), { response: { status: 404 } });
    const mockCreate = jest.fn().mockRejectedValue(err);
    const program = buildProgram(mockCreate);
    await expect(
      program.parseAsync(['node', 'test', 'boards', 'create', 'bad-coll', '--name', 'Sprint'])
    ).rejects.toThrow('process.exit');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Collection not found'));
  });

  test('defaults to board type when not specified', async () => {
    const mockCreate = jest.fn().mockResolvedValue(sampleBoard);
    const program = buildProgram(mockCreate);
    await program.parseAsync(['node', 'test', 'boards', 'create', 'coll-1', '--name', 'Sprint']);
    expect(mockCreate).toHaveBeenCalledWith('coll-1', expect.objectContaining({ type: 'board' }));
  });
});
