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
  parent.option('--verbose', 'verbose').option('--human').option('--pretty');
  parent.exitOverride();
  const collectionsCmd = parent.command('collections');
  registerCollectionsListCommand(collectionsCmd);
  return parent;
}

describe('collections list command', () => {
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

  test('--human lists collections in table format', async () => {
    const mockList = jest.fn().mockResolvedValue(sampleCollections);
    const program = buildProgram(mockList);
    await program.parseAsync(['node', 'test', 'collections', 'list', '--human']);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('2 collection(s)'));
    expect(mockList).toHaveBeenCalledWith(100);
  });

  test('lists collections as the envelope by default', async () => {
    const mockList = jest.fn().mockResolvedValue(sampleCollections);
    const program = buildProgram(mockList);
    await program.parseAsync(['node', 'test', 'collections', 'list']);
    // #44: a list read emits the `{rows}` envelope, compact, with the bulk
    // fields omitted from the RENDERING only.
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify({ rows: sampleCollections }));
  });

  test('the two bulk fields are omitted from the envelope', async () => {
    const fat = [{ ...sampleCollections[0], sharedToUsers: [{ userId: 'u1' }], boards: [{ boardId: 'b1' }] }];
    const mockList = jest.fn().mockResolvedValue(fat);
    const program = buildProgram(mockList);
    await program.parseAsync(['node', 'test', 'collections', 'list']);
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify({ rows: [sampleCollections[0]] }));
  });

  test('--limit caps the print and marks the cut (#99)', async () => {
    // Enveloped since #44 but uncapped, so `truncated` was unreachable on this
    // command however many collections came back.
    const mockList = jest.fn().mockResolvedValue(sampleCollections);
    const program = buildProgram(mockList);
    await program.parseAsync(['node', 'test', 'collections', 'list', '--limit', '1']);

    // The read still ran to completion — the cap is on the print alone.
    expect(mockList).toHaveBeenCalledWith(100);
    expect(consoleSpy).toHaveBeenCalledWith(
      JSON.stringify({ rows: [sampleCollections[0]], truncated: true }),
    );
  });

  test('shows message for empty collections', async () => {
    const mockList = jest.fn().mockResolvedValue([]);
    const program = buildProgram(mockList);
    await program.parseAsync(['node', 'test', 'collections', 'list', '--human']);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('0 collection(s)'));
  });

  // `--format table|json` is gone (ADR-0002) — a third spelling of the axis the
  // runner now owns. Commander refuses it outright rather than half-honouring it.
  test('--format is no longer a flag at all', async () => {
    const mockList = jest.fn().mockResolvedValue(sampleCollections);
    const program = buildProgram(mockList);
    await expect(
      program.parseAsync(['node', 'test', 'collections', 'list', '--format', 'yaml'])
    ).rejects.toThrow(/unknown option/i);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('exits when API key missing', async () => {
    jest.spyOn(config, 'resolveApiKey').mockResolvedValue(null as any);
    const mockList = jest.fn().mockResolvedValue([]);
    const program = buildProgram(mockList);
    await program.parseAsync(['node', 'test', 'collections', 'list', '--human']);
    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API key'));
  });

  test('exits on API error', async () => {
    const mockList = jest.fn().mockRejectedValue(new Error('API error'));
    const program = buildProgram(mockList);
    await program.parseAsync(['node', 'test', 'collections', 'list', '--human']);
    expect(process.exitCode).toBe(1);
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
