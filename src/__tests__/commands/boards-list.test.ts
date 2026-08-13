/**
 * Tests for boards-list command
 * CLA-1770: Boards List Command
 */
import { Command } from 'commander';
import {
  registerBoardsListCommand,
  listBoardsHandler,
  formatBoardsTable,
} from '../../commands/boards-list';
import BoardsAPI, { Board } from '../../lib/boards-api';
import FavroHttpClient from '../../lib/http-client';
import * as config from '../../lib/config';
import type { Ctx } from '../../lib/run';

/**
 * Only the CLASS is mocked. Auto-mocking the whole module replaced the pure
 * helpers beside it — including `withBoardIncludes`, which the handler now maps
 * every board through — with stubs returning `undefined`, so a passing test would
 * have been asserting against rows the real code never produces.
 */
jest.mock('../../lib/boards-api', () => {
  // ONE constructor behind both bindings, the way the automock had it — `run`'s
  // api namespace reads the named export and the test configures the default.
  const BoardsAPI = jest.fn();
  return { ...jest.requireActual('../../lib/boards-api'), __esModule: true, default: BoardsAPI, BoardsAPI };
});
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

function buildProgram(mockListBoards: jest.Mock, mockListBoardsByCollection?: jest.Mock) {
  (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({} as any));
  (BoardsAPI as jest.MockedClass<typeof BoardsAPI>).mockImplementation(() => ({
    listBoards: mockListBoards,
    listBoardsByCollection: mockListBoardsByCollection ?? jest.fn().mockResolvedValue([]),
    getBoard: jest.fn(),
    createBoard: jest.fn(),
    updateBoard: jest.fn(),
    deleteBoard: jest.fn(),
  } as any));

  const program = new Command();
  // The two flags the runner owns, declared where `cli.ts` declares them.
  program.option('--human').option('--pretty').option('--verbose');
  program.exitOverride();
  const boardsParent = program.command('boards');
  registerBoardsListCommand(boardsParent);
  return program;
}

/**
 * The seam ADR-0002 exists for: the handler, a fake `Ctx`, and the `Result`
 * read straight back. No commander, no stdout, no `http-client` mock.
 */
describe('the handler returns a Result', () => {
  const ctxWith = (boards: jest.Mock, byCollection = jest.fn()): Ctx =>
    ({ api: { boards: { listBoards: boards, listBoardsByCollection: byCollection } } } as any);

  test('a plain list comes back as rows, with a human formatter attached', async () => {
    const result = await listBoardsHandler(ctxWith(jest.fn().mockResolvedValue(sampleBoards)), undefined, {});

    expect(result.rows).toHaveLength(3);
    expect(result.rows[0].boardId).toBe('board-1');
    expect(typeof result.human).toBe('function');
  });

  test('the positional collection narrows on the wire and never sweeps', async () => {
    const listAll = jest.fn();
    const byCollection = jest.fn().mockResolvedValue([sampleBoards[1]]);

    const result = await listBoardsHandler(ctxWith(listAll, byCollection), 'coll-2', {});

    expect(listAll).not.toHaveBeenCalled();
    expect(byCollection).toHaveBeenCalledWith('coll-2', undefined);
    expect(result.rows).toEqual([sampleBoards[1]]);
  });

  test('--limit rides on the result, so the RUNNER caps and marks it (#99)', async () => {
    // The cap is not applied here on purpose: a handler that sliced its own
    // rows would put the cut somewhere `truncated` cannot be set. The handler's
    // whole job is to hand the flag over untouched — including as the string
    // commander gave it.
    const result = await listBoardsHandler(
      ctxWith(jest.fn().mockResolvedValue(sampleBoards)),
      undefined,
      { limit: '2' },
    );

    expect(result.rows).toHaveLength(3);
    expect(result.limit).toBe('2');
  });

  test('an unknown --include is refused before any request goes out', async () => {
    const listAll = jest.fn();

    await expect(listBoardsHandler(ctxWith(listAll), undefined, { include: 'bogus' })).rejects.toThrow(
      'Invalid --include values: bogus. Valid options: stats, velocity',
    );
    expect(listAll).not.toHaveBeenCalled();
  });
});

