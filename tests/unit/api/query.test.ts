/**
 * Semantic Query API — Unit Tests
 * CLA-1798 / FAVRO-036: Semantic Query Command
 *
 * 50+ tests covering:
 *  - parseQueryFilter: all supported query patterns
 *  - matchCard: all filter fields
 *  - explainNoResults: various no-result scenarios
 *  - buildSummary: output formatting
 *  - QueryAPI.execute: integration with mocked ContextAPI
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseQueryFilter,
  matchCard,
  explainNoResults,
  buildSummary,
  QueryAPI,
} from '../../../src/api/query';
import type { BoardContextSnapshot, ContextCard } from '../../../src/api/context';
import type { QueryFilter, QueryMatch } from '../../../src/types/query';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeCard(overrides: Partial<ContextCard> = {}): ContextCard {
  return {
    id: 'card-1',
    title: 'Test Card',
    status: 'In Progress',
    assignees: ['alice@example.com'],
    tags: ['bug', 'frontend'],
    blockedBy: [],
    blocking: [],
    customFields: { priority: 'high' },
    due: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeContext(cards: ContextCard[] = []): BoardContextSnapshot {
  return {
    board: { id: 'b-1', name: 'Sprint 42', members: [], description: '' },
    columns: [],
    customFields: [],
    members: [
      { id: 'm-1', name: 'Alice Smith', email: 'alice@example.com', role: 'member' },
      { id: 'm-2', name: 'Bob Jones', email: 'bob@example.com', role: 'member' },
    ],
    cards,
    stats: { total: cards.length, by_status: {}, by_owner: {} },
    generatedAt: new Date().toISOString(),
  };
}

// ─── parseQueryFilter Tests ───────────────────────────────────────────────────

describe('parseQueryFilter', () => {
  it('parses status:done', () => {
    const f = parseQueryFilter('status:done');
    expect(f.status).toBe('done');
  });

  it('parses status:In Progress with spaces', () => {
    const f = parseQueryFilter('status:In Progress');
    expect(f.status).toBe('In Progress');
  });

  it('parses assigned:@alice', () => {
    const f = parseQueryFilter('assigned:@alice');
    expect(f.owner).toBe('alice');
  });

  it('parses assigned:alice without @', () => {
    const f = parseQueryFilter('assigned:alice');
    expect(f.owner).toBe('alice');
  });

  it('parses owner:bob', () => {
    const f = parseQueryFilter('owner:bob');
    expect(f.owner).toBe('bob');
  });

  it('parses assignee:charlie', () => {
    const f = parseQueryFilter('assignee:charlie');
    expect(f.owner).toBe('charlie');
  });

  it('parses priority:high', () => {
    const f = parseQueryFilter('priority:high');
    expect(f.priority).toBe('high');
  });

  it('parses priority:low', () => {
    const f = parseQueryFilter('priority:low');
    expect(f.priority).toBe('low');
  });

  it('parses label:bug', () => {
    const f = parseQueryFilter('label:bug');
    expect(f.label).toBe('bug');
  });

  it('parses tag:frontend', () => {
    const f = parseQueryFilter('tag:frontend');
    expect(f.label).toBe('frontend');
  });

  it('parses blocked shorthand', () => {
    const f = parseQueryFilter('blocked');
    expect(f.blocked).toBe(true);
  });

  it('parses blocked cards', () => {
    const f = parseQueryFilter('blocked cards');
    expect(f.blocked).toBe(true);
  });

  it('parses blocking shorthand', () => {
    const f = parseQueryFilter('blocking');
    expect(f.blocking).toBe(true);
  });

  it('parses overdue shorthand', () => {
    const f = parseQueryFilter('overdue');
    expect(f.due).toBe('overdue');
  });

  it('parses due:overdue', () => {
    const f = parseQueryFilter('due:overdue');
    expect(f.due).toBe('overdue');
  });

  it('parses relates:card-x', () => {
    const f = parseQueryFilter('relates:card-x');
    expect(f.relatesTo).toBe('card-x');
  });

  it('parses relates to card-x (natural language)', () => {
    const f = parseQueryFilter('relates to card-x');
    expect(f.relatesTo).toBe('card-x');
  });

  it('parses "assigned to @alice" natural language', () => {
    const f = parseQueryFilter('assigned to @alice');
    expect(f.owner).toBe('alice');
  });

  it('parses "with status In Progress"', () => {
    const f = parseQueryFilter('with status In Progress');
    expect(f.status).toBe('In Progress');
  });

  it('parses "in status done"', () => {
    const f = parseQueryFilter('in status done');
    expect(f.status).toBe('done');
  });

  it('parses "high priority"', () => {
    const f = parseQueryFilter('high priority');
    expect(f.priority).toBe('high');
  });

  it('parses "critical priority"', () => {
    const f = parseQueryFilter('critical priority');
    expect(f.priority).toBe('critical');
  });

  it('parses "done" naked status', () => {
    const f = parseQueryFilter('done');
    expect(f.status).toBe('done');
  });

  it('parses compound: status:done assigned:@alice', () => {
    const f = parseQueryFilter('status:done assigned:@alice');
    expect(f.status).toBe('done');
    expect(f.owner).toBe('alice');
  });

  it('sets rawQuery on all filters', () => {
    const query = 'status:done';
    const f = parseQueryFilter(query);
    expect(f.rawQuery).toBe(query);
  });

  it('returns text filter for free-form query', () => {
    const f = parseQueryFilter('authentication refactor');
    expect(f.text).toBe('authentication refactor');
  });

  it('does not set text for very short remaining', () => {
    const f = parseQueryFilter('status:done a');
    expect(f.text).toBeUndefined();
  });

  it('parses due:2025-01-15', () => {
    const f = parseQueryFilter('due:2025-01-15');
    expect(f.due).toBe('2025-01-15');
  });
});

// ─── matchCard Tests ──────────────────────────────────────────────────────────

describe('matchCard', () => {
  const ctx = makeContext();

  it('matches card with correct status', () => {
    const card = makeCard({ status: 'done' });
    const result = matchCard(card, { status: 'done' }, ctx);
    expect(result).not.toBeNull();
    expect(result).toContain('done');
  });

  it('rejects card with wrong status', () => {
    const card = makeCard({ status: 'todo' });
    const result = matchCard(card, { status: 'done' }, ctx);
    expect(result).toBeNull();
  });

  it('matches status case-insensitively', () => {
    const card = makeCard({ status: 'In Progress' });
    const result = matchCard(card, { status: 'in progress' }, ctx);
    expect(result).not.toBeNull();
  });

  it('matches card with correct owner', () => {
    const card = makeCard({ assignees: ['alice@example.com'] });
    const result = matchCard(card, { owner: 'alice' }, ctx);
    expect(result).not.toBeNull();
  });

  it('rejects card not assigned to owner', () => {
    const card = makeCard({ assignees: ['bob@example.com'] });
    const result = matchCard(card, { owner: 'alice' }, ctx);
    expect(result).toBeNull();
  });

  it('matches @me to any assigned card', () => {
    const card = makeCard({ assignees: ['anyone@example.com'] });
    const result = matchCard(card, { owner: 'me' }, ctx);
    expect(result).not.toBeNull();
  });

  it('rejects @me for unassigned card', () => {
    const card = makeCard({ assignees: [] });
    const result = matchCard(card, { owner: 'me' }, ctx);
    expect(result).toBeNull();
  });

  it('matches card with correct label', () => {
    const card = makeCard({ tags: ['bug', 'frontend'] });
    const result = matchCard(card, { label: 'bug' }, ctx);
    expect(result).not.toBeNull();
  });

  it('rejects card without the label', () => {
    const card = makeCard({ tags: ['backend'] });
    const result = matchCard(card, { label: 'frontend' }, ctx);
    expect(result).toBeNull();
  });

  it('matches blocked cards', () => {
    const card = makeCard({ blockedBy: ['card-2'] });
    const result = matchCard(card, { blocked: true }, ctx);
    expect(result).not.toBeNull();
    expect(result).toContain('blocked by');
  });

  it('rejects non-blocked cards when blocked filter set', () => {
    const card = makeCard({ blockedBy: [] });
    const result = matchCard(card, { blocked: true }, ctx);
    expect(result).toBeNull();
  });

  it('matches blocking cards', () => {
    const card = makeCard({ blocking: ['card-3'] });
    const result = matchCard(card, { blocking: true }, ctx);
    expect(result).not.toBeNull();
    expect(result).toContain('blocking');
  });

  it('rejects non-blocking cards when blocking filter set', () => {
    const card = makeCard({ blocking: [] });
    const result = matchCard(card, { blocking: true }, ctx);
    expect(result).toBeNull();
  });

  it('matches card related to specified card', () => {
    const card = makeCard({ blockedBy: ['feature-x'] });
    const result = matchCard(card, { relatesTo: 'feature-x' }, ctx);
    expect(result).not.toBeNull();
  });

  it('matches blocking side for relatesTo', () => {
    const card = makeCard({ blocking: ['feature-x'] });
    const result = matchCard(card, { relatesTo: 'feature-x' }, ctx);
    expect(result).not.toBeNull();
  });

  it('rejects card with no relation to specified card', () => {
    const card = makeCard({ blockedBy: [], blocking: [] });
    const result = matchCard(card, { relatesTo: 'feature-x' }, ctx);
    expect(result).toBeNull();
  });

  it('matches card with correct priority custom field', () => {
    const card = makeCard({ customFields: { priority: 'high' } });
    const result = matchCard(card, { priority: 'high' }, ctx);
    expect(result).not.toBeNull();
    expect(result).toContain('priority');
  });

  it('rejects card with wrong priority', () => {
    const card = makeCard({ customFields: { priority: 'low' } });
    const result = matchCard(card, { priority: 'high' }, ctx);
    expect(result).toBeNull();
  });

  it('rejects card with no priority field', () => {
    const card = makeCard({ customFields: {} });
    const result = matchCard(card, { priority: 'high' }, ctx);
    expect(result).toBeNull();
  });

  it('matches overdue card', () => {
    const card = makeCard({ due: '2020-01-01T00:00:00Z' });
    const result = matchCard(card, { due: 'overdue' }, ctx);
    expect(result).not.toBeNull();
    expect(result).toContain('overdue');
  });

  it('rejects future card for overdue filter', () => {
    const card = makeCard({ due: '2099-01-01T00:00:00Z' });
    const result = matchCard(card, { due: 'overdue' }, ctx);
    expect(result).toBeNull();
  });

  it('rejects card with no due date for overdue filter', () => {
    const card = makeCard({ due: undefined });
    const result = matchCard(card, { due: 'overdue' }, ctx);
    expect(result).toBeNull();
  });

  it('matches free-text in title', () => {
    const card = makeCard({ title: 'Fix authentication bug' });
    const result = matchCard(card, { text: 'authentication' }, ctx);
    expect(result).not.toBeNull();
  });

  it('matches free-text in tags', () => {
    const card = makeCard({ tags: ['authentication', 'security'] });
    const result = matchCard(card, { text: 'authentication' }, ctx);
    expect(result).not.toBeNull();
  });

  it('rejects card not matching free text', () => {
    const card = makeCard({ title: 'Unrelated card', tags: [] });
    const result = matchCard(card, { text: 'authentication' }, ctx);
    expect(result).toBeNull();
  });

  it('matches all cards with empty filter', () => {
    const card = makeCard();
    const result = matchCard(card, {}, ctx);
    expect(result).not.toBeNull();
  });

  it('matches compound filter: status + owner', () => {
    const card = makeCard({ status: 'done', assignees: ['alice@example.com'] });
    const result = matchCard(card, { status: 'done', owner: 'alice' }, ctx);
    expect(result).not.toBeNull();
  });

  it('rejects on compound filter if one condition fails', () => {
    const card = makeCard({ status: 'todo', assignees: ['alice@example.com'] });
    const result = matchCard(card, { status: 'done', owner: 'alice' }, ctx);
    expect(result).toBeNull();
  });

  it('matches compound: blocked + label', () => {
    const card = makeCard({ blockedBy: ['card-2'], tags: ['critical'] });
    const result = matchCard(card, { blocked: true, label: 'critical' }, ctx);
    expect(result).not.toBeNull();
  });

  it('matches Priority with capital P', () => {
    const card = makeCard({ customFields: { Priority: 'urgent' } });
    const result = matchCard(card, { priority: 'urgent' }, ctx);
    expect(result).not.toBeNull();
  });

  it('matches Urgency custom field as priority', () => {
    const card = makeCard({ customFields: { urgency: 'high' } });
    const result = matchCard(card, { priority: 'high' }, ctx);
    expect(result).not.toBeNull();
  });
});

// ─── explainNoResults Tests ───────────────────────────────────────────────────

describe('explainNoResults', () => {
  it('explains empty board', () => {
    const ctx = makeContext([]);
    const explanation = explainNoResults({ rawQuery: 'status:done' }, ctx);
    expect(explanation).toContain('no cards');
  });

  it('explains missing status', () => {
    const cards = [makeCard({ status: 'todo' }), makeCard({ status: 'in-progress' })];
    const ctx = makeContext(cards);
    const explanation = explainNoResults({ status: 'done', rawQuery: 'status:done' }, ctx);
    expect(explanation).toContain('done');
    expect(explanation).toContain('Available statuses');
  });

  it('explains unassigned owner', () => {
    const cards = [makeCard({ assignees: ['bob@example.com'] })];
    const ctx = makeContext(cards);
    const explanation = explainNoResults({ owner: 'alice' }, ctx);
    expect(explanation).toContain('alice');
  });

  it('explains no blocked cards', () => {
    const ctx = makeContext([makeCard({ blockedBy: [] })]);
    const explanation = explainNoResults({ blocked: true }, ctx);
    expect(explanation).toContain('blocked');
  });

  it('explains no blocking cards', () => {
    const ctx = makeContext([makeCard({ blocking: [] })]);
    const explanation = explainNoResults({ blocking: true }, ctx);
    expect(explanation).toContain('blocking');
  });

  it('explains missing priority field', () => {
    const ctx = makeContext([makeCard({ customFields: {} })]);
    const explanation = explainNoResults({ priority: 'high' }, ctx);
    expect(explanation).toContain('high');
    expect(explanation).toContain('Priority');
  });

  it('explains missing label', () => {
    const ctx = makeContext([makeCard({ tags: ['backend', 'api'] })]);
    const explanation = explainNoResults({ label: 'frontend' }, ctx);
    expect(explanation).toContain('frontend');
    expect(explanation).toContain('Available tags');
  });

  it('explains no overdue cards', () => {
    const ctx = makeContext([makeCard({ due: '2099-01-01T00:00:00Z' })]);
    const explanation = explainNoResults({ due: 'overdue' }, ctx);
    expect(explanation).toContain('overdue');
  });

  it('explains no text match', () => {
    const ctx = makeContext([makeCard({ title: 'Different Card' })]);
    const explanation = explainNoResults({ text: 'authentication' }, ctx);
    expect(explanation).toContain('authentication');
  });

  it('uses generic message as fallback', () => {
    const ctx = makeContext([makeCard()]);
    const explanation = explainNoResults({ rawQuery: 'exotic query' }, ctx);
    expect(explanation).toContain('exotic query');
  });

  it('explains no relation found', () => {
    const ctx = makeContext([makeCard({ blockedBy: [], blocking: [] })]);
    const explanation = explainNoResults({ relatesTo: 'nonexistent-card' }, ctx);
    expect(explanation).toContain('nonexistent-card');
  });
});

// ─── buildSummary Tests ───────────────────────────────────────────────────────

describe('buildSummary', () => {
  it('returns empty string for no matches', () => {
    expect(buildSummary([], {})).toBe('');
  });

  it('formats single match', () => {
    const match: QueryMatch = { card: makeCard({ title: 'My Card' }), matchReason: 'status: done' };
    const summary = buildSummary([match], {});
    expect(summary).toContain('1');
    expect(summary).toContain('My Card');
    expect(summary).toContain('Found');
  });

  it('formats 3 matches in-line', () => {
    const matches = ['Card A', 'Card B', 'Card C'].map(t =>
      ({ card: makeCard({ title: t }), matchReason: 'test' })
    );
    const summary = buildSummary(matches, {});
    expect(summary).toContain('3');
    expect(summary).toContain('Card A');
    expect(summary).toContain('Card C');
  });

  it('truncates at 5+ matches with ellipsis', () => {
    const matches = ['A', 'B', 'C', 'D', 'E', 'F'].map(t =>
      ({ card: makeCard({ title: t }), matchReason: 'test' })
    );
    const summary = buildSummary(matches, {});
    expect(summary).toContain('6');
    expect(summary).toContain('…');
    expect(summary).toContain('3 more');
  });

  it('uses "card" singular for 1 result', () => {
    const match: QueryMatch = { card: makeCard({ title: 'My Card' }), matchReason: '' };
    const summary = buildSummary([match], {});
    expect(summary).toMatch(/1 matching card:/);
  });

  it('uses "cards" plural for 2+ results', () => {
    const matches = ['A', 'B'].map(t =>
      ({ card: makeCard({ title: t }), matchReason: '' })
    );
    const summary = buildSummary(matches, {});
    expect(summary).toMatch(/2 matching cards:/);
  });
});

// ─── QueryAPI.execute Tests ───────────────────────────────────────────────────

const mockGetSnapshot = vi.fn();

vi.mock('../../../src/api/context', () => {
  return {
    default: function MockContextAPI() {
      return { getSnapshot: mockGetSnapshot };
    },
  };
});

describe('QueryAPI.execute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeSnapshot(cards: ContextCard[]): BoardContextSnapshot {
    return makeContext(cards);
  }

  it('returns matching cards for status query', async () => {
    const cards = [
      makeCard({ id: 'c1', title: 'Done Card', status: 'done' }),
      makeCard({ id: 'c2', title: 'Todo Card', status: 'todo' }),
    ];
    mockGetSnapshot.mockResolvedValue(makeSnapshot(cards));

    const api = new QueryAPI({} as any);
    const result = await api.execute('board-1', 'status:done');

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].card.title).toBe('Done Card');
    expect(result.summary).toContain('Found 1');
  });

  it('returns noResultsExplanation when no matches', async () => {
    const cards = [makeCard({ status: 'todo' })];
    mockGetSnapshot.mockResolvedValue(makeSnapshot(cards));

    const api = new QueryAPI({} as any);
    const result = await api.execute('board-1', 'status:done');

    expect(result.matches).toHaveLength(0);
    expect(result.noResultsExplanation).toBeDefined();
    expect(result.noResultsExplanation).toContain('done');
  });

  it('returns total card count', async () => {
    const cards = [
      makeCard({ id: 'c1', status: 'done' }),
      makeCard({ id: 'c2', status: 'todo' }),
      makeCard({ id: 'c3', status: 'in-progress' }),
    ];
    mockGetSnapshot.mockResolvedValue(makeSnapshot(cards));

    const api = new QueryAPI({} as any);
    const result = await api.execute('board-1', 'status:done');

    expect(result.total).toBe(3);
  });

  it('returns all cards on empty filter', async () => {
    const cards = [
      makeCard({ id: 'c1', title: 'A' }),
      makeCard({ id: 'c2', title: 'B' }),
    ];
    mockGetSnapshot.mockResolvedValue(makeSnapshot(cards));

    const api = new QueryAPI({} as any);
    const result = await api.execute('board-1', 'list all');

    expect(result.matches.length).toBeGreaterThanOrEqual(1);
  });

  it('filters by assignee', async () => {
    const cards = [
      makeCard({ id: 'c1', title: 'Alice Card', assignees: ['alice@example.com'] }),
      makeCard({ id: 'c2', title: 'Bob Card', assignees: ['bob@example.com'] }),
    ];
    mockGetSnapshot.mockResolvedValue(makeSnapshot(cards));

    const api = new QueryAPI({} as any);
    const result = await api.execute('board-1', 'assigned:alice');

    expect(result.matches.some(m => m.card.title === 'Alice Card')).toBe(true);
    expect(result.matches.some(m => m.card.title === 'Bob Card')).toBe(false);
  });

  it('filters blocked cards', async () => {
    const cards = [
      makeCard({ id: 'c1', title: 'Blocked', blockedBy: ['c3'] }),
      makeCard({ id: 'c2', title: 'Clear', blockedBy: [] }),
    ];
    mockGetSnapshot.mockResolvedValue(makeSnapshot(cards));

    const api = new QueryAPI({} as any);
    const result = await api.execute('board-1', 'blocked');

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].card.title).toBe('Blocked');
  });

  it('includes filter in result', async () => {
    const cards = [makeCard({ status: 'done' })];
    mockGetSnapshot.mockResolvedValue(makeSnapshot(cards));

    const api = new QueryAPI({} as any);
    const result = await api.execute('board-1', 'status:done');

    expect(result.filter.status).toBe('done');
    expect(result.filter.rawQuery).toBe('status:done');
  });

  it('passes cardLimit to getSnapshot', async () => {
    mockGetSnapshot.mockResolvedValue(makeSnapshot([]));

    const api = new QueryAPI({} as any);
    await api.execute('board-1', 'status:done', 500);

    expect(mockGetSnapshot).toHaveBeenCalledWith('board-1', 500);
  });

  it('explains no-results for blocked when no blocked cards', async () => {
    const cards = [makeCard({ blockedBy: [] })];
    mockGetSnapshot.mockResolvedValue(makeSnapshot(cards));

    const api = new QueryAPI({} as any);
    const result = await api.execute('board-1', 'blocked');

    expect(result.noResultsExplanation).toContain('blocked');
  });

  it('explains no-results for label', async () => {
    const cards = [makeCard({ tags: ['backend'] })];
    mockGetSnapshot.mockResolvedValue(makeSnapshot(cards));

    const api = new QueryAPI({} as any);
    const result = await api.execute('board-1', 'label:frontend');

    expect(result.noResultsExplanation).toContain('frontend');
    expect(result.noResultsExplanation).toContain('backend');
  });
});
