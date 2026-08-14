/**
 * Unit tests — SprintPlanAPI
 * CLA-1799 / FAVRO-037: Standup & Sprint Commands
 */

import {
  priorityScore,
  extractPriority,
  isBacklogCard,
  compareSprintCards,
  SprintPlanAPI,
  type SprintCard,
} from '../../api/sprint-plan';
// `extractEffort` moved to its one home in `api/context` (#89); `sprint-plan`
// is now a caller like the rest.
import { extractEffort, type ContextCard } from '../../api/context';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeCard(overrides: Partial<ContextCard> = {}): ContextCard {
  return {
    id: 'card-1',
    title: 'Test Card',
    status: 'Backlog',
    assignees: [],
    tags: [],
    blockedBy: [],
    blocking: [],
    customFields: {},
    ...overrides,
  };
}

function makeSprintCard(overrides: Partial<SprintCard> = {}): SprintCard {
  return {
    id: 'c1',
    title: 'Test',
    status: 'Backlog',
    assignees: [],
    priorityScore: 0,
    cumulative: 0,
    withinBudget: true,
    ...overrides,
  };
}

// ─── priorityScore ────────────────────────────────────────────────────────────

describe('priorityScore', () => {
  it('returns 4 for "critical"', () => {
    expect(priorityScore('critical')).toBe(4);
  });

  it('returns 3 for "high"', () => {
    expect(priorityScore('high')).toBe(3);
  });

  it('returns 2 for "medium"', () => {
    expect(priorityScore('medium')).toBe(2);
  });

  it('returns 1 for "low"', () => {
    expect(priorityScore('low')).toBe(1);
  });

  it('returns 0 for undefined', () => {
    expect(priorityScore(undefined)).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(priorityScore('HIGH')).toBe(3);
    expect(priorityScore('Medium')).toBe(2);
  });

  it('returns 4 for "urgent"', () => {
    expect(priorityScore('urgent')).toBe(4);
  });

  it('returns 0 for unrecognized priority', () => {
    expect(priorityScore('banana')).toBe(0);
  });
});

// ─── extractEffort ────────────────────────────────────────────────────────────

describe('extractEffort', () => {
  it('extracts "effort" field', () => {
    expect(extractEffort(makeCard({ customFields: { effort: 3 } }))).toBe(3);
  });

  it('extracts "Effort" field (capital)', () => {
    expect(extractEffort(makeCard({ customFields: { Effort: 5 } }))).toBe(5);
  });

  it('extracts "story points" field', () => {
    expect(extractEffort(makeCard({ customFields: { 'story points': '8' } }))).toBe(8);
  });

  it('extracts "Points" field', () => {
    expect(extractEffort(makeCard({ customFields: { Points: 2 } }))).toBe(2);
  });

  it('returns undefined when no effort field', () => {
    expect(extractEffort(makeCard({ customFields: {} }))).toBeUndefined();
  });

  it('returns undefined for empty customFields', () => {
    expect(extractEffort(makeCard({ customFields: undefined }))).toBeUndefined();
  });

  it('ignores non-numeric values', () => {
    expect(extractEffort(makeCard({ customFields: { effort: 'large' } }))).toBeUndefined();
  });
});

// ─── extractPriority ──────────────────────────────────────────────────────────

describe('extractPriority', () => {
  it('extracts "priority" field', () => {
    expect(extractPriority(makeCard({ customFields: { priority: 'high' } }))).toBe('high');
  });

  it('extracts "Priority" field (capital)', () => {
    expect(extractPriority(makeCard({ customFields: { Priority: 'Medium' } }))).toBe('Medium');
  });

  it('extracts "urgency" field', () => {
    expect(extractPriority(makeCard({ customFields: { urgency: 'critical' } }))).toBe('critical');
  });

  it('returns undefined when no priority field', () => {
    expect(extractPriority(makeCard({ customFields: {} }))).toBeUndefined();
  });
});

// ─── isBacklogCard ────────────────────────────────────────────────────────────

describe('isBacklogCard', () => {
  it('returns true for "Backlog" status', () => {
    expect(isBacklogCard(makeCard({ status: 'Backlog' }))).toBe(true);
  });

  it('returns true for "backlog" (case-insensitive)', () => {
    expect(isBacklogCard(makeCard({ status: 'backlog' }))).toBe(true);
  });

  it('returns true for "Todo"', () => {
    expect(isBacklogCard(makeCard({ status: 'Todo' }))).toBe(true);
  });

  it('returns true for "To Do"', () => {
    expect(isBacklogCard(makeCard({ status: 'To Do' }))).toBe(true);
  });

  it('returns true for "Ready"', () => {
    expect(isBacklogCard(makeCard({ status: 'Ready' }))).toBe(true);
  });

  it('returns false for "In Progress"', () => {
    expect(isBacklogCard(makeCard({ status: 'In Progress' }))).toBe(false);
  });

  it('returns false for "Done"', () => {
    expect(isBacklogCard(makeCard({ status: 'Done' }))).toBe(false);
  });

  it('returns false for undefined status', () => {
    expect(isBacklogCard(makeCard({ status: undefined }))).toBe(false);
  });
});

