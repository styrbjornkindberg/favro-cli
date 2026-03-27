/**
 * Tests for cards export command and CSV/JSON formatting
 * FAVRO-009: Cards Export Command
 */
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { registerCardsExportCommand, applyFilter, applyFilters } from '../commands/cards-export';
import { escapeCsvField, cardsToCSV, normalizeCard, writeCardsCSV, writeCardsJSON } from '../lib/csv';
import CardsAPI, { Card } from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';

jest.mock('../lib/cards-api');
jest.mock('../lib/http-client');

// ----------------------------
// Sample card fixtures
// ----------------------------

const sampleCards: Card[] = [
  {
    cardId: 'card-001',
    name: 'Fix login bug',
    description: 'Users cannot log in with special chars like "quotes"',
    status: 'in-progress',
    assignees: ['alice@example.com'],
    tags: ['bug', 'urgent'],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
  },
  {
    cardId: 'card-002',
    name: 'Update README',
    description: '',
    status: 'todo',
    assignees: ['bob@example.com', 'carol@example.com'],
    tags: ['docs'],
    createdAt: '2026-01-03T00:00:00Z',
    updatedAt: '2026-01-04T00:00:00Z',
  },
  {
    cardId: 'card-003',
    name: 'Deploy to production',
    description: 'Production release, requires sign-off',
    status: 'done',
    assignees: ['alice@example.com'],
    tags: ['release'],
    createdAt: '2026-01-05T00:00:00Z',
    updatedAt: '2026-01-06T00:00:00Z',
  },
];

// ----------------------------
// normalizeCard tests
// ----------------------------

