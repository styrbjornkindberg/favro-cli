/**
 * Unit tests — StandupAPI
 * CLA-1799 / FAVRO-037: Standup & Sprint Commands
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isCompleted,
  isInProgress,
  isBlocked,
  isDueSoon,
  classifyCard,
  StandupAPI,
} from '../../../src/api/standup';
import type { ContextCard } from '../../../src/api/context';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeCard(overrides: Partial<ContextCard> = {}): ContextCard {
  return {
    id: 'card-1',
    title: 'Test Card',
    status: 'In Progress',
    assignees: [],
    tags: [],
    blockedBy: [],
    blocking: [],
    customFields: {},
    ...overrides,
  };
}

// ─── isCompleted ──────────────────────────────────────────────────────────────

describe('isCompleted', () => {
  it('returns true for "Done" status', () => {
    expect(isCompleted(makeCard({ status: 'Done' }))).toBe(true);
  });

  it('returns true for "done" (case-insensitive)', () => {
    expect(isCompleted(makeCard({ status: 'done' }))).toBe(true);
  });

  it('returns true for "Completed"', () => {
    expect(isCompleted(makeCard({ status: 'Completed' }))).toBe(true);
  });

  it('returns true for "Closed"', () => {
    expect(isCompleted(makeCard({ status: 'Closed' }))).toBe(true);
  });

  it('returns true for "Released"', () => {
    expect(isCompleted(makeCard({ status: 'Released' }))).toBe(true);
  });

  it('returns false for "In Progress"', () => {
    expect(isCompleted(makeCard({ status: 'In Progress' }))).toBe(false);
  });

  it('returns false for "Backlog"', () => {
    expect(isCompleted(makeCard({ status: 'Backlog' }))).toBe(false);
  });

  it('returns false for undefined status', () => {
    expect(isCompleted(makeCard({ status: undefined }))).toBe(false);
  });
});

// ─── isInProgress ─────────────────────────────────────────────────────────────

describe('isInProgress', () => {
  it('returns true for "In Progress"', () => {
    expect(isInProgress(makeCard({ status: 'In Progress' }))).toBe(true);
  });

  it('returns true for "in progress" (case-insensitive)', () => {
    expect(isInProgress(makeCard({ status: 'in progress' }))).toBe(true);
  });

  it('returns true for "In Review"', () => {
    expect(isInProgress(makeCard({ status: 'In Review' }))).toBe(true);
  });

  it('returns true for "Review"', () => {
    expect(isInProgress(makeCard({ status: 'Review' }))).toBe(true);
  });

  it('returns true for "Doing"', () => {
    expect(isInProgress(makeCard({ status: 'Doing' }))).toBe(true);
  });

  it('returns false for "Backlog"', () => {
    expect(isInProgress(makeCard({ status: 'Backlog' }))).toBe(false);
  });

  it('returns false for "Done"', () => {
    expect(isInProgress(makeCard({ status: 'Done' }))).toBe(false);
  });
});

// ─── isBlocked ────────────────────────────────────────────────────────────────

describe('isBlocked', () => {
  it('returns true when blockedBy has entries', () => {
    expect(isBlocked(makeCard({ blockedBy: ['card-99'] }))).toBe(true);
  });

  it('returns true for "Blocked" status', () => {
    expect(isBlocked(makeCard({ status: 'Blocked', blockedBy: [] }))).toBe(true);
  });

  it('returns true for "On Hold" status', () => {
    expect(isBlocked(makeCard({ status: 'On Hold', blockedBy: [] }))).toBe(true);
  });

  it('returns false when no blockers', () => {
    expect(isBlocked(makeCard({ blockedBy: [], status: 'In Progress' }))).toBe(false);
  });

  it('returns false for empty blockedBy', () => {
    expect(isBlocked(makeCard({ blockedBy: [] }))).toBe(false);
  });
});

// ─── isDueSoon ────────────────────────────────────────────────────────────────

describe('isDueSoon', () => {
  it('returns true for card due tomorrow', () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(isDueSoon(makeCard({ due: tomorrow.toISOString() }))).toBe(true);
  });

  it('returns true for overdue card', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(isDueSoon(makeCard({ due: yesterday.toISOString() }))).toBe(true);
  });

  it('returns false for card due in 7 days (default 3 day window)', () => {
    const future = new Date();
    future.setDate(future.getDate() + 7);
    expect(isDueSoon(makeCard({ due: future.toISOString() }))).toBe(false);
  });

  it('returns false for card with no due date', () => {
    expect(isDueSoon(makeCard({ due: undefined }))).toBe(false);
  });

  it('returns false for invalid due date', () => {
    expect(isDueSoon(makeCard({ due: 'not-a-date' }))).toBe(false);
  });

  it('respects custom withinDays parameter', () => {
    const inFiveDays = new Date();
    inFiveDays.setDate(inFiveDays.getDate() + 5);
    expect(isDueSoon(makeCard({ due: inFiveDays.toISOString() }), 7)).toBe(true);
    expect(isDueSoon(makeCard({ due: inFiveDays.toISOString() }), 3)).toBe(false);
  });
});

// ─── classifyCard ─────────────────────────────────────────────────────────────

describe('classifyCard', () => {
  it('classifies "Done" card as completed', () => {
    const card = classifyCard(makeCard({ status: 'Done', blockedBy: [] }));
    expect(card?.group).toBe('completed');
  });

  it('classifies "In Progress" card as in-progress', () => {
    const card = classifyCard(makeCard({ status: 'In Progress', blockedBy: [] }));
    expect(card?.group).toBe('in-progress');
  });

  it('classifies blocked card as blocked (overrides in-progress)', () => {
    const card = classifyCard(makeCard({ status: 'In Progress', blockedBy: ['card-99'] }));
    expect(card?.group).toBe('blocked');
  });

  it('classifies due-soon card as due-soon', () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const card = classifyCard(makeCard({ status: 'To Do', due: tomorrow.toISOString(), blockedBy: [] }));
    expect(card?.group).toBe('due-soon');
  });

  it('returns null for Backlog card with no due date', () => {
    const card = classifyCard(makeCard({ status: 'Backlog', blockedBy: [] }));
    expect(card).toBeNull();
  });

  it('includes card id and title', () => {
    const card = classifyCard(makeCard({ id: 'c1', title: 'Fix bug', status: 'Done', blockedBy: [] }));
    expect(card?.id).toBe('c1');
    expect(card?.title).toBe('Fix bug');
  });
});

// ─── StandupAPI ───────────────────────────────────────────────────────────────

const mockGetSnapshot = vi.fn();

vi.mock('../../../src/api/context', () => ({
  default: function MockContextAPI() {
    return { getSnapshot: mockGetSnapshot };
  },
}));

vi.mock('../../../src/lib/http-client', () => ({
  default: function MockFavroHttpClient() {
    return {};
  },
}));

import FavroHttpClient from '../../../src/lib/http-client';

const SAMPLE_SNAPSHOT = {
  board: { id: 'b-1', name: 'Sprint 42', members: [] },
  columns: [],
  customFields: [],
  members: [],
  cards: [
    { id: 'c1', title: 'Completed Task', status: 'Done', assignees: [], tags: [], blockedBy: [], blocking: [] },
    { id: 'c2', title: 'In Progress Task', status: 'In Progress', assignees: ['alice'], tags: [], blockedBy: [], blocking: [] },
    { id: 'c3', title: 'Blocked Task', status: 'In Progress', assignees: [], tags: [], blockedBy: ['c99'], blocking: [] },
    { id: 'c4', title: 'Backlog Task', status: 'Backlog', assignees: [], tags: [], blockedBy: [], blocking: [] },
  ],
  stats: { total: 4, by_status: {}, by_owner: {} },
  generatedAt: '2026-01-01T00:00:00.000Z',
};

describe('StandupAPI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSnapshot.mockResolvedValue(SAMPLE_SNAPSHOT);
  });

  it('returns standup with completed cards', async () => {
    const client = new FavroHttpClient({} as any);
    const api = new StandupAPI(client);
    const result = await api.getStandup('Sprint 42');

    expect(result.completed).toHaveLength(1);
    expect(result.completed[0].id).toBe('c1');
  });

  it('returns standup with in-progress cards', async () => {
    const client = new FavroHttpClient({} as any);
    const api = new StandupAPI(client);
    const result = await api.getStandup('Sprint 42');

    // c2 is in-progress; c3 is blocked
    expect(result.inProgress).toHaveLength(1);
    expect(result.inProgress[0].id).toBe('c2');
  });

  it('returns standup with blocked cards', async () => {
    const client = new FavroHttpClient({} as any);
    const api = new StandupAPI(client);
    const result = await api.getStandup('Sprint 42');

    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].id).toBe('c3');
  });

  it('excludes backlog cards from standup groups', async () => {
    const client = new FavroHttpClient({} as any);
    const api = new StandupAPI(client);
    const result = await api.getStandup('Sprint 42');

    const allGrouped = [...result.completed, ...result.inProgress, ...result.blocked, ...result.dueSoon];
    expect(allGrouped.find(c => c.id === 'c4')).toBeUndefined();
  });

  it('includes board name and total in result', async () => {
    const client = new FavroHttpClient({} as any);
    const api = new StandupAPI(client);
    const result = await api.getStandup('Sprint 42');

    expect(result.board.name).toBe('Sprint 42');
    expect(result.total).toBe(4);
  });

  it('passes cardLimit to getSnapshot', async () => {
    const client = new FavroHttpClient({} as any);
    const api = new StandupAPI(client);
    await api.getStandup('Sprint 42', 200);

    expect(mockGetSnapshot).toHaveBeenCalledWith('Sprint 42', 200);
  });

  it('includes due-soon cards', async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    const snapshotWithDue = {
      ...SAMPLE_SNAPSHOT,
      cards: [
        ...SAMPLE_SNAPSHOT.cards,
        { id: 'c5', title: 'Due Soon Task', status: 'Todo', assignees: [], tags: [], blockedBy: [], blocking: [], due: tomorrow.toISOString() },
      ],
    };
    mockGetSnapshot.mockResolvedValue(snapshotWithDue);

    const client = new FavroHttpClient({} as any);
    const api = new StandupAPI(client);
    const result = await api.getStandup('Sprint 42');

    expect(result.dueSoon).toHaveLength(1);
    expect(result.dueSoon[0].id).toBe('c5');
  });
});
