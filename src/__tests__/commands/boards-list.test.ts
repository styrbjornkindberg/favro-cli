/**
 * Tests for boards-list command
 * CLA-1770: Boards List Command
 */
import { Command } from 'commander';
import {
  registerBoardsListCommand,
  formatBoardsTable,
} from '../../commands/boards-list';
import BoardsAPI, { Board, Collection } from '../../lib/boards-api';
import FavroHttpClient from '../../lib/http-client';
import * as config from '../../lib/config';

jest.mock('../../lib/boards-api');
jest.mock('../../lib/http-client');
jest.mock('../../lib/config');

const sampleBoards: Board[] = [
  {
    boardId: 'board-1',
    name: 'Marketing Board',
    collectionId: 'coll-1',
    cardCount: 10,
    columns: 4,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-02-01T00:00:00Z',
  },
  {
    boardId: 'board-2',
    name: 'Engineering Board',
    collectionId: 'coll-2',
    cardCount: 25,
    columns: 6,
    createdAt: '2026-01-05T00:00:00Z',
    updatedAt: '2026-02-10T00:00:00Z',
  },
  {
    boardId: 'board-3',
    name: 'Sales Board',
    collectionId: 'coll-1',
    cardCount: 5,
    columns: 3,
    createdAt: '2026-01-10T00:00:00Z',
    updatedAt: '2026-02-15T00:00:00Z',
  },
];

const sampleCollections: Collection[] = [
  {
    collectionId: 'coll-1',
    name: 'Marketing',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    collectionId: 'coll-2',
    name: 'Engineering',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

function buildProgram(mockListBoards: jest.Mock, mockListCollections?: jest.Mock, mockListBoardsByCollection?: jest.Mock) {
  (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({} as any));
  (BoardsAPI as jest.MockedClass<typeof BoardsAPI>).mockImplementation(() => ({
    listBoards: mockListBoards,
    listCollections: mockListCollections ?? jest.fn().mockResolvedValue(sampleCollections),
    listBoardsByCollection: mockListBoardsByCollection ?? jest.fn().mockResolvedValue([]),
    getBoard: jest.fn(),
    createBoard: jest.fn(),
    updateBoard: jest.fn(),
    deleteBoard: jest.fn(),
    getCollection: jest.fn(),
    createCollection: jest.fn(),
    updateCollection: jest.fn(),
    deleteCollection: jest.fn(),
    addBoardToCollection: jest.fn(),
    removeBoardFromCollection: jest.fn(),
  } as any));

  const program = new Command();
  program.exitOverride();
  const boardsParent = program.command('boards');
  registerBoardsListCommand(boardsParent);
  return program;
}

describe('boards list command', () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;
  let resolveApiKeySpy: jest.SpyInstance;

  beforeEach(() => {
    resolveApiKeySpy = jest.spyOn(config, 'resolveApiKey').mockResolvedValue('test-token');
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as any);
    jest.clearAllMocks();
    // Re-mock after clearAllMocks
    resolveApiKeySpy = jest.spyOn(config, 'resolveApiKey').mockResolvedValue('test-token');
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as any);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
    resolveApiKeySpy.mockRestore();
  });

  // --- list all boards ---

  test('lists all boards in table format', async () => {
    const mockListBoards = jest.fn().mockResolvedValue(sampleBoards);
    const program = buildProgram(mockListBoards);

    await program.parseAsync(['node', 'cli', 'boards', 'list']);

    expect(mockListBoards).toHaveBeenCalledWith(100);
    expect(consoleLogSpy).toHaveBeenCalledWith('Found 3 board(s):');
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.anything()); // table output
  });

  test('shows count of boards found', async () => {
    const mockListBoards = jest.fn().mockResolvedValue(sampleBoards);
    const program = buildProgram(mockListBoards);

    await program.parseAsync(['node', 'cli', 'boards', 'list']);

    expect(consoleLogSpy).toHaveBeenCalledWith('Found 3 board(s):');
  });

  test('shows "No boards found" when empty', async () => {
    const mockListBoards = jest.fn().mockResolvedValue([]);
    const program = buildProgram(mockListBoards);

    await program.parseAsync(['node', 'cli', 'boards', 'list']);

    expect(consoleLogSpy).toHaveBeenCalledWith('Found 0 board(s):');
    expect(consoleLogSpy).toHaveBeenCalledWith('No boards found. Check your API key or collection permissions.');
  });