describe('normalizeCard', () => {
  test('maps cardId to id and name to title', () => {
    const card = normalizeCard(sampleCards[0]);
    expect(card.id).toBe('card-001');
    expect(card.title).toBe('Fix login bug');
  });

  test('joins assignees with semicolons', () => {
    const card = normalizeCard(sampleCards[1]);
    expect(card.assignees).toBe('bob@example.com;carol@example.com');
  });

  test('joins tags/labels with semicolons', () => {
    const card = normalizeCard(sampleCards[0]);
    expect(card.labels).toBe('bug;urgent');
  });

  test('defaults empty fields to empty string', () => {
    const sparse: Card = {
      cardId: 'c-sparse',
      name: 'sparse',
      createdAt: '',
      updatedAt: '',
    };
    const card = normalizeCard(sparse);
    expect(card.description).toBe('');
    expect(card.status).toBe('');
    expect(card.assignees).toBe('');
    expect(card.labels).toBe('');
    expect(card.dueDate).toBe('');
  });

  test('maps dueDate field from Card interface (type-safe, no any cast)', () => {
    const cardWithDue: Card = {
      cardId: 'card-due',
      name: 'Task with due date',
      dueDate: '2026-12-31',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const result = normalizeCard(cardWithDue);
    expect(result.dueDate).toBe('2026-12-31');
  });
});

// ----------------------------
// escapeCsvField tests
// ----------------------------

describe('escapeCsvField', () => {
  test('wraps plain strings in quotes', () => {
    expect(escapeCsvField('hello')).toBe('"hello"');
  });

  test('doubles embedded double-quotes', () => {
    expect(escapeCsvField('say "hello"')).toBe('"say ""hello"""');
  });

  test('handles commas inside field', () => {
    expect(escapeCsvField('a,b,c')).toBe('"a,b,c"');
  });

  test('handles newlines inside field (RFC 4180)', () => {
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
  });

  test('handles empty string', () => {
    expect(escapeCsvField('')).toBe('""');
  });

  test('converts non-string values', () => {
    expect(escapeCsvField(42 as any)).toBe('"42"');
  });

  // Fix #10: Unicode and emoji edge cases
  test('handles emoji in field values', () => {
    expect(escapeCsvField('🚀 Launch feature')).toBe('"🚀 Launch feature"');
  });

  test('handles multi-byte unicode characters', () => {
    expect(escapeCsvField('日本語テスト')).toBe('"日本語テスト"');
  });

  test('handles 1000+ char description', () => {
    const longStr = 'a'.repeat(1200);
    const result = escapeCsvField(longStr);
    expect(result).toBe(`"${longStr}"`);
    expect(result.length).toBe(1202); // 1200 + 2 quotes
  });

  test('handles embedded CRLF newlines (RFC 4180)', () => {
    expect(escapeCsvField('line1\r\nline2')).toBe('"line1\r\nline2"');
  });
});

// ----------------------------
// cardsToCSV tests
// ----------------------------

describe('cardsToCSV', () => {
  test('first row is header with all expected fields', () => {
    const csv = cardsToCSV([normalizeCard(sampleCards[0])]);
    const firstRow = csv.split('\n')[0];
    expect(firstRow).toContain('"id"');
    expect(firstRow).toContain('"title"');
    expect(firstRow).toContain('"description"');
    expect(firstRow).toContain('"status"');
    expect(firstRow).toContain('"assignees"');
    expect(firstRow).toContain('"labels"');
    expect(firstRow).toContain('"dueDate"');
    expect(firstRow).toContain('"createdAt"');
    expect(firstRow).toContain('"updatedAt"');
  });

  test('produces correct number of data rows', () => {
    const normalized = sampleCards.map(normalizeCard);
    const csv = cardsToCSV(normalized);
    const lines = csv.trim().split('\n');
    // 1 header + N data rows
    expect(lines.length).toBe(sampleCards.length + 1);
  });

  test('card data appears correctly quoted in CSV', () => {
    const normalized = [normalizeCard(sampleCards[0])];
    const csv = cardsToCSV(normalized);
    const dataRow = csv.split('\n')[1];
    expect(dataRow).toContain('"card-001"');
    expect(dataRow).toContain('"Fix login bug"');
    expect(dataRow).toContain('"in-progress"');
  });

  test('double-quotes inside fields are escaped', () => {
    const normalized = [normalizeCard(sampleCards[0])];
    const csv = cardsToCSV(normalized);
    // Description has "quotes"
    expect(csv).toContain('""quotes""');
  });

  test('empty card list returns only header row', () => {
    const csv = cardsToCSV([]);
    const lines = csv.trim().split('\n');
    expect(lines.length).toBe(1); // header only
  });

  // Fix #10: Unicode edge cases in cardsToCSV
  test('handles card with emoji title in CSV output', () => {
    const emojiCard: Card = {
      cardId: 'card-emoji',
      name: '🚀 Rocket feature',
      description: 'Ship it! 🎉',
      status: 'todo',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const csv = cardsToCSV([normalizeCard(emojiCard)]);
    expect(csv).toContain('🚀 Rocket feature');
    expect(csv).toContain('🎉');
  });

  test('handles card with embedded newlines in description', () => {
    const newlineCard: Card = {
      cardId: 'card-nl',
      name: 'Multi-line',
      description: 'Step 1: Do this\nStep 2: Do that\nStep 3: Done',
      status: 'todo',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const csv = cardsToCSV([normalizeCard(newlineCard)]);
    // Newlines should be inside quotes (valid RFC 4180)
    expect(csv).toContain('"Step 1: Do this\nStep 2: Do that\nStep 3: Done"');
  });

  test('handles 1000+ char description in CSV', () => {
    const longDesc = 'x'.repeat(1500);
    const longCard: Card = {
      cardId: 'card-long',
      name: 'Long description card',
      description: longDesc,
      status: 'todo',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const csv = cardsToCSV([normalizeCard(longCard)]);
    expect(csv).toContain(longDesc);
  });
});

// ----------------------------
// ----------------------------
// applyFilter tests (using enhanced query parser)
// ----------------------------

describe('applyFilter', () => {
  test('filters by assignee using ~ (contains operator)', () => {
    const result = applyFilter(sampleCards, 'assignee~alice');
    expect(result.length).toBe(2);
    result.forEach(c => expect(c.assignees).toContain('alice@example.com'));
  });

  test('filters by assignee exact match', () => {
    const result = applyFilter(sampleCards, 'assignee:alice@example.com');
    expect(result.length).toBe(2);
    result.forEach(c => expect(c.assignees).toContain('alice@example.com'));
  });

  test('filters by status (exact match)', () => {
    const result = applyFilter(sampleCards, 'status:todo');
    expect(result.length).toBe(1);
    expect(result[0].cardId).toBe('card-002');
  });

  test('filters by label/tag using ~ (contains)', () => {
    const result = applyFilter(sampleCards, 'label~bug');
    expect(result.length).toBe(1);
    expect(result[0].cardId).toBe('card-001');
  });

  test('filters by tag exact match', () => {
    const result = applyFilter(sampleCards, 'tag:bug');
    expect(result.length).toBe(1);
    expect(result[0].cardId).toBe('card-001');
  });

  test('filters using AND operator', () => {
    const result = applyFilter(sampleCards, 'assignee~alice AND status:done');
    expect(result.length).toBe(1);
    expect(result[0].cardId).toBe('card-003');
  });

  test('filters using OR operator', () => {
    const result = applyFilter(sampleCards, 'status:done OR status:todo');
    expect(result.length).toBe(2);
  });

  test('returns empty array when no cards match', () => {
    const result = applyFilter(sampleCards, 'assignee~nobody');
    expect(result.length).toBe(0);
  });

  test('exits with error on invalid filter syntax', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });

    expect(() => applyFilter(sampleCards, 'invalid:(((unmatched')).toThrow('process.exit');
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ----------------------------
// Large export test (10k+ cards) — Fix #9
// ----------------------------

describe('Large exports (10k+ cards)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'favro-large-test-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}
  });

  function generateCards(count: number): Card[] {
    return Array.from({ length: count }, (_, i) => ({
      cardId: `card-${i.toString().padStart(6, '0')}`,
      name: `Card ${i} - 🚀 feature`,
      description: `Description for card ${i}. `.repeat(10),
      status: i % 3 === 0 ? 'done' : i % 3 === 1 ? 'in-progress' : 'todo',
      assignees: [`user${i % 5}@example.com`],
      tags: [`tag${i % 10}`],
      dueDate: i % 2 === 0 ? `2026-${String((i % 12) + 1).padStart(2, '0')}-15` : undefined,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    }));
  }

  test('writes 10,000+ cards to CSV without error', async () => {
    const cards = generateCards(10000);
    const outFile = path.join(tmpDir, 'large.csv');
    await writeCardsCSV(cards, outFile);

    expect(fs.existsSync(outFile)).toBe(true);
    const content = fs.readFileSync(outFile, 'utf-8');
    const lines = content.trim().split('\n');
    // 1 header + 10000 data rows
    expect(lines.length).toBe(10001);
  });

  test('writes 10,000+ cards to JSON without error', async () => {
    const cards = generateCards(10000);
    const outFile = path.join(tmpDir, 'large.json');
    await writeCardsJSON(cards, outFile);

    expect(fs.existsSync(outFile)).toBe(true);
    const content = fs.readFileSync(outFile, 'utf-8');
    const parsed = JSON.parse(content);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(10000);
  });

  test('10k CSV includes dueDate values (type-safe Card.dueDate)', async () => {
    const cards = generateCards(100);
    const outFile = path.join(tmpDir, 'due.csv');
    await writeCardsCSV(cards, outFile);

    const content = fs.readFileSync(outFile, 'utf-8');
    // Even-indexed cards have dueDate set
    expect(content).toContain('2026-01-15');
  });

  test('10k CSV preserves emoji in card names', async () => {
    const cards = generateCards(100);
    const outFile = path.join(tmpDir, 'emoji.csv');
    await writeCardsCSV(cards, outFile);

    const content = fs.readFileSync(outFile, 'utf-8');
    expect(content).toContain('🚀 feature');
  });
});

// ----------------------------
// registerCardsExportCommand tests
// ----------------------------

describe('registerCardsExportCommand', () => {
  let tmpDir: string;
  const originalEnv = process.env.FAVRO_API_TOKEN;

  beforeEach(() => {
    // Use a temp dir WITHIN cwd so path traversal check passes
    tmpDir = fs.mkdtempSync(path.join(process.cwd(), '.test-tmp-'));
    // Set token so tests don't fail on missing token check
    process.env.FAVRO_API_TOKEN = 'test-token';
    (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({} as any));
  });

  afterEach(() => {
    // Clean up temp files
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}
    // Restore env
    if (originalEnv === undefined) {
      delete process.env.FAVRO_API_TOKEN;
    } else {
      process.env.FAVRO_API_TOKEN = originalEnv;
    }
    jest.clearAllMocks();
  });

  function mockApi(cards: Card[]) {
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => ({
      listCards: jest.fn().mockResolvedValue(cards),
      getCard: jest.fn(),
      createCard: jest.fn(),
      createCards: jest.fn(),
      updateCard: jest.fn(),
      deleteCard: jest.fn(),
      searchCards: jest.fn(),
    } as any));
  }

  test('registers export command on program', () => {
    const program = new Command();
    registerCardsExportCommand(program);
    const cmd = program.commands.find(c => c.name() === 'cards');
    expect(cmd).toBeDefined();
  });

  test('exports cards to CSV file', async () => {
    mockApi(sampleCards);
    const outFile = path.join(tmpDir, 'export.csv');

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const program = new Command();
    registerCardsExportCommand(program);

    await program.parseAsync([
      'node', 'test',
      'cards', 'export', 'board-123',
      '--format', 'csv',
      '--out', outFile,
    ]);

    expect(fs.existsSync(outFile)).toBe(true);
    const content = fs.readFileSync(outFile, 'utf-8');
    // Check header
    expect(content).toContain('"id"');
    expect(content).toContain('"title"');
    // Check data
    expect(content).toContain('"card-001"');
    expect(content).toContain('"Fix login bug"');

    consoleSpy.mockRestore();
  });

  test('exports cards to JSON file', async () => {
    mockApi(sampleCards);
    const outFile = path.join(tmpDir, 'export.json');

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const program = new Command();
    registerCardsExportCommand(program);

    await program.parseAsync([
      'node', 'test',
      'cards', 'export', 'board-123',
      '--format', 'json',
      '--out', outFile,
    ]);

    expect(fs.existsSync(outFile)).toBe(true);
    const content = fs.readFileSync(outFile, 'utf-8');
    const parsed = JSON.parse(content);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(sampleCards.length);
    expect(parsed[0].id).toBe('card-001');
    expect(parsed[0].title).toBe('Fix login bug');

    consoleSpy.mockRestore();
  });

  test('JSON output is valid UTF-8 and pretty-printed', async () => {
    mockApi([sampleCards[0]]);
    const outFile = path.join(tmpDir, 'pretty.json');

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const program = new Command();
    registerCardsExportCommand(program);

    await program.parseAsync([
      'node', 'test',
      'cards', 'export', 'board-123',
      '--format', 'json',
      '--out', outFile,
    ]);

    const content = fs.readFileSync(outFile, 'utf-8');
    // Pretty-printed = contains indentation
    expect(content).toMatch(/\n  /);
    consoleSpy.mockRestore();
  });

  test('applies --filter before export', async () => {
    mockApi(sampleCards);
    const outFile = path.join(tmpDir, 'filtered.json');

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const program = new Command();
    registerCardsExportCommand(program);

    await program.parseAsync([
      'node', 'test',
      'cards', 'export', 'board-123',
      '--format', 'json',
      '--filter', 'status:todo',
      '--out', outFile,
    ]);

    const content = fs.readFileSync(outFile, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.length).toBe(1);
    expect(parsed[0].status).toBe('todo');

    consoleSpy.mockRestore();
  });

  test('exits with error for invalid format', async () => {
    mockApi(sampleCards);
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });

    const program = new Command();
    registerCardsExportCommand(program);

    await expect(
      program.parseAsync([
        'node', 'test',
        'cards', 'export', 'board-123',
        '--format', 'xlsx',
        '--out', path.join(tmpDir, 'out.xlsx'),
      ])
    ).rejects.toThrow('process.exit');

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid format'));

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  test('handles API error gracefully', async () => {
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => ({
      listCards: jest.fn().mockRejectedValue(new Error('Network error')),
      getCard: jest.fn(),
      createCard: jest.fn(),
      createCards: jest.fn(),
      updateCard: jest.fn(),
      deleteCard: jest.fn(),
      searchCards: jest.fn(),
    } as any));

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });

    const program = new Command();
    registerCardsExportCommand(program);

    await expect(
      program.parseAsync([
        'node', 'test',
        'cards', 'export', 'board-123',
        '--format', 'json',
        '--out', path.join(tmpDir, 'fail.json'),
      ])
    ).rejects.toThrow('process.exit');

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Network error'));

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // Fix #2: FAVRO_API_TOKEN missing should exit with error
  test('exits with error when FAVRO_API_TOKEN is not set', async () => {
    delete process.env.FAVRO_API_TOKEN;
    mockApi(sampleCards);

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });

    const program = new Command();
    registerCardsExportCommand(program);

    await expect(
      program.parseAsync([
        'node', 'test',
        'cards', 'export', 'board-123',
        '--format', 'json',
        '--out', path.join(tmpDir, 'out.json'),
      ])
    ).rejects.toThrow('process.exit');

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('API key'));

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // Fix #1: --limit 0 should NOT silently become 10000 (uses safeLimit = 10000 as fallback for <1)
  test('--limit 0 falls back to default 10000 (not silently coerced by ||)', async () => {
    mockApi(sampleCards);
    const outFile = path.join(tmpDir, 'limit0.json');

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const listCardsSpy = jest.fn().mockResolvedValue(sampleCards);
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => ({
      listCards: listCardsSpy,
    } as any));

    const program = new Command();
    registerCardsExportCommand(program);

    await program.parseAsync([
      'node', 'test',
      'cards', 'export', 'board-123',
      '--format', 'json',
      '--limit', '0',
      '--out', outFile,
    ]);

    // With safeLimit: 0 < 1 → falls back to 10000
    expect(listCardsSpy).toHaveBeenCalledWith('board-123', 10000);

    consoleSpy.mockRestore();
  });

  // Fix #5: --limit -5 should be rejected, falls back to 10000
  test('--limit -5 falls back to default 10000 (negative values rejected)', async () => {
    mockApi(sampleCards);
    const outFile = path.join(tmpDir, 'limit-neg.json');

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const listCardsSpy = jest.fn().mockResolvedValue(sampleCards);
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => ({
      listCards: listCardsSpy,
    } as any));

    const program = new Command();
    registerCardsExportCommand(program);

    await program.parseAsync([
      'node', 'test',
      'cards', 'export', 'board-123',
      '--format', 'json',
      '--limit', '-5',
      '--out', outFile,
    ]);

    // With safeLimit: -5 < 1 → falls back to 10000
    expect(listCardsSpy).toHaveBeenCalledWith('board-123', 10000);

    consoleSpy.mockRestore();
  });

  // Fix #3: path traversal protection
  test('exits with error when --out path is outside cwd', async () => {
    mockApi(sampleCards);

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });

    const program = new Command();
    registerCardsExportCommand(program);

    await expect(
      program.parseAsync([
        'node', 'test',
        'cards', 'export', 'board-123',
        '--format', 'json',
        '--out', '/tmp/traversal-attack.json',
      ])
    ).rejects.toThrow('process.exit');

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Output path must be within current directory'));

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // Fix #1: --limit 5 (valid positive value) passes correctly
  test('--limit 5 passes valid value to API', async () => {
    const outFile = path.join(tmpDir, 'limit5.json');
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const listCardsSpy = jest.fn().mockResolvedValue(sampleCards);
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => ({
      listCards: listCardsSpy,
    } as any));

    const program = new Command();
    registerCardsExportCommand(program);

    await program.parseAsync([
      'node', 'test',
      'cards', 'export', 'board-123',
      '--format', 'json',
      '--limit', '5',
      '--out', outFile,
    ]);

    expect(listCardsSpy).toHaveBeenCalledWith('board-123', 5);

    consoleSpy.mockRestore();
  });
});

