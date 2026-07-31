/**
 * Comprehensive tests for cards-list command
 * CLA-1774: Unit Tests — All Commands
 */
import { registerCardsListCommand } from '../commands/cards-list';
import { Command } from 'commander';
import CardsAPI, { Card } from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';

jest.mock('../lib/cards-api');
jest.mock('../lib/http-client');

const sampleCards: Card[] = [
  {
    cardId: 'card-1',
    name: 'Fix login bug',
    status: 'in-progress',
    assignees: ['alice@example.com'],
    tags: ['bug', 'urgent'],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
  },
  {
    cardId: 'card-2',
    name: 'Update README',
    status: 'todo',
    assignees: ['bob@example.com'],
    tags: ['docs'],
    createdAt: '2026-01-03T00:00:00Z',
    updatedAt: '2026-01-04T00:00:00Z',
  },
  {
    cardId: 'card-3',
    name: 'Deploy to production',
    status: 'done',
    assignees: ['alice@example.com'],
    tags: ['release'],
    createdAt: '2026-01-05T00:00:00Z',
    updatedAt: '2026-01-06T00:00:00Z',
  },
];

function buildMockApi(cards: Card[] = sampleCards) {
  const mockListCards = jest.fn().mockResolvedValue(cards);
  (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => ({
    listCards: mockListCards,
    getCard: jest.fn(),
    createCard: jest.fn(),
    createCards: jest.fn(),
    updateCard: jest.fn(),
    deleteCard: jest.fn(),
    searchCards: jest.fn(),
  } as any));
  (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({} as any));
  return mockListCards;
}

