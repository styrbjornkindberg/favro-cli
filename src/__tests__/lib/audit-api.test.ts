/**
 * Unit tests — AuditAPI and audit-api utilities
 * CLA-1802: FAVRO-040: Audit & Change Log Commands
 */
import { parseSince, formatTimestamp, formatRelative, AuditAPI } from '../../lib/audit-api';
import FavroHttpClient from '../../lib/http-client';
import CardsAPI, { Card } from '../../lib/cards-api';

jest.mock('../../lib/http-client');
jest.mock('../../lib/cards-api');

const MockCardsAPI = CardsAPI as jest.MockedClass<typeof CardsAPI>;

// ─── parseSince ──────────────────────────────────────────────────────────────
describe('parseSince', () => {
  it('returns undefined for undefined input', () => {
    expect(parseSince(undefined)).toBeUndefined();
  });

  it('parses "1h" as 1 hour ago', () => {
    const before = Date.now();
    const result = parseSince('1h');
    const after = Date.now();
    const expected = 60 * 60 * 1000;
    expect(result).toBeInstanceOf(Date);
    expect(before - result!.getTime()).toBeGreaterThanOrEqual(expected - 50);
    expect(after - result!.getTime()).toBeLessThanOrEqual(expected + 50);
  });

  it('parses "1d" as 1 day ago', () => {
    const before = Date.now();
    const result = parseSince('1d');
    const after = Date.now();
    const expected = 24 * 60 * 60 * 1000;
    expect(result).toBeInstanceOf(Date);
    expect(before - result!.getTime()).toBeGreaterThanOrEqual(expected - 50);
    expect(after - result!.getTime()).toBeLessThanOrEqual(expected + 50);
  });

  it('parses "1w" as 7 days ago', () => {
    const before = Date.now();
    const result = parseSince('1w');
    const after = Date.now();
    const expected = 7 * 24 * 60 * 60 * 1000;
    expect(result).toBeInstanceOf(Date);
    expect(before - result!.getTime()).toBeGreaterThanOrEqual(expected - 50);
    expect(after - result!.getTime()).toBeLessThanOrEqual(expected + 50);
  });

  it('parses "2h" as 2 hours ago', () => {
    const before = Date.now();
    const result = parseSince('2h');
    const after = Date.now();
    const expected = 2 * 60 * 60 * 1000;
    expect(before - result!.getTime()).toBeGreaterThanOrEqual(expected - 50);
    expect(after - result!.getTime()).toBeLessThanOrEqual(expected + 50);
  });

  it('parses "3d" as 3 days ago', () => {
    const before = Date.now();
    const result = parseSince('3d');
    const after = Date.now();
    const expected = 3 * 24 * 60 * 60 * 1000;
    expect(before - result!.getTime()).toBeGreaterThanOrEqual(expected - 50);
    expect(after - result!.getTime()).toBeLessThanOrEqual(expected + 50);
  });

  it('throws for invalid format "bad"', () => {
    expect(() => parseSince('bad')).toThrow('Invalid --since value');
  });

  it('throws for "1x" (unknown unit)', () => {
    expect(() => parseSince('1x')).toThrow('Invalid --since value');
  });

  it('throws for empty string', () => {
    expect(() => parseSince('')).toThrow('Invalid --since value');
  });
});

// ─── formatRelative ──────────────────────────────────────────────────────────
describe('formatRelative', () => {
  it('returns "just now" for < 1 minute', () => {
    expect(formatRelative(30_000)).toBe('just now');
    expect(formatRelative(0)).toBe('just now');
  });

  it('returns "1 minute ago" for 1 minute', () => {
    expect(formatRelative(60_000)).toBe('1 minute ago');
  });

  it('returns "5 minutes ago" for 5 minutes', () => {
    expect(formatRelative(5 * 60_000)).toBe('5 minutes ago');
  });

  it('returns "1 hour ago" for 1 hour', () => {
    expect(formatRelative(60 * 60_000)).toBe('1 hour ago');
  });

  it('returns "2 hours ago" for 2 hours', () => {
    expect(formatRelative(2 * 60 * 60_000)).toBe('2 hours ago');
  });

  it('returns "1 day ago" for 24 hours', () => {
    expect(formatRelative(24 * 60 * 60_000)).toBe('1 day ago');
  });

  it('returns "3 days ago" for 3 days', () => {
    expect(formatRelative(3 * 24 * 60 * 60_000)).toBe('3 days ago');
  });

  it('returns "1 week ago" for 7 days', () => {
    expect(formatRelative(7 * 24 * 60 * 60_000)).toBe('1 week ago');
  });

  it('returns "2 weeks ago" for 14 days', () => {
    expect(formatRelative(14 * 24 * 60 * 60_000)).toBe('2 weeks ago');
  });

  it('returns "1 year ago" for 365 days', () => {
    expect(formatRelative(365 * 24 * 60 * 60_000)).toBe('1 year ago');
  });

  it('returns "in 2 hours" for negative diff (future)', () => {
    expect(formatRelative(-2 * 60 * 60_000)).toBe('in 2 hours');
  });
});