// ----------------------------
// applyFilters — multi-filter AND logic
// ----------------------------

describe('applyFilters', () => {
  test('returns all cards when filters array is empty', () => {
    const result = applyFilters(sampleCards, []);
    expect(result).toHaveLength(sampleCards.length);
  });

  test('applies a single filter correctly', () => {
    const result = applyFilters(sampleCards, ['status:done']);
    expect(result).toHaveLength(1);
    expect(result[0].cardId).toBe('card-003');
  });

  test('applies two filters with AND logic (assignee AND status)', () => {
    // alice@example.com has cards card-001 (in-progress) and card-003 (done)
    const result = applyFilters(sampleCards, ['assignee~alice', 'status:done']);
    expect(result).toHaveLength(1);
    expect(result[0].cardId).toBe('card-003');
    expect(result[0].assignees).toContain('alice@example.com');
    expect(result[0].status).toBe('done');
  });

  test('returns empty array when filters eliminate all cards (AND logic)', () => {
    // alice doesn't have any todo cards
    const result = applyFilters(sampleCards, ['assignee~alice', 'status:todo']);
    expect(result).toHaveLength(0);
  });

  test('applies three filters with AND logic', () => {
    const result = applyFilters(sampleCards, ['assignee~alice', 'status:in-progress', 'tag:bug']);
    expect(result).toHaveLength(1);
    expect(result[0].cardId).toBe('card-001');
  });

  test('each filter is applied in sequence (reducer behavior)', () => {
    // Start with 3 cards
    // assignee~alice → 2 cards (card-001, card-003)
    // tag:release → 1 card (card-003)
    const result = applyFilters(sampleCards, ['assignee~alice', 'tag:release']);
    expect(result).toHaveLength(1);
    expect(result[0].cardId).toBe('card-003');
  });
});

