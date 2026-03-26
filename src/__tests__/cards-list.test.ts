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

  test('calls listCards with board id and limit', async () => {
    const mockListCards = buildMockApi();

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'board-123', '--limit', '10']);

    expect(mockListCards).toHaveBeenCalledWith('board-123', 10);
    expect(consoleSpy).toHaveBeenCalledWith('Found 3 card(s):');
  });

  test('uses default limit of 50 when not specified', async () => {
    const mockListCards = buildMockApi();

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'board-123']);

    expect(mockListCards).toHaveBeenCalledWith('board-123', 50);
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
    const jsonCall = calls.find(c => typeof c === 'string' && c.startsWith('['));
    expect(jsonCall).toBeDefined();
    const parsed = JSON.parse(jsonCall!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(sampleCards.length);
    expect(tableSpy).not.toHaveBeenCalled();
  });

  test('JSON output includes all card fields', async () => {
    buildMockApi([sampleCards[0]]);

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'board-123', '--json']);

    const calls = consoleSpy.mock.calls.map(c => c[0]);
    const jsonCall = calls.find(c => typeof c === 'string' && c.startsWith('['));
    const parsed = JSON.parse(jsonCall!);
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
    const jsonCall = calls.find(c => typeof c === 'string' && c.startsWith('['));
    expect(jsonCall).toBeUndefined();
  });

  // --- Filtering ---

  test('filters cards by status', async () => {
    buildMockApi();

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'board-123', '--status', 'todo', '--json']);

    const calls = consoleSpy.mock.calls.map(c => c[0]);
    const jsonCall = calls.find(c => typeof c === 'string' && c.startsWith('['));
    const parsed = JSON.parse(jsonCall!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].status).toBe('todo');
  });

  test('filters cards by assignee (partial match)', async () => {
    buildMockApi();

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'board-123', '--assignee', 'alice', '--json']);

    const calls = consoleSpy.mock.calls.map(c => c[0]);
    const jsonCall = calls.find(c => typeof c === 'string' && c.startsWith('['));
    const parsed = JSON.parse(jsonCall!);
    expect(parsed).toHaveLength(2); // alice@example.com appears in card-1 and card-3
    parsed.forEach((c: Card) => expect(c.assignees!.some(a => a.includes('alice'))).toBe(true));
  });

  test('filters cards by tag (partial match)', async () => {
    buildMockApi();

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'board-123', '--tag', 'bug', '--json']);

    const calls = consoleSpy.mock.calls.map(c => c[0]);
    const jsonCall = calls.find(c => typeof c === 'string' && c.startsWith('['));
    const parsed = JSON.parse(jsonCall!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].cardId).toBe('card-1');
  });

  test('filter by status is case-insensitive', async () => {
    buildMockApi();

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'board-123', '--status', 'TODO', '--json']);

    const calls = consoleSpy.mock.calls.map(c => c[0]);
    const jsonCall = calls.find(c => typeof c === 'string' && c.startsWith('['));
    const parsed = JSON.parse(jsonCall!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].status).toBe('todo');
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
    const jsonCall = calls.find(c => typeof c === 'string' && c.startsWith('['));
    const parsed = JSON.parse(jsonCall!);
    expect(parsed).toHaveLength(0);
  });

  // --- Pagination ---

  test('passes limit to API', async () => {
    const mockListCards = buildMockApi([]);

    const program = new Command();
    registerCardsListCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'list', '--limit', '100']);

    expect(mockListCards).toHaveBeenCalledWith(undefined, 100);
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
    const jsonCall = calls.find(c => typeof c === 'string' && c.startsWith('['));
    const parsed = JSON.parse(jsonCall!);
    expect(parsed).toHaveLength(120);
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
