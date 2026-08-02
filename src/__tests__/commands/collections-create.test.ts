/**
 * Tests for collections-create command
 * CLA-1783 FAVRO-021: Implement Collections Endpoints
 */
import { Command } from 'commander';
import { registerCollectionsCreateCommand } from '../../commands/collections-create';
import CollectionsAPI, { Collection } from '../../lib/collections-api';
import FavroHttpClient from '../../lib/http-client';
import * as config from '../../lib/config';

jest.mock('../../lib/collections-api');
jest.mock('../../lib/http-client');
jest.mock('../../lib/config');

const createdCollection: Collection = {
  collectionId: 'new-coll-123',
  name: 'New Collection',
  description: 'Test description',
  createdAt: '2026-03-01T00:00:00Z',
  updatedAt: '2026-03-01T00:00:00Z',
};

function buildProgram(mockCreate: jest.Mock) {
  (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({} as any));
  (CollectionsAPI as jest.MockedClass<typeof CollectionsAPI>).mockImplementation(() => ({
    createCollection: mockCreate,
  } as any));

  const parent = new Command();
  parent.option('--verbose', 'verbose').option('--human').option('--pretty');
  parent.exitOverride();
  const collectionsCmd = parent.command('collections');
  registerCollectionsCreateCommand(collectionsCmd);
  return parent;
}

describe('collections create command', () => {
  let consoleSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    process.exitCode = undefined;
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(config, 'resolveApiKey').mockResolvedValue('test-token');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.exitCode = undefined;
  });

  test('creates collection with name', async () => {
    const mockCreate = jest.fn().mockResolvedValue(createdCollection);
    const program = buildProgram(mockCreate);
    await program.parseAsync(['node', 'test', 'collections', 'create', '--name', 'New Collection', '--human']);
    expect(mockCreate).toHaveBeenCalledWith({ name: 'New Collection', description: undefined });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('new-coll-123'));
  });

  test('creates collection with name and description', async () => {
    const mockCreate = jest.fn().mockResolvedValue(createdCollection);
    const program = buildProgram(mockCreate);
    await program.parseAsync([
      'node', 'test', 'collections', 'create',
      '--name', 'New Collection',
      '--description', 'Test description',
    ]);
    expect(mockCreate).toHaveBeenCalledWith({
      name: 'New Collection',
      description: 'Test description',
    });
  });

  test('with no flags it emits the bare created collection', async () => {
    const mockCreate = jest.fn().mockResolvedValue(createdCollection);
    const program = buildProgram(mockCreate);
    await program.parseAsync([
      'node', 'test', 'collections', 'create', '--name', 'New Collection',
    ]);
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(createdCollection));
  });

  test('dry-run does not call API', async () => {
    const mockCreate = jest.fn();
    const program = buildProgram(mockCreate);
    await program.parseAsync([
      'node', 'test', 'collections', 'create', '--name', 'New Collection', '--dry-run',
    ]);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[dry-run]'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('New Collection'));
  });

  test('dry-run shows description when provided', async () => {
    const mockCreate = jest.fn();
    const program = buildProgram(mockCreate);
    await program.parseAsync([
      'node', 'test', 'collections', 'create',
      '--name', 'New Collection', '--description', 'My desc', '--dry-run',
    ]);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('My desc'));
  });

  test('exits when name is whitespace-only', async () => {
    const mockCreate = jest.fn();
    const program = buildProgram(mockCreate);
    await program.parseAsync(['node', 'test', 'collections', 'create', '--name', '   ', '--human']);
    expect(process.exitCode).toBe(1);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('whitespace-only'));
  });

  test('exits when API key missing', async () => {
    jest.spyOn(config, 'resolveApiKey').mockResolvedValue(null as any);
    const program = buildProgram(jest.fn());
    await program.parseAsync(['node', 'test', 'collections', 'create', '--name', 'x', '--human']);
    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API key'));
  });

  test('exits on API error', async () => {
    const mockCreate = jest.fn().mockRejectedValue(new Error('API error'));
    const program = buildProgram(mockCreate);
    await program.parseAsync(['node', 'test', 'collections', 'create', '--name', 'x', '--human']);
    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API error'));
  });
});
