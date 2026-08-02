/**
 * Tests for `cards export` and the CSV/JSON formatting behind it.
 * FAVRO-009: Cards Export Command
 *
 * The command arm drives `buildProgram()` — the program `bin/favro` builds —
 * and nothing else. It used to drive `registerCardsExportCommand`, a second
 * registration in the then-`commands/cards-export.ts` that `cli.ts` never
 * called (#139; what survives of that file now lives in `lib/`).
 * Both routed through `applyFilters`, so the suite LOOKED like end-to-end
 * coverage of the export: deleting the live `applyFilters` call left every one
 * of these tests green. A twin close enough to pass the real path's tests is
 * worse than no test at all.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { buildProgram } from '../cli';
import { applyFilter, applyFilters } from '../lib/cards-export';
import { ParseError } from '../lib/query-parser';
import {
  STUB_BOARD,
  stubFilterContext,
  stubVocabularyClient,
  useTempConfigDir,
} from '../test-support/filter-vocabulary';
import { escapeCsvField, cardsToCSV, normalizeCard, writeCardsCSV, writeCardsJSON } from '../lib/csv';
import CardsAPI, { Card } from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';
import * as config from '../lib/config';

jest.mock('../lib/cards-api');
jest.mock('../lib/http-client');
jest.mock('../lib/config');

useTempConfigDir();

/** The org every filter here is settled against — see #83. */
const ctx = () => stubFilterContext();

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
  test('filters by assignee using ~ (contains operator)', async () => {
    const result = await applyFilter(sampleCards, 'assignee~alice', ctx());
    expect(result.length).toBe(2);
    result.forEach(c => expect(c.assignees).toContain('alice@example.com'));
  });

  test('filters by assignee exact match', async () => {
    const result = await applyFilter(sampleCards, 'assignee:alice@example.com', ctx());
    expect(result.length).toBe(2);
    result.forEach(c => expect(c.assignees).toContain('alice@example.com'));
  });

  test('filters by status (exact match)', async () => {
    const result = await applyFilter(sampleCards, 'status:todo', ctx());
    expect(result.length).toBe(1);
    expect(result[0].cardId).toBe('card-002');
  });

  test('filters by label/tag using ~ (contains)', async () => {
    const result = await applyFilter(sampleCards, 'label~bug', ctx());
    expect(result.length).toBe(1);
    expect(result[0].cardId).toBe('card-001');
  });

  test('filters by tag exact match', async () => {
    const result = await applyFilter(sampleCards, 'tag:bug', ctx());
    expect(result.length).toBe(1);
    expect(result[0].cardId).toBe('card-001');
  });

  test('filters using AND operator', async () => {
    const result = await applyFilter(sampleCards, 'assignee~alice AND status:done', ctx());
    expect(result.length).toBe(1);
    expect(result[0].cardId).toBe('card-003');
  });

  test('filters using OR operator', async () => {
    const result = await applyFilter(sampleCards, 'status:done OR status:todo', ctx());
    expect(result.length).toBe(2);
  });

  test('returns empty array when the vocabulary matches nothing', async () => {
    // A tag that EXISTS and no card carries is a true empty. `assignee~nobody`
    // used to sit here and is now a refusal — see the next test.
    const result = await applyFilter(sampleCards, 'tag:high-priority', ctx());
    expect(result.length).toBe(0);
  });

  test('an assignee outside the org refuses instead of answering zero rows (#83)', async () => {
    await expect(applyFilter(sampleCards, 'assignee~nobody', ctx()))
      .rejects.toThrow(/nobody/);
  });

  test('refuses invalid filter syntax', async () => {
    await expect(applyFilter(sampleCards, 'invalid:(((unmatched', ctx()))
      .rejects.toBeInstanceOf(ParseError);
  });

  test('refuses `unblocked` and names where it lives, rather than over-excluding', async () => {
    // An export writes a file: no envelope, so no way to say which blockers it
    // could not check. Answering would silently drop every card with any edge.
    // The refusal is RAISED, so the command reports it the way `cards list`
    // reports its own (#83) — it is not printed and exited from in here.
    await expect(applyFilter(sampleCards, 'unblocked', ctx()))
      .rejects.toThrow(/cards list/);

    // A specific edge needs no judgement, so it still works.
    await expect(applyFilter(sampleCards, 'blocked-by:CLA-1', ctx())).resolves.toEqual([]);
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
// `cards export`, as a user types it — through buildProgram()
// ----------------------------

describe('cards export (live command)', () => {
  let tmpDir: string;
  /** Every path here writes progress and refusals to stderr; captured, not printed. */
  let said: jest.SpyInstance;
  const originalEnv = process.env.FAVRO_API_TOKEN;
  const printed = (): string => said.mock.calls.map((c) => String(c[0])).join('\n');

  beforeEach(() => {
    said = jest.spyOn(console, 'error').mockImplementation(() => {});
    // Inside cwd, because the --out guard rejects anything outside it: the file
    // a refusal test proves is NOT written has to be somewhere it could be.
    tmpDir = fs.mkdtempSync(path.join(process.cwd(), '.test-tmp-'));
    process.env.FAVRO_API_TOKEN = 'test-token';
    (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
    // A filter settles its values against the org before it runs (#83), so the
    // client `createFavroClient` builds has to answer /tags, /widgets, /users.
    (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>)
      .mockImplementation(() => stubVocabularyClient());
  });

  afterEach(() => {
    said.mockRestore();
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}
    if (originalEnv === undefined) {
      delete process.env.FAVRO_API_TOKEN;
    } else {
      process.env.FAVRO_API_TOKEN = originalEnv;
    }
    jest.clearAllMocks();
  });

  /** The board fetch, as a spy, so a test can assert what reached the API. */
  function mockApi(cards: Card[]): jest.Mock {
    const listCards = jest.fn().mockResolvedValue(cards);
    (CardsAPI as jest.MockedClass<typeof CardsAPI>)
      .mockImplementation(() => ({ listCards } as any));
    return listCards;
  }

  const runExport = (...args: string[]): Promise<unknown> =>
    buildProgram().parseAsync(['node', 'favro', 'cards', 'export', ...args]);

  /** Run an argv expected to refuse, and return what it printed. */
  async function expectRefusal(...args: string[]): Promise<string> {
    const exit = jest.spyOn(process, 'exit')
      .mockImplementation(() => { throw new Error('process.exit'); });
    try {
      await expect(runExport(...args)).rejects.toThrow('process.exit');
      return printed();
    } finally {
      exit.mockRestore();
    }
  }

  test('exports cards to a CSV file', async () => {
    mockApi(sampleCards);
    const outFile = path.join(tmpDir, 'export.csv');

    await runExport(STUB_BOARD, '--format', 'csv', '--out', outFile);

    // Asserted as ROWS, not as substrings. `toContain('"id"')` and
    // `toContain('"card-001"')` are both satisfied by pretty-printed JSON, so
    // the CSV arm of this branch could be swapped for the JSON one with
    // nothing going red — the shape of the very defect #139 deletes.
    const [header, ...rows] = fs.readFileSync(outFile, 'utf-8').trim().split('\n');
    expect(header).toMatch(/^"id","title"/);
    expect(rows).toHaveLength(sampleCards.length);
    expect(rows[0]).toContain('"card-001"');
    expect(rows[0]).toContain('"Fix login bug"');
  });

  test('exports cards to a pretty-printed JSON file', async () => {
    mockApi(sampleCards);
    const outFile = path.join(tmpDir, 'export.json');

    await runExport(STUB_BOARD, '--format', 'json', '--out', outFile);

    const content = fs.readFileSync(outFile, 'utf-8');
    expect(content).toMatch(/\n  /);
    const parsed = JSON.parse(content);
    expect(parsed).toHaveLength(sampleCards.length);
    expect(parsed[0].id).toBe('card-001');
    expect(parsed[0].title).toBe('Fix login bug');
  });

  test('--filter narrows what reaches the file', async () => {
    mockApi(sampleCards);
    const outFile = path.join(tmpDir, 'filtered.json');

    await runExport(STUB_BOARD, '--format', 'json', '--filter', 'status:todo', '--out', outFile);

    const parsed = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].status).toBe('todo');
  });

  test('a --filter naming a column this board does not have refuses (#83)', async () => {
    // The whole of #83: this used to write an empty file and call it the export.
    const listCards = mockApi(sampleCards);
    const outFile = path.join(tmpDir, 'refused.json');

    const said = await expectRefusal(
      STUB_BOARD, '--format', 'json', '--filter', 'status:Shipped', '--out', outFile,
    );

    expect(fs.existsSync(outFile)).toBe(false);
    expect(said).toContain('Shipped');
    // Settled BEFORE the fetch. Paging a whole board only to throw it away is
    // the most expensive read this CLI makes, and `cards list` spends none of
    // it on the same refusal.
    expect(listCards).not.toHaveBeenCalled();
  });

  test('exits with an error for an unsupported --format', async () => {
    mockApi(sampleCards);
    const said = await expectRefusal(
      STUB_BOARD, '--format', 'xlsx', '--out', path.join(tmpDir, 'out.xlsx'),
    );
    expect(said).toContain('Invalid format');
  });

  test('an API failure is reported, not thrown at the user', async () => {
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => ({
      listCards: jest.fn().mockRejectedValue(new Error('Network error')),
    } as any));

    const said = await expectRefusal(
      STUB_BOARD, '--format', 'json', '--out', path.join(tmpDir, 'fail.json'),
    );
    expect(said).toContain('Network error');
  });

  test('exits with an error when no API key is configured', async () => {
    delete process.env.FAVRO_API_TOKEN;
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);
    mockApi(sampleCards);

    const said = await expectRefusal(
      STUB_BOARD, '--format', 'json', '--out', path.join(tmpDir, 'out.json'),
    );
    expect(said).toContain('API key');
  });

  // #44 replaced three `--limit` tests here. `cards export` no longer has the
  // flag at all: it fetched a cap and called the result "the export", which is
  // the same silent-partial-answer defect as `cards list --limit`.
  //
  // `ListCardsOptions` carries no `limit` any more, so a cap is unspellable and
  // the type is the real guard. What is left to bite is the CALL SHAPE: the
  // board string alone, once, with nothing narrowing the fetch on the wire —
  // `{ boardId, status }` and `{ boardId, archived }` are the same
  // silent-partial-answer wearing a different option.
  test('the export fetch is uncapped — the whole board, addressed by board alone', async () => {
    const listCards = mockApi(sampleCards);

    await runExport(STUB_BOARD, '--format', 'json', '--out', path.join(tmpDir, 'uncapped.json'));

    expect(listCards).toHaveBeenCalledTimes(1);
    expect(listCards).toHaveBeenCalledWith(STUB_BOARD);
  });

  // Fix #3: path traversal protection
  test('exits with an error when --out is outside cwd', async () => {
    mockApi(sampleCards);
    const said = await expectRefusal(
      STUB_BOARD, '--format', 'json', '--out', '/tmp/traversal-attack.json',
    );
    expect(said).toContain('Output path must be within current directory');
  });

});