describe('boards list command', () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let resolveApiKeySpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.exitCode = undefined;
    resolveApiKeySpy = jest.spyOn(config, 'resolveApiKey').mockResolvedValue('test-token');
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    resolveApiKeySpy.mockRestore();
    process.exitCode = undefined;
  });

  // --- list all boards ---

  test('lists all boards in table format', async () => {
    const mockListBoards = jest.fn().mockResolvedValue(sampleBoards);
    const program = buildProgram(mockListBoards);

    await program.parseAsync(['node', 'cli', 'boards', 'list', '--human']);

    expect(mockListBoards).toHaveBeenCalledWith(100);
    expect(consoleLogSpy).toHaveBeenCalledWith('Found 3 board(s):');
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.anything()); // table output
  });

  test('shows count of boards found', async () => {
    const mockListBoards = jest.fn().mockResolvedValue(sampleBoards);
    const program = buildProgram(mockListBoards);

    await program.parseAsync(['node', 'cli', 'boards', 'list', '--human']);

    expect(consoleLogSpy).toHaveBeenCalledWith('Found 3 board(s):');
  });

  test('shows "No boards found" when empty', async () => {
    const mockListBoards = jest.fn().mockResolvedValue([]);
    const program = buildProgram(mockListBoards);

    await program.parseAsync(['node', 'cli', 'boards', 'list', '--human']);

    expect(consoleLogSpy).toHaveBeenCalledWith('Found 0 board(s):');
    expect(consoleLogSpy).toHaveBeenCalledWith('No boards found. Check your API key or collection permissions.');
  });

