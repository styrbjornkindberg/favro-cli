/**
 * Tests for collections-get command
 * CLA-1783 FAVRO-021: Implement Collections Endpoints
 */
import { Command } from 'commander';
import { registerCollectionsGetCommand } from '../../commands/collections-get';
import CollectionsAPI, { Collection } from '../../lib/collections-api';
import FavroHttpClient from '../../lib/http-client';
import * as config from '../../lib/config';

jest.mock('../../lib/collections-api');
jest.mock('../../lib/http-client');
jest.mock('../../lib/config');

const sampleCollection: Collection = {
  collectionId: 'coll-1',
  name: 'Marketing',
  description: 'Marketing workspace',
  boardCount: 5,
  memberCount: 3,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-02-01T00:00:00Z',
};

function buildProgram(mockGetCollection: jest.Mock) {
  (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({} as any));
  (CollectionsAPI as jest.MockedClass<typeof CollectionsAPI>).mockImplementation(() => ({
    getCollection: mockGetCollection,
  } as any));

  const parent = new Command();
  parent.option('--verbose', 'verbose');
  const collectionsCmd = parent.command('collections');
  registerCollectionsGetCommand(collectionsCmd);
  return parent;
}

describe('collections get command', () => {
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

  test('gets collection by id and prints details', async () => {
    const mockGet = jest.fn().mockResolvedValue(sampleCollection);
    const program = buildProgram(mockGet);
    await program.parseAsync(['node', 'test', 'collections', 'get', 'coll-1']);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Marketing'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('coll-1'));
    expect(mockGet).toHaveBeenCalledWith('coll-1', undefined);
  });

  test('gets collection with --include option', async () => {
    const mockGet = jest.fn().mockResolvedValue(sampleCollection);
    const program = buildProgram(mockGet);
    await program.parseAsync(['node', 'test', 'collections', 'get', 'coll-1', '--include', 'boards,stats']);
    expect(mockGet).toHaveBeenCalledWith('coll-1', ['boards', 'stats']);
  });

  test('outputs json when --json flag provided', async () => {
    const mockGet = jest.fn().mockResolvedValue(sampleCollection);
    const program = buildProgram(mockGet);
    await program.parseAsync(['node', 'test', 'collections', 'get', 'coll-1', '--json']);
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(sampleCollection, null, 2));
  });

  test('shows 404 error message for non-existent collection', async () => {
    const err = Object.assign(new Error('Not Found'), { response: { status: 404 } });
    const mockGet = jest.fn().mockRejectedValue(err);
    const program = buildProgram(mockGet);
    await expect(
      program.parseAsync(['node', 'test', 'collections', 'get', 'bad-id'])
    ).rejects.toThrow('process.exit');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('bad-id'));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('favro collections list'));
  });

  test('exits with error for invalid --include values', async () => {
    const mockGet = jest.fn().mockResolvedValue(sampleCollection);
    const program = buildProgram(mockGet);
    await expect(
      program.parseAsync(['node', 'test', 'collections', 'get', 'coll-1', '--include', 'bogus,garbage'])
    ).rejects.toThrow('process.exit');
    expect(mockGet).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid --include values'));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('bogus'));
  });

  test('shows boards table when boards included', async () => {
    const collWithBoards: Collection = {
      ...sampleCollection,
      boards: [
        { boardId: 'board-1', name: 'Sprint 1', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      ],
    };
    const mockGet = jest.fn().mockResolvedValue(collWithBoards);
    const tableSpy = jest.spyOn(console, 'table').mockImplementation(() => {});
    const program = buildProgram(mockGet);
    await program.parseAsync(['node', 'test', 'collections', 'get', 'coll-1', '--include', 'boards']);
    expect(tableSpy).toHaveBeenCalled();
  });

  test('exits when API key missing', async () => {
    jest.spyOn(config, 'resolveApiKey').mockResolvedValue(null as any);
    const program = buildProgram(jest.fn());
    await expect(
      program.parseAsync(['node', 'test', 'collections', 'get', 'coll-1'])
    ).rejects.toThrow('process.exit');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API key'));
  });

  test('exits on generic API error', async () => {
    const mockGet = jest.fn().mockRejectedValue(new Error('Server error'));
    const program = buildProgram(mockGet);
    await expect(
      program.parseAsync(['node', 'test', 'collections', 'get', 'coll-1'])
    ).rejects.toThrow('process.exit');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Server error'));
  });
});