// ----------------------------
// applyFilters — multi-filter AND logic
// ----------------------------

describe('applyFilters', () => {
  test('returns all cards when filters array is empty', async () => {
    const result = await applyFilters(sampleCards, [], ctx());
    expect(result).toHaveLength(sampleCards.length);
  });

  test('applies a single filter correctly', async () => {
    const result = await applyFilters(sampleCards, ['status:done'], ctx());
    expect(result).toHaveLength(1);
    expect(result[0].cardId).toBe('card-003');
  });

  test('applies two filters with AND logic (assignee AND status)', async () => {
    // alice@example.com has cards card-001 (in-progress) and card-003 (done)
    const result = await applyFilters(sampleCards, ['assignee~alice', 'status:done'], ctx());
    expect(result).toHaveLength(1);
    expect(result[0].cardId).toBe('card-003');
    expect(result[0].assignees).toContain('alice@example.com');
    expect(result[0].status).toBe('done');
  });

  test('returns empty array when filters eliminate all cards (AND logic)', async () => {
    // alice doesn't have any todo cards
    const result = await applyFilters(sampleCards, ['assignee~alice', 'status:todo'], ctx());
    expect(result).toHaveLength(0);
  });

  test('applies three filters with AND logic', async () => {
    const result = await applyFilters(sampleCards, ['assignee~alice', 'status:in-progress', 'tag:bug'], ctx());
    expect(result).toHaveLength(1);
    expect(result[0].cardId).toBe('card-001');
  });

  test('each filter is applied in sequence (reducer behavior)', async () => {
    // Start with 3 cards
    // assignee~alice → 2 cards (card-001, card-003)
    // tag:release → 1 card (card-003)
    const result = await applyFilters(sampleCards, ['assignee~alice', 'tag:release'], ctx());
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