// ─── formatTimestamp ──────────────────────────────────────────────────────────
describe('formatTimestamp', () => {
  it('returns relative + absolute ISO format', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const result = formatTimestamp(twoHoursAgo);
    expect(result).toContain('2 hours ago');
    expect(result).toContain(twoHoursAgo);
    expect(result).toMatch(/^.+ \(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('handles "just now" for very recent timestamps', () => {
    const now = new Date().toISOString();
    const result = formatTimestamp(now);
    expect(result).toContain('just now');
  });

  it('returns original string for invalid date', () => {
    expect(formatTimestamp('not-a-date')).toBe('not-a-date');
  });
});

// ─── AuditAPI.getBoardAuditLog ───────────────────────────────────────────────
describe('AuditAPI.getBoardAuditLog', () => {
  const makeCards = (count: number): Card[] =>
    Array.from({ length: count }, (_, i) => ({
      cardId: `card-${i}`,
      name: `Card ${i}`,
      status: 'In Progress',
      createdAt: new Date(Date.now() - (i + 1) * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - i * 60 * 60 * 1000).toISOString(),
    }));

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns audit entries derived from cards when no activity endpoint', async () => {
    MockCardsAPI.prototype.listCards = jest.fn().mockResolvedValue(makeCards(3));
    const mockClient = new FavroHttpClient({});
    // Simulate activity endpoint returning nothing
    (mockClient as any).get = jest.fn().mockRejectedValue(new Error('404'));

    const api = new AuditAPI(mockClient);
    const entries = await api.getBoardAuditLog('board-123');
    // Fallback creates 2 entries per card (created + updated) when they differ
    expect(entries.length).toBeGreaterThan(0);
  });

  it('filters entries by since date', async () => {
    const cards = makeCards(5);
    // Only cards 0–1 have updatedAt within the last 30 min
    const now = Date.now();
    cards[0].updatedAt = new Date(now - 10 * 60 * 1000).toISOString();  // 10 min ago
    cards[1].updatedAt = new Date(now - 20 * 60 * 1000).toISOString();  // 20 min ago
    cards[2].updatedAt = new Date(now - 2 * 60 * 60 * 1000).toISOString(); // 2h ago (filtered)
    cards[3].updatedAt = new Date(now - 5 * 60 * 60 * 1000).toISOString(); // 5h ago (filtered)
    cards[4].updatedAt = new Date(now - 10 * 60 * 60 * 1000).toISOString(); // 10h ago (filtered)

    MockCardsAPI.prototype.listCards = jest.fn().mockResolvedValue(cards);
    const mockClient = new FavroHttpClient({});
    (mockClient as any).get = jest.fn().mockRejectedValue(new Error('404'));

    const api = new AuditAPI(mockClient);
    const since = new Date(now - 30 * 60 * 1000); // 30 min ago
    const entries = await api.getBoardAuditLog('board-123', since);

    // Only entries from cards 0 and 1 should be present
    const cardIds = new Set(entries.map(e => e.cardId));
    expect(cardIds.has('card-0')).toBe(true);
    expect(cardIds.has('card-1')).toBe(true);
    expect(cardIds.has('card-2')).toBe(false);
    expect(cardIds.has('card-3')).toBe(false);
    expect(cardIds.has('card-4')).toBe(false);
  });

  it('sorts entries newest-first', async () => {
    const cards = makeCards(3);
    MockCardsAPI.prototype.listCards = jest.fn().mockResolvedValue(cards);
    const mockClient = new FavroHttpClient({});
    (mockClient as any).get = jest.fn().mockRejectedValue(new Error('404'));

    const api = new AuditAPI(mockClient);
    const entries = await api.getBoardAuditLog('board-123');

    for (let i = 0; i < entries.length - 1; i++) {
      expect(new Date(entries[i].timestamp).getTime()).toBeGreaterThanOrEqual(
        new Date(entries[i + 1].timestamp).getTime()
      );
    }
  });

  it('respects limit parameter', async () => {
    MockCardsAPI.prototype.listCards = jest.fn().mockResolvedValue(makeCards(20));
    const mockClient = new FavroHttpClient({});
    (mockClient as any).get = jest.fn().mockRejectedValue(new Error('404'));

    const api = new AuditAPI(mockClient);
    const entries = await api.getBoardAuditLog('board-123', undefined, 5);
    expect(entries.length).toBeLessThanOrEqual(5);
  });

  it('uses activity entries when activity endpoint returns data', async () => {
    const cards = makeCards(1);
    MockCardsAPI.prototype.listCards = jest.fn().mockResolvedValue(cards);
    const mockClient = new FavroHttpClient({});
    (mockClient as any).get = jest.fn().mockResolvedValue({
      entities: [
        {
          activityId: 'act-1',
          cardId: 'card-0',
          type: 'comment',
          description: 'User added a comment',
          author: 'alice',
          createdAt: new Date().toISOString(),
        },
      ],
    });

    const api = new AuditAPI(mockClient);
    const entries = await api.getBoardAuditLog('board-123');
    expect(entries.some(e => e.changeType === 'comment')).toBe(true);
    expect(entries.some(e => e.author === 'alice')).toBe(true);
  });
});

// ─── AuditAPI.getCardHistory ──────────────────────────────────────────────────
describe('AuditAPI.getCardHistory', () => {
  const sampleCards: Card[] = [
    {
      cardId: 'card-login',
      name: 'Fix login bug',
      status: 'Done',
      createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    },
    {
      cardId: 'card-other',
      name: 'Other task',
      status: 'To Do',
      createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('filters cards by title substring (case-insensitive)', async () => {
    MockCardsAPI.prototype.listCards = jest.fn().mockResolvedValue(sampleCards);
    const mockClient = new FavroHttpClient({});
    (mockClient as any).get = jest.fn().mockRejectedValue(new Error('404'));

    const api = new AuditAPI(mockClient);
    const results = await api.getCardHistory('login');
    expect(results).toHaveLength(1);
    expect(results[0].card.cardId).toBe('card-login');
  });

  it('returns empty array when no cards match', async () => {
    MockCardsAPI.prototype.listCards = jest.fn().mockResolvedValue(sampleCards);
    const mockClient = new FavroHttpClient({});
    (mockClient as any).get = jest.fn().mockRejectedValue(new Error('404'));

    const api = new AuditAPI(mockClient);
    const results = await api.getCardHistory('nonexistent-xyz-123');
    expect(results).toHaveLength(0);
  });

  it('matches multiple cards when title is ambiguous', async () => {
    MockCardsAPI.prototype.listCards = jest.fn().mockResolvedValue([
      { ...sampleCards[0], name: 'Fix login bug - frontend' },
      { ...sampleCards[1], name: 'Fix login bug - backend', cardId: 'card-login-2' },
    ]);
    const mockClient = new FavroHttpClient({});
    (mockClient as any).get = jest.fn().mockRejectedValue(new Error('404'));

    const api = new AuditAPI(mockClient);
    const results = await api.getCardHistory('Fix login bug');
    expect(results).toHaveLength(2);
  });

  it('includes fallback entries (created + updated) from card metadata', async () => {
    MockCardsAPI.prototype.listCards = jest.fn().mockResolvedValue([sampleCards[0]]);
    const mockClient = new FavroHttpClient({});
    (mockClient as any).get = jest.fn().mockRejectedValue(new Error('404'));

    const api = new AuditAPI(mockClient);
    const results = await api.getCardHistory('login');
    expect(results[0].entries.length).toBeGreaterThanOrEqual(1);
    expect(results[0].entries.some(e => e.changeType === 'created' || e.changeType === 'updated')).toBe(true);
  });
});