// ----------------------------
// File I/O error paths (disk full, permission denied)
// Tested via a non-existent directory path that causes actual OS errors.
// ----------------------------

describe('writeCardsCSV — file I/O error paths', () => {
  test('rejects with error when output directory cannot be created (EACCES)', async () => {
    // Writing to a path inside a non-existent protected location will fail
    const badPath = '/no-such-root-dir/subdir/test.csv';

    // mkdirSync will throw ENOENT or EACCES for this path
    await expect(writeCardsCSV(sampleCards, badPath)).rejects.toThrow();
  });

  test('rejects with error for invalid file path on CSV write', async () => {
    // Use a path where the dir doesn't exist and can't be created
    const invalidPath = '/root/protected-dir-that-does-not-exist/test.csv';

    await expect(writeCardsCSV(sampleCards, invalidPath)).rejects.toThrow();
  });

  test('writeCardsCSV error surfaces as rejected promise (not unhandled)', async () => {
    // Write to a bad path — verify it's a proper rejection, not a thrown exception
    const result = writeCardsCSV(sampleCards, '/no-such-dir/test.csv');
    await expect(result).rejects.toBeInstanceOf(Error);
  });
});

describe('writeCardsJSON — file I/O error paths', () => {
  test('rejects with error when output directory cannot be created (JSON)', async () => {
    const badPath = '/no-such-root-dir/subdir/test.json';

    await expect(writeCardsJSON(sampleCards, badPath)).rejects.toThrow();
  });

  test('rejects with error for invalid file path on JSON write', async () => {
    const invalidPath = '/root/protected-dir-that-does-not-exist/test.json';

    await expect(writeCardsJSON(sampleCards, invalidPath)).rejects.toThrow();
  });

  test('writeCardsJSON error surfaces as rejected promise (not unhandled)', async () => {
    const result = writeCardsJSON(sampleCards, '/no-such-dir/test.json');
    await expect(result).rejects.toBeInstanceOf(Error);
  });
});
