/**
 * Tests for collections-update command
 * CLA-1783 FAVRO-021: Implement Collections Endpoints
 */
import { Command } from 'commander';
import { registerCollectionsUpdateCommand } from '../../commands/collections-update';
import CollectionsAPI, { Collection } from '../../lib/collections-api';
import FavroHttpClient from '../../lib/http-client';
import * as config from '../../lib/config';

jest.mock('../../lib/collections-api');
jest.mock('../../lib/http-client');
jest.mock('../../lib/config');

const updatedCollection: Collection = {
  collectionId: 'coll-1',
  name: 'Updated Collection',
  description: 'Updated description',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-03-01T00:00:00Z',
};

function buildProgram(mockUpdate: jest.Mock) {
  (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({} as any));
  (CollectionsAPI as jest.MockedClass<typeof CollectionsAPI>).mockImplementation(() => ({
    updateCollection: mockUpdate,
  } as any));

  const parent = new Command();
  parent.option('--verbose', 'verbose');
  const collectionsCmd = parent.command('collections');
  registerCollectionsUpdateCommand(collectionsCmd);
  return parent;
}

describe('collections update command', () => {
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

  test('updates collection name', async () => {
    const mockUpdate = jest.fn().mockResolvedValue(updatedCollection);
    const program = buildProgram(mockUpdate);
    await program.parseAsync([
      'node', 'test', 'collections', 'update', 'coll-1', '--name', 'Updated Collection',
    ]);
    expect(mockUpdate).toHaveBeenCalledWith('coll-1', { name: 'Updated Collection' });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('coll-1'));
  });

  test('updates collection description', async () => {
    const mockUpdate = jest.fn().mockResolvedValue(updatedCollection);
    const program = buildProgram(mockUpdate);
    await program.parseAsync([
      'node', 'test', 'collections', 'update', 'coll-1', '--description', 'Updated description',
    ]);
    expect(mockUpdate).toHaveBeenCalledWith('coll-1', { description: 'Updated description' });
  });

  test('updates both name and description', async () => {
    const mockUpdate = jest.fn().mockResolvedValue(updatedCollection);
    const program = buildProgram(mockUpdate);
    await program.parseAsync([
      'node', 'test', 'collections', 'update', 'coll-1',
      '--name', 'Updated Collection', '--description', 'Updated description',
    ]);
    expect(mockUpdate).toHaveBeenCalledWith('coll-1', {
      name: 'Updated Collection',
      description: 'Updated description',
    });
  });

  test('outputs json when --json flag provided', async () => {
    const mockUpdate = jest.fn().mockResolvedValue(updatedCollection);
    const program = buildProgram(mockUpdate);
    await program.parseAsync([
      'node', 'test', 'collections', 'update', 'coll-1', '--name', 'Updated', '--json',
    ]);
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(updatedCollection, null, 2));
  });

  test('dry-run does not call API', async () => {
    const mockUpdate = jest.fn();
    const program = buildProgram(mockUpdate);
    await program.parseAsync([
      'node', 'test', 'collections', 'update', 'coll-1', '--name', 'Updated', '--dry-run',
    ]);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[dry-run]'), expect.anything());
  });

  test('exits when no fields provided', async () => {
    const mockUpdate = jest.fn();
    const program = buildProgram(mockUpdate);
    await expect(
      program.parseAsync(['node', 'test', 'collections', 'update', 'coll-1'])
    ).rejects.toThrow('process.exit');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('at least one field'));
  });

  test('shows 404 error for non-existent collection', async () => {
    const err = Object.assign(new Error('Not Found'), { response: { status: 404 } });
    const mockUpdate = jest.fn().mockRejectedValue(err);
    const program = buildProgram(mockUpdate);
    await expect(
      program.parseAsync(['node', 'test', 'collections', 'update', 'bad-id', '--name', 'x'])
    ).rejects.toThrow('process.exit');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('bad-id'));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('favro collections list'));
  });

  test('exits when name is whitespace-only', async () => {
    const mockUpdate = jest.fn();
    const program = buildProgram(mockUpdate);
    await expect(
      program.parseAsync(['node', 'test', 'collections', 'update', 'coll-1', '--name', '   '])
    ).rejects.toThrow('process.exit');
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('whitespace-only'));
  });

  test('exits when API key missing', async () => {
    jest.spyOn(config, 'resolveApiKey').mockResolvedValue(null as any);
    const program = buildProgram(jest.fn());
    await expect(
      program.parseAsync(['node', 'test', 'collections', 'update', 'coll-1', '--name', 'x'])
    ).rejects.toThrow('process.exit');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API key'));
  });

  test('exits on generic API error', async () => {
    const mockUpdate = jest.fn().mockRejectedValue(new Error('Server error'));
    const program = buildProgram(mockUpdate);
    await expect(
      program.parseAsync(['node', 'test', 'collections', 'update', 'coll-1', '--name', 'x'])
    ).rejects.toThrow('process.exit');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Server error'));
  });
});