/** The one `console.log` carrying the list-read envelope. */
function envelopeCall(spy: jest.SpyInstance): string {
  return String(spy.mock.calls.find(c => String(c[0]).startsWith('{"rows":'))![0]);
}

  // --- json output ---

  test('--json outputs valid JSON', async () => {
    const mockListBoards = jest.fn().mockResolvedValue(sampleBoards);
    const program = buildProgram(mockListBoards);

    await program.parseAsync(['node', 'cli', 'boards', 'list', '--json']);

    // #44: a list read emits the `{rows}` envelope, not a bare array.
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\{"rows":/)
    );
    const parsed = JSON.parse(envelopeCall(consoleLogSpy));
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[0].boardId).toBe('board-1');
  });

  test('--json output contains board IDs and names', async () => {
    const mockListBoards = jest.fn().mockResolvedValue(sampleBoards);
    const program = buildProgram(mockListBoards);

    await program.parseAsync(['node', 'cli', 'boards', 'list', '--json']);

    const parsed = JSON.parse(envelopeCall(consoleLogSpy));
    const names = parsed.rows.map((b: Board) => b.name);
    expect(names).toContain('Marketing Board');
    expect(names).toContain('Engineering Board');
  });

  // --- collection filter (resolved and narrowed inside BoardsAPI) ---

  test('--collection hands the collection straight to the wire-filtered listing', async () => {
    const mockListBoards = jest.fn().mockResolvedValue(sampleBoards);
    const mockByCollection = jest.fn().mockResolvedValue([sampleBoards[0], sampleBoards[2]]);
    const program = buildProgram(mockListBoards, undefined, mockByCollection);

    await program.parseAsync(['node', 'cli', 'boards', 'list', '--collection', 'Marketing']);

    // No org-wide sweep and no client-side filter: one narrowed call.
    expect(mockListBoards).not.toHaveBeenCalled();
    expect(mockByCollection).toHaveBeenCalledWith('Marketing', undefined);
    expect(consoleLogSpy).toHaveBeenCalledWith('Found 2 board(s):');
  });

  test('the positional collection takes the same wire-filtered path', async () => {
    const mockListBoards = jest.fn().mockResolvedValue(sampleBoards);
    const mockByCollection = jest.fn().mockResolvedValue([sampleBoards[1]]);
    const program = buildProgram(mockListBoards, undefined, mockByCollection);

    await program.parseAsync(['node', 'cli', 'boards', 'list', 'coll-2']);

    expect(mockByCollection).toHaveBeenCalledWith('coll-2', undefined);
    expect(consoleLogSpy).toHaveBeenCalledWith('Found 1 board(s):');
  });

  test("--collection with an unresolvable name surfaces the API's refusal and exits 1", async () => {
    const mockListBoards = jest.fn().mockResolvedValue(sampleBoards);
    const mockByCollection = jest.fn().mockRejectedValue(
      new Error('No collection named "NonExistent" — it is missing or not visible to your key.')
    );
    const program = buildProgram(mockListBoards, undefined, mockByCollection);

    await expect(
      program.parseAsync(['node', 'cli', 'boards', 'list', '--collection', 'NonExistent'])
    ).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('NonExistent'));
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('missing or not visible to your key')
    );
  });

  test('--collection --json outputs the narrowed boards as JSON', async () => {
    const mockListBoards = jest.fn().mockResolvedValue(sampleBoards);
    const mockByCollection = jest.fn().mockResolvedValue([sampleBoards[1]]);
    const program = buildProgram(mockListBoards, undefined, mockByCollection);

    await program.parseAsync(['node', 'cli', 'boards', 'list', '--collection', 'Engineering', '--json']);

    const parsed = JSON.parse(envelopeCall(consoleLogSpy));
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].boardId).toBe('board-2');
  });

  // --- error handling ---

  test('exits 1 when API key not configured', async () => {
    jest.spyOn(config, 'resolveApiKey').mockResolvedValue(undefined);
    const mockListBoards = jest.fn();
    const program = buildProgram(mockListBoards);

    await expect(
      program.parseAsync(['node', 'cli', 'boards', 'list'])
    ).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API key'));
    expect(mockListBoards).not.toHaveBeenCalled();
  });

  test('exits 1 on API error', async () => {
    const mockListBoards = jest.fn().mockRejectedValue(new Error('Network error'));
    const program = buildProgram(mockListBoards);

    await expect(
      program.parseAsync(['node', 'cli', 'boards', 'list'])
    ).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Network error'));
  });

  test('--include bogus exits with error', async () => {
    const mockListBoards = jest.fn().mockResolvedValue(sampleBoards);
    const program = buildProgram(mockListBoards);

    await expect(
      program.parseAsync(['node', 'cli', 'boards', 'list', '--include', 'bogus'])
    ).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid --include values: bogus. Valid options: stats, velocity'));
    expect(mockListBoards).not.toHaveBeenCalled();
  });

  test('--include with mixed valid and invalid values exits with error', async () => {
    const mockListBoards = jest.fn().mockResolvedValue(sampleBoards);
    const program = buildProgram(mockListBoards);

    await expect(
      program.parseAsync(['node', 'cli', 'boards', 'list', '--include', 'stats,bogus'])
    ).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid --include values: bogus. Valid options: stats, velocity'));
  });
});