/** The one `console.log` carrying the list-read envelope. */
function envelopeCall(spy: jest.SpyInstance): string {
  return String(spy.mock.calls.find(c => String(c[0]).startsWith('{"rows":'))![0]);
}

  // --- json output, which is now the default ---

  test('with no flags it emits the envelope, not a table', async () => {
    const mockListBoards = jest.fn().mockResolvedValue(sampleBoards);
    const program = buildProgram(mockListBoards);

    await program.parseAsync(['node', 'cli', 'boards', 'list']);

    // #44: a list read emits the `{rows}` envelope, not a bare array.
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\{"rows":/)
    );
    const parsed = JSON.parse(envelopeCall(consoleLogSpy));
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[0].boardId).toBe('board-1');
  });

  test('the envelope carries board IDs and names', async () => {
    const mockListBoards = jest.fn().mockResolvedValue(sampleBoards);
    const program = buildProgram(mockListBoards);

    await program.parseAsync(['node', 'cli', 'boards', 'list']);

    const parsed = JSON.parse(envelopeCall(consoleLogSpy));
    const names = parsed.rows.map((b: Board) => b.name);
    expect(names).toContain('Marketing Board');
    expect(names).toContain('Engineering Board');
  });

  test('--pretty indents the same envelope', async () => {
    const mockListBoards = jest.fn().mockResolvedValue(sampleBoards);
    const program = buildProgram(mockListBoards);

    await program.parseAsync(['node', 'cli', 'boards', 'list', '--pretty']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('\n  "rows": ['));
  });

  // --- collection filter (resolved and narrowed inside BoardsAPI) ---

  test('--collection hands the collection straight to the wire-filtered listing', async () => {
    const mockListBoards = jest.fn().mockResolvedValue(sampleBoards);
    const mockByCollection = jest.fn().mockResolvedValue([sampleBoards[0], sampleBoards[2]]);
    const program = buildProgram(mockListBoards, mockByCollection);

    await program.parseAsync(['node', 'cli', 'boards', 'list', '--collection', 'Marketing', '--human']);

    // No org-wide sweep and no client-side filter: one narrowed call.
    expect(mockListBoards).not.toHaveBeenCalled();
    expect(mockByCollection).toHaveBeenCalledWith('Marketing', undefined);
    expect(consoleLogSpy).toHaveBeenCalledWith('Found 2 board(s):');
  });

  test('the positional collection takes the same wire-filtered path', async () => {
    const mockListBoards = jest.fn().mockResolvedValue(sampleBoards);
    const mockByCollection = jest.fn().mockResolvedValue([sampleBoards[1]]);
    const program = buildProgram(mockListBoards, mockByCollection);

    await program.parseAsync(['node', 'cli', 'boards', 'list', 'coll-2', '--human']);

    expect(mockByCollection).toHaveBeenCalledWith('coll-2', undefined);
    expect(consoleLogSpy).toHaveBeenCalledWith('Found 1 board(s):');
  });

  test("--collection with an unresolvable name surfaces the API's refusal and exits 1", async () => {
    const mockListBoards = jest.fn().mockResolvedValue(sampleBoards);
    const mockByCollection = jest.fn().mockRejectedValue(
      new Error('No collection named "NonExistent" — it is missing or not visible to your key.')
    );
    const program = buildProgram(mockListBoards, mockByCollection);

    await program.parseAsync(['node', 'cli', 'boards', 'list', '--collection', 'NonExistent', '--human']);

    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('NonExistent'));
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('missing or not visible to your key')
    );
  });

  test('--collection outputs the narrowed boards as an envelope', async () => {
    const mockListBoards = jest.fn().mockResolvedValue(sampleBoards);
    const mockByCollection = jest.fn().mockResolvedValue([sampleBoards[1]]);
    const program = buildProgram(mockListBoards, mockByCollection);

    await program.parseAsync(['node', 'cli', 'boards', 'list', '--collection', 'Engineering']);

    const parsed = JSON.parse(envelopeCall(consoleLogSpy));
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].boardId).toBe('board-2');
  });

  // --- error handling ---

  test('exits 1 when API key not configured', async () => {
    jest.spyOn(config, 'resolveApiKey').mockResolvedValue(undefined);
    const mockListBoards = jest.fn();
    const program = buildProgram(mockListBoards);

    await program.parseAsync(['node', 'cli', 'boards', 'list', '--human']);

    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API key'));
    expect(mockListBoards).not.toHaveBeenCalled();
  });

  test('a failure in JSON mode is an envelope on stdout, not a bare stderr line', async () => {
    const mockListBoards = jest.fn().mockRejectedValue(new Error('Network error'));
    const program = buildProgram(mockListBoards);

    await program.parseAsync(['node', 'cli', 'boards', 'list']);

    expect(process.exitCode).toBe(1);
    const written = consoleLogSpy.mock.calls.map(c => String(c[0])).find(s => s.startsWith('{"error"'));
    expect(JSON.parse(written!).error.message).toBe('Network error');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  test('exits 1 on API error', async () => {
    const mockListBoards = jest.fn().mockRejectedValue(new Error('Network error'));
    const program = buildProgram(mockListBoards);

    await program.parseAsync(['node', 'cli', 'boards', 'list', '--human']);

    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Network error'));
  });

  // The flag check now runs INSIDE the handler, so it happens after credential
  // resolution — intended (#114): credentials are a precondition.
  test('--include bogus exits with error', async () => {
    const mockListBoards = jest.fn().mockResolvedValue(sampleBoards);
    const program = buildProgram(mockListBoards);

    await program.parseAsync(['node', 'cli', 'boards', 'list', '--include', 'bogus', '--human']);

    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid --include values: bogus. Valid options: stats, velocity'));
    expect(mockListBoards).not.toHaveBeenCalled();
  });

  test('--include with mixed valid and invalid values exits with error', async () => {
    const mockListBoards = jest.fn().mockResolvedValue(sampleBoards);
    const program = buildProgram(mockListBoards);

    await program.parseAsync(['node', 'cli', 'boards', 'list', '--include', 'stats,bogus', '--human']);

    expect(process.exitCode).toBe(1);
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
