/**
 * Tests for collections-list command
 * CLA-1783 FAVRO-021: Implement Collections Endpoints
 */
import { Command } from 'commander';
import { registerCollectionsListCommand, formatCollectionsTable } from '../../commands/collections-list';
import CollectionsAPI, { Collection } from '../../lib/collections-api';
import FavroHttpClient from '../../lib/http-client';
import * as config from '../../lib/config';

jest.mock('../../lib/collections-api');
jest.mock('../../lib/http-client');
jest.mock('../../lib/config');

const sampleCollections: Collection[] = [
  {
    collectionId: 'coll-1',
    name: 'Marketing',
    description: 'Marketing workspace',
    boardCount: 5,
    memberCount: 3,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-02-01T00:00:00Z',
  },
  {
    collectionId: 'coll-2',
    name: 'Engineering',
    boardCount: 8,
    memberCount: 6,
    createdAt: '2026-01-05T00:00:00Z',
    updatedAt: '2026-02-10T00:00:00Z',
  },
];

function buildProgram(mockListCollections: jest.Mock) {
  (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({} as any));
  (CollectionsAPI as jest.MockedClass<typeof CollectionsAPI>).mockImplementation(() => ({
    listCollections: mockListCollections,
  } as any));

  const parent = new Command();
  parent.option('--verbose', 'verbose');
  const collectionsCmd = parent.command('collections');
  registerCollectionsListCommand(collectionsCmd);
  return parent;
}

describe('collections list command', () => {
  let consoleSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    jest.spyOn(config, 'resolveApiKey').mockResolvedValue('test-token');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('lists collections in table format by default', async () => {
    const mockList = jest.fn().mockResolvedValue(sampleCollections);
    const program = buildProgram(mockList);
    await program.parseAsync(['node', 'test', 'collections', 'list']);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('2 collection(s)'));
    expect(mockList).toHaveBeenCalledWith(100);
  });

  test('lists collections in json format', async () => {
    const mockList = jest.fn().mockResolvedValue(sampleCollections);
    const program = buildProgram(mockList);
    await program.parseAsync(['node', 'test', 'collections', 'list', '--format', 'json']);
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(sampleCollections, null, 2));
  });

  test('lists collections in json format with --json flag', async () => {
    const mockList = jest.fn().mockResolvedValue(sampleCollections);
    const program = buildProgram(mockList);
    await program.parseAsync(['node', 'test', 'collections', 'list', '--json']);
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(sampleCollections, null, 2));
  });

  test('shows message for empty collections', async () => {
    const mockList = jest.fn().mockResolvedValue([]);
    const program = buildProgram(mockList);
    await program.parseAsync(['node', 'test', 'collections', 'list']);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('0 collection(s)'));
  });

  test('exits with error for invalid format', async () => {
    const mockList = jest.fn().mockResolvedValue(sampleCollections);
    const program = buildProgram(mockList);
    await expect(
      program.parseAsync(['node', 'test', 'collections', 'list', '--format', 'yaml'])
    ).rejects.toThrow('process.exit');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid format'));
  });

  test('exits when API key missing', async () => {
    jest.spyOn(config, 'resolveApiKey').mockResolvedValue(null as any);
    const mockList = jest.fn().mockResolvedValue([]);
    const program = buildProgram(mockList);
    await expect(
      program.parseAsync(['node', 'test', 'collections', 'list'])
    ).rejects.toThrow('process.exit');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API key'));
  });

  test('exits on API error', async () => {
    const mockList = jest.fn().mockRejectedValue(new Error('API error'));
    const program = buildProgram(mockList);
    await expect(
      program.parseAsync(['node', 'test', 'collections', 'list'])
    ).rejects.toThrow('process.exit');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API error'));
  });
});

describe('formatCollectionsTable', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'table').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  test('calls console.table with collections data', () => {
    formatCollectionsTable(sampleCollections);
    expect(consoleSpy).toHaveBeenCalledTimes(1);
  });

  test('shows no-collections message for empty array', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    formatCollectionsTable([]);
    expect(logSpy).toHaveBeenCalledWith('No collections found.');
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  test('truncates long names', () => {
    const longName = 'A'.repeat(50);
    formatCollectionsTable([{ ...sampleCollections[0], name: longName }]);
    const rows = consoleSpy.mock.calls[0][0] as any[];
    expect(rows[0].Name).toHaveLength(40); // 37 + '...'
  });
});