// --- formatBoardsTable unit tests ---

describe('formatBoardsTable', () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleTableSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleTableSpy = jest.spyOn(console, 'table').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleTableSpy.mockRestore();
  });

  test('prints "No boards found." for empty list', () => {
    formatBoardsTable([]);
    expect(consoleLogSpy).toHaveBeenCalledWith('No boards found. Check your API key or collection permissions.');
  });

  test('calls console.table with board rows', () => {
    formatBoardsTable(sampleBoards);
    expect(consoleTableSpy).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ ID: 'board-1', Name: 'Marketing Board' }),
      ])
    );
  });

  test('table rows include Cards and Columns fields', () => {
    formatBoardsTable(sampleBoards);
    const rows = consoleTableSpy.mock.calls[0][0];
    expect(rows[0]).toHaveProperty('Cards', 10);
    expect(rows[0]).toHaveProperty('Columns', 4);
  });

  test('table rows include Updated field', () => {
    formatBoardsTable(sampleBoards);
    const rows = consoleTableSpy.mock.calls[0][0];
    expect(rows[0]).toHaveProperty('Updated', '2026-02-01');
  });

  test('truncates long board names', () => {
    const longName = 'A'.repeat(50);
    const board: Board = {
      boardId: 'b-long',
      name: longName,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    };
    formatBoardsTable([board]);
    const rows = consoleTableSpy.mock.calls[0][0];
    expect(rows[0].Name.length).toBeLessThanOrEqual(35);
    expect(rows[0].Name).toMatch(/\.\.\.$/);
  });

  test('handles null board name without crashing', () => {
    const board: Board = {
      boardId: 'b1',
      name: null as any,  // ← Edge case: API returns null name
      createdAt: '2026-03-27',
      updatedAt: '2026-03-27',
    };
    // Should not throw when formatting
    formatBoardsTable([board]);
    const rows = consoleTableSpy.mock.calls[0][0];
    expect(rows[0].Name).toBe('—');  // Should show em-dash, not crash
  });

  test('shows dash for missing cardCount', () => {
    const board: Board = {
      boardId: 'b-no-count',
      name: 'Simple Board',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    };
    formatBoardsTable([board]);
    const rows = consoleTableSpy.mock.calls[0][0];
    expect(rows[0].Cards).toBe('—');
    expect(rows[0].Columns).toBe('—');
  });
});