describe('Cards List Command', () => {
  let consoleSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let tableSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;
  const originalEnv = process.env.FAVRO_API_TOKEN;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FAVRO_API_TOKEN = 'test-token';
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    tableSpy = jest.spyOn(console, 'table').mockImplementation(() => {});
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.FAVRO_API_TOKEN;
    } else {
      process.env.FAVRO_API_TOKEN = originalEnv;
    }
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    tableSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // --- Registration ---

  test('registers list command on program', () => {
    const program = new Command();
    registerCardsListCommand(program);
    const listCmd = program.commands.find(cmd => cmd.name() === 'cards');
    expect(listCmd).toBeDefined();
  });

  test('list command has expected options', () => {
    const program = new Command();
    registerCardsListCommand(program);
    const listCmd = program.commands.find(cmd => cmd.name() === 'cards');
    const optionNames = listCmd!.options.map(o => o.long);
    expect(optionNames).toContain('--board');
    expect(optionNames).toContain('--status');
    expect(optionNames).toContain('--assignee');
    expect(optionNames).toContain('--tag');
    expect(optionNames).toContain('--limit');
    expect(optionNames).toContain('--json');
    expect(optionNames).toContain('--csv');
  });

  // --- Happy path ---

  // #44: `--limit` is a pure OUTPUT cap; it never reaches the fetch.
  test('calls listCards with the board id, and no limit', async () => {
    const mockListCards = buildMockApi();

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'board-123', '--limit', '10']);

    expect(mockListCards).toHaveBeenCalledWith(
      expect.objectContaining({ boardId: 'board-123', archived: 'false' })
    );
    expect(mockListCards.mock.calls[0][0]).not.toHaveProperty('limit');
    expect(consoleSpy).toHaveBeenCalledWith('Found 3 card(s):');
  });

  test('reads live cards only when --archived is not given', async () => {
    const mockListCards = buildMockApi();

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'board-123']);

    expect(mockListCards).toHaveBeenCalledWith(
      expect.objectContaining({ boardId: 'board-123', archived: 'false' })
    );
  });

  test('outputs table format by default', async () => {
    buildMockApi();

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'board-123']);

    expect(tableSpy).toHaveBeenCalled();
  });

  // --- Output formats ---

  test('outputs JSON when --json flag is set', async () => {
    buildMockApi();

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'board-123', '--json']);

    const calls = consoleSpy.mock.calls.map(c => c[0]);
    const jsonCall = calls.find(c => typeof c === 'string' && c.startsWith('{"rows":'));
    expect(jsonCall).toBeDefined();
    // #44: a list read emits `{rows, truncated?, unreachable?}`, always.
    const parsed = JSON.parse(jsonCall!);
    expect(Array.isArray(parsed.rows)).toBe(true);
    expect(parsed.rows).toHaveLength(sampleCards.length);
    expect(tableSpy).not.toHaveBeenCalled();
  });

  test('JSON output includes all card fields', async () => {
    buildMockApi([sampleCards[0]]);

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'board-123', '--json']);

    const calls = consoleSpy.mock.calls.map(c => c[0]);
    const jsonCall = calls.find(c => typeof c === 'string' && c.startsWith('{"rows":'));
    const parsed = JSON.parse(jsonCall!).rows;
    expect(parsed[0]).toHaveProperty('cardId', 'card-1');
    expect(parsed[0]).toHaveProperty('name', 'Fix login bug');
    expect(parsed[0]).toHaveProperty('status', 'in-progress');
  });

  // --- CSV output format ---

  test('outputs CSV when --csv flag is set', async () => {
    buildMockApi();

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'board-123', '--csv']);

    // Should NOT call console.table or output JSON
    expect(tableSpy).not.toHaveBeenCalled();
    // Should have CSV header as first log call
    const calls = consoleSpy.mock.calls.map(c => c[0]);
    const headerCall = calls.find(c => typeof c === 'string' && c.includes('"ID"') && c.includes('"Title"'));
    expect(headerCall).toBeDefined();
    expect(headerCall).toContain('"Status"');
    expect(headerCall).toContain('"Assignees"');
  });

  test('CSV output contains card data', async () => {
    buildMockApi([sampleCards[0]]);

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'board-123', '--csv']);

    const calls = consoleSpy.mock.calls.map(c => c[0]);
    // Should have at least header + one data row
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const dataRow = calls.find(c => typeof c === 'string' && c.includes('"card-1"'));
    expect(dataRow).toBeDefined();
    expect(dataRow).toContain('"Fix login bug"');
  });

  test('CSV output does not include JSON or table', async () => {
    buildMockApi(sampleCards);

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'board-123', '--csv']);

    expect(tableSpy).not.toHaveBeenCalled();
    const calls = consoleSpy.mock.calls.map(c => c[0]);
    const jsonCall = calls.find(c => typeof c === 'string' && c.startsWith('{"rows":'));
    expect(jsonCall).toBeUndefined();
  });

  // --- Filtering ---

  // #43: --status is a column, narrowed on the wire. It is handed down verbatim
  // (resolution and case-folding live in ColumnDirectory, pinned by
  // column-resolution-wire.test.ts) and the answer is NOT filtered again here —
  // re-filtering would drop cards the wire already scoped correctly.
  test('hands --status to the wire and does not re-filter the answer', async () => {
    const mockListCards = buildMockApi();

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'board-123', '--status', 'todo', '--json']);

    expect(mockListCards).toHaveBeenCalledWith(
      expect.objectContaining({ boardId: 'board-123', status: 'todo' })
    );
    const calls = consoleSpy.mock.calls.map(c => c[0]);
    const jsonCall = calls.find(c => typeof c === 'string' && c.startsWith('{"rows":'));
    expect(JSON.parse(jsonCall!).rows).toHaveLength(3);
  });

  test('--collection is passed through as the scope', async () => {
    const mockListCards = buildMockApi();

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--collection', 'coll-1', '--json']);

    expect(mockListCards).toHaveBeenCalledWith(
      expect.objectContaining({ collectionId: 'coll-1' })
    );
  });

  test('filters cards by assignee (partial match)', async () => {
    buildMockApi();

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'board-123', '--assignee', 'alice', '--json']);

    const calls = consoleSpy.mock.calls.map(c => c[0]);
    const jsonCall = calls.find(c => typeof c === 'string' && c.startsWith('{"rows":'));
    const parsed = JSON.parse(jsonCall!).rows;
    expect(parsed).toHaveLength(2); // alice@example.com appears in card-1 and card-3
    parsed.forEach((c: Card) => expect(c.assignees!.some(a => a.includes('alice'))).toBe(true));
  });

  test('filters cards by tag (partial match)', async () => {
    buildMockApi();

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'board-123', '--tag', 'bug', '--json']);

    const calls = consoleSpy.mock.calls.map(c => c[0]);
    const jsonCall = calls.find(c => typeof c === 'string' && c.startsWith('{"rows":'));
    const parsed = JSON.parse(jsonCall!).rows;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].cardId).toBe('card-1');
  });

  // --- Empty results ---

  test('handles empty results gracefully', async () => {
    buildMockApi([]);

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'board-123']);

    expect(consoleSpy).toHaveBeenCalledWith('Found 0 card(s):');
    expect(consoleSpy).toHaveBeenCalledWith('No cards found.');
  });

  test('empty results with filter shows zero matches', async () => {
    buildMockApi(sampleCards);

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'board-123', '--assignee', 'nobody', '--json']);

    const calls = consoleSpy.mock.calls.map(c => c[0]);
    const jsonCall = calls.find(c => typeof c === 'string' && c.startsWith('{"rows":'));
    const parsed = JSON.parse(jsonCall!).rows;
    expect(parsed).toHaveLength(0);
  });

  // --- Pagination ---

  // #44 rewrote these three. `--limit` used to truncate the FETCH — so every
  // client-side filter downstream filtered a partial set. It is now an OUTPUT
  // cap and never reaches the API at all.
  test('--limit never reaches the fetch', async () => {
    const mockListCards = buildMockApi([]);

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--limit', '100']);

    expect(mockListCards.mock.calls[0][0]).not.toHaveProperty('limit');
  });

  test('the output cap trims the rows and marks them truncated', async () => {
    buildMockApi(sampleCards);

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'b', '--limit', '2', '--json']);

    const calls = consoleSpy.mock.calls.map(c => c[0]);
    const jsonCall = calls.find(c => typeof c === 'string' && c.startsWith('{"rows":'));
    const parsed = JSON.parse(jsonCall!);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.truncated).toBe(true);
  });

  test('an uncut list carries no truncated marker', async () => {
    buildMockApi(sampleCards);

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'b', '--limit', '50', '--json']);

    const calls = consoleSpy.mock.calls.map(c => c[0]);
    const jsonCall = calls.find(c => typeof c === 'string' && c.startsWith('{"rows":'));
    expect(JSON.parse(jsonCall!).truncated).toBeUndefined();
  });

  test('handles large result sets (100+ cards)', async () => {
    const largeCardSet = Array.from({ length: 120 }, (_, i) => ({
      cardId: `card-${i}`,
      name: `Card ${i}`,
      status: i % 2 === 0 ? 'todo' : 'done',
      assignees: ['alice'],
      tags: ['tag'],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));
    buildMockApi(largeCardSet);

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'board-123', '--limit', '120', '--json']);

    const calls = consoleSpy.mock.calls.map(c => c[0]);
    const jsonCall = calls.find(c => typeof c === 'string' && c.startsWith('{"rows":'));
    const parsed = JSON.parse(jsonCall!);
    expect(parsed.rows).toHaveLength(120);
  });

  // --- Table format details ---

  test('table output truncates long card names', async () => {
    const longNameCard: Card = {
      cardId: 'card-long',
      name: 'A'.repeat(60),
      status: 'todo',
      assignees: [],
      tags: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    buildMockApi([longNameCard]);

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'board-123']);

    // console.table should be called
    expect(tableSpy).toHaveBeenCalled();
    // The table rows should have truncated title
    const tableArg = tableSpy.mock.calls[0][0];
    expect(tableArg[0].Title.length).toBeLessThanOrEqual(40);
    expect(tableArg[0].Title).toContain('...');
  });

  test('table output uses dash for missing fields', async () => {
    const sparseCard: Card = {
      cardId: 'card-sparse',
      name: 'Sparse Card',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    buildMockApi([sparseCard]);

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'board-123']);

    const tableArg = tableSpy.mock.calls[0][0];
    expect(tableArg[0].Status).toBe('—');
    expect(tableArg[0].Assignees).toBe('—');
    expect(tableArg[0].Tags).toBe('—');
  });

  // --- Error handling ---

  test('handles API error gracefully', async () => {
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => ({
      listCards: jest.fn().mockRejectedValue(new Error('API error')),
    } as any));
    (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({} as any));

    const program = new Command();
    registerCardsListCommand(program);

    await expect(
      program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'board-123'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API error'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('handles rate limiting error (429)', async () => {
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => ({
      listCards: jest.fn().mockRejectedValue(new Error('Too Many Requests')),
    } as any));
    (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({} as any));

    const program = new Command();
    registerCardsListCommand(program);

    await expect(
      program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'board-123'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  test('handles network timeout error', async () => {
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => ({
      listCards: jest.fn().mockRejectedValue(new Error('ETIMEDOUT')),
    } as any));
    (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({} as any));

    const program = new Command();
    registerCardsListCommand(program);

    await expect(
      program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'board-123'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('ETIMEDOUT'));
  });
});