// ─── compareSprintCards ───────────────────────────────────────────────────────

describe('compareSprintCards', () => {
  it('sorts higher priority first', () => {
    const a = makeSprintCard({ priorityScore: 3 });
    const b = makeSprintCard({ priorityScore: 1 });
    expect(compareSprintCards(a, b)).toBeLessThan(0);
  });

  it('sorts lower effort first when priority is equal', () => {
    const a = makeSprintCard({ priorityScore: 2, effort: 2 });
    const b = makeSprintCard({ priorityScore: 2, effort: 5 });
    expect(compareSprintCards(a, b)).toBeLessThan(0);
  });

  it('puts undefined effort last', () => {
    const a = makeSprintCard({ priorityScore: 2, effort: 5 });
    const b = makeSprintCard({ priorityScore: 2, effort: undefined });
    expect(compareSprintCards(a, b)).toBeLessThan(0);
  });

  it('uses alphabetical tiebreaker', () => {
    const a = makeSprintCard({ priorityScore: 2, effort: 3, title: 'Alpha' });
    const b = makeSprintCard({ priorityScore: 2, effort: 3, title: 'Zebra' });
    expect(compareSprintCards(a, b)).toBeLessThan(0);
  });

  it('returns 0 for identical cards', () => {
    const a = makeSprintCard({ priorityScore: 2, effort: 3, title: 'Same' });
    const b = makeSprintCard({ priorityScore: 2, effort: 3, title: 'Same' });
    expect(compareSprintCards(a, b)).toBe(0);
  });
});

// ─── SprintPlanAPI ────────────────────────────────────────────────────────────

const mockGetSnapshot = jest.fn();

// Only the class is stubbed. The module's pure helpers — `extractEffort` since
// #89 — stay real, or `sprint-plan` would be scoring against `undefined`.
jest.mock('../../api/context', () => ({
  ...jest.requireActual('../../api/context'),
  __esModule: true,
  default: function MockContextAPI() {
    return { getSnapshot: mockGetSnapshot };
  },
}));

const SAMPLE_SNAPSHOT = {
  board: { id: 'b-1', name: 'Sprint 42', members: [] },
  columns: [],
  customFields: [],
  members: [],
  cards: [
    {
      id: 'c1', title: 'High effort 2', status: 'Backlog', assignees: [], tags: [], blockedBy: [], blocking: [],
      customFields: { priority: 'high', effort: 2 },
    },
    {
      id: 'c2', title: 'High effort 5', status: 'Backlog', assignees: [], tags: [], blockedBy: [], blocking: [],
      customFields: { priority: 'high', effort: 5 },
    },
    {
      id: 'c3', title: 'Low priority', status: 'Backlog', assignees: [], tags: [], blockedBy: [], blocking: [],
      customFields: { priority: 'low', effort: 1 },
    },
    {
      id: 'c4', title: 'In Progress card', status: 'In Progress', assignees: [], tags: [], blockedBy: [], blocking: [],
      customFields: { priority: 'high', effort: 2 },
    },
    {
      id: 'c5', title: 'Over budget', status: 'Backlog', assignees: [], tags: [], blockedBy: [], blocking: [],
      customFields: { priority: 'medium', effort: 50 },
    },
  ],
  stats: { total: 5, by_status: {}, by_owner: {} },
  generatedAt: '2026-01-01T00:00:00.000Z',
};

describe('SprintPlanAPI', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSnapshot.mockResolvedValue(SAMPLE_SNAPSHOT);
  });

  it('filters out non-backlog cards', async () => {
    const client = {} as any;
    const api = new SprintPlanAPI(client);
    const result = await api.getSuggestions('Sprint 42', 40);

    const allCards = [...result.suggestions, ...result.overflow];
    expect(allCards.find(c => c.id === 'c4')).toBeUndefined();
  });

  it('sorts by priority desc, effort asc', async () => {
    const client = {} as any;
    const api = new SprintPlanAPI(client);
    const result = await api.getSuggestions('Sprint 42', 40);

    const allCards = [...result.suggestions, ...result.overflow];
    // c1 (high/2) before c2 (high/5) before c3 (low/1)
    const ids = allCards.map(c => c.id);
    expect(ids.indexOf('c1')).toBeLessThan(ids.indexOf('c2'));
    expect(ids.indexOf('c2')).toBeLessThan(ids.indexOf('c3'));
  });

  it('respects budget — c5 (effort=50) should overflow budget=40', async () => {
    const client = {} as any;
    const api = new SprintPlanAPI(client);
    const result = await api.getSuggestions('Sprint 42', 40);

    const overflowIds = result.overflow.map(c => c.id);
    expect(overflowIds).toContain('c5');
  });

  it('calculates cumulative effort correctly', async () => {
    const client = {} as any;
    const api = new SprintPlanAPI(client);
    const result = await api.getSuggestions('Sprint 42', 40);

    // c1(2) + c2(5) + c3(1) = 8 total in suggestions
    const lastSuggestion = result.suggestions[result.suggestions.length - 1];
    expect(lastSuggestion.cumulative).toBe(result.totalSuggested);
  });

  it('an id-keyed payload makes the budget verdict UNDISCLOSED, not "everything fits" (#169 review)', async () => {
    // The key is what `normalizeCard` → `customFieldMap` produces off the wire:
    // `GET /cards` inlines `{customFieldId, value}` and no `name`, so every card's
    // `effort` is `undefined` here. Under `?? 0` that made every card free —
    // `running <= budget` was `0 <= 40` for all of them — and `sprint-plan`
    // reported the whole backlog as fitting a 40-point sprint, `totalSuggested: 0`,
    // `overflow: []`. The central judgement of the command, silently wrong.
    mockGetSnapshot.mockResolvedValue({
      ...SAMPLE_SNAPSHOT,
      cards: SAMPLE_SNAPSHOT.cards.map(c => ({
        ...c,
        customFields: { zxMLxD4zx4tSwJr75: ['YLanLiuXKA8JpvEsX'] },
      })),
    });

    const result = await new SprintPlanAPI({} as any).getSuggestions('Sprint 42', 40);

    expect(result.totalSuggested).toBeNull();
    expect(result.suggestions.map(c => [c.cumulative, c.withinBudget]))
      .toEqual([[null, null], [null, null], [null, null], [null, null]]);
    // Nothing was MEASURED not to fit, so nothing may be excluded as over budget.
    expect(result.overflow).toEqual([]);
    // The cards are still ranked and still returned — this withholds the budget
    // cut, it does not drop the backlog.
    expect(result.suggestions).toHaveLength(4);

    // The PRIORITY half of the same payload, and the one that decides ORDER.
    // `extractPriority` looks up six literal field NAMES, so every lookup missed
    // and every card carried `priorityScore: 0` under a field documented "0–4
    // (higher = more important)" — which made `compareSprintCards` fall through to
    // its alphabetical tiebreaker while `--help` advertised priority×effort.
    expect(result.suggestions.map(c => [c.priority, c.priorityScore]))
      .toEqual([['unavailable', null], ['unavailable', null], ['unavailable', null], ['unavailable', null]]);
  });

  it('a card carrying no custom fields keeps a measured priority score of 0', async () => {
    // The polarity: nothing was unreadable, so `0` is the answer rather than a
    // fabrication, and `priority` stays absent rather than reading `unavailable`.
    mockGetSnapshot.mockResolvedValue({
      ...SAMPLE_SNAPSHOT,
      cards: [{ id: 'c1', title: 'Bare', status: 'Backlog', assignees: [], tags: [], blockedBy: [], blocking: [] }],
    });

    const result = await new SprintPlanAPI({} as any).getSuggestions('Sprint 42', 40);

    expect(result.suggestions.map(c => [c.priority, c.priorityScore])).toEqual([[undefined, 0]]);
    expect(result.totalSuggested).toBe(0);
  });

  it('uses default budget of 40', async () => {
    const client = {} as any;
    const api = new SprintPlanAPI(client);
    const result = await api.getSuggestions('Sprint 42');

    expect(result.budget).toBe(40);
  });

  // Was `passes cardLimit to getSnapshot`, asserting a pass-through into a
  // parameter `getSnapshot` never read. `--budget` is untouched and still real.
  it('asks getSnapshot for the board and nothing else — there is no cap', async () => {
    const api = new SprintPlanAPI({} as any);
    await api.getSuggestions('Sprint 42', 40);

    expect(mockGetSnapshot).toHaveBeenCalledWith('Sprint 42');
  });

  it('includes board info in result', async () => {
    const client = {} as any;
    const api = new SprintPlanAPI(client);
    const result = await api.getSuggestions('Sprint 42');

    expect(result.board.name).toBe('Sprint 42');
    expect(result.board.id).toBe('b-1');
  });

  it('handles empty board (no backlog cards)', async () => {
    mockGetSnapshot.mockResolvedValue({ ...SAMPLE_SNAPSHOT, cards: [] });

    const client = {} as any;
    const api = new SprintPlanAPI(client);
    const result = await api.getSuggestions('Sprint 42');

    expect(result.suggestions).toHaveLength(0);
    expect(result.overflow).toHaveLength(0);
    expect(result.totalSuggested).toBe(0);
  });

  it('marks withinBudget correctly', async () => {
    const client = {} as any;
    const api = new SprintPlanAPI(client);
    const result = await api.getSuggestions('Sprint 42', 40);

    for (const card of result.suggestions) {
      expect(card.withinBudget).toBe(true);
    }
    for (const card of result.overflow) {
      expect(card.withinBudget).toBe(false);
    }
  });
});
