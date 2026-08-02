/**
 * Unit tests — ContextAPI
 * CLA-1796 / FAVRO-034: Board Context Snapshot Command
 */
import ContextAPI, { buildWorkflow, extractEffort, ContextCard } from '../../api/context';
import FavroHttpClient from '../../lib/http-client';
import BoardsAPI from '../../lib/boards-api';
import CardsAPI from '../../lib/cards-api';
import { FavroApiClient } from '../../api/members';
import { CustomFieldsAPI } from '../../lib/custom-fields-api';

jest.mock('../../lib/http-client');
jest.mock('../../lib/boards-api');
jest.mock('../../lib/cards-api');
jest.mock('../../api/members');
jest.mock('../../lib/custom-fields-api');

const MockBoardsAPI = BoardsAPI as jest.MockedClass<typeof BoardsAPI>;
const MockCardsAPI = CardsAPI as jest.MockedClass<typeof CardsAPI>;
const MockFavroApiClient = FavroApiClient as jest.MockedClass<typeof FavroApiClient>;
const MockCustomFieldsAPI = CustomFieldsAPI as jest.MockedClass<typeof CustomFieldsAPI>;

const SAMPLE_BOARD = {
  boardId: 'boards-1234',
  name: 'Sprint 42',
  description: 'Q1 Sprint',
  type: 'kanban' as const,
  collectionId: 'col-001',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-03-01T00:00:00Z',
};

const SAMPLE_EXTENDED_BOARD = {
  ...SAMPLE_BOARD,
  boardColumns: [
    { columnId: 'col-a', name: 'Backlog', cardCount: 3 },
    { columnId: 'col-b', name: 'In Progress', cardCount: 2 },
    { columnId: 'col-c', name: 'Done', cardCount: 1 },
  ],
  members: [
    { userId: 'u1', name: 'Alice', email: 'alice@ex.com', role: 'admin' },
  ],
  customFields: [
    { fieldId: 'cf1', name: 'Priority', type: 'select', options: ['High', 'Low'] },
  ],
};

const SAMPLE_MEMBERS = [
  { id: 'u1', name: 'Alice', email: 'alice@ex.com', role: 'admin' },
  { id: 'u2', name: 'Bob', email: 'bob@ex.com', role: 'member' },
];

const SAMPLE_CUSTOM_FIELDS = [
  {
    fieldId: 'cf1',
    name: 'Priority',
    type: 'select',
    options: [
      { optionId: 'o1', name: 'High' },
      { optionId: 'o2', name: 'Medium' },
      { optionId: 'o3', name: 'Low' },
    ],
    required: true,
  },
];

const SAMPLE_CARDS = [
  {
    cardId: 'card-001',
    name: 'Fix login bug',
    status: 'In Progress',
    assignees: ['alice@ex.com'],
    tags: ['bug'],
    dueDate: '2026-03-25',
    createdAt: '2026-01-10T00:00:00Z',
    updatedAt: '2026-03-10T00:00:00Z',
    links: [
      { cardId: 'card-002', isBefore: true },
    ],
    customFields: [
      { fieldId: 'cf1', name: 'Priority', value: 'High' },
    ],
  },
  {
    cardId: 'card-002',
    name: 'Set up CI',
    status: 'Done',
    assignees: ['bob@ex.com'],
    tags: [],
    createdAt: '2026-01-05T00:00:00Z',
    links: [],
  },
];

function buildAPI() {
  const mockClient = new (FavroHttpClient as any)();
  return new ContextAPI(mockClient);
}

beforeEach(() => {
  jest.clearAllMocks();

  MockBoardsAPI.prototype.getBoard.mockResolvedValue(SAMPLE_BOARD as any);
  MockBoardsAPI.prototype.listBoards.mockResolvedValue([SAMPLE_BOARD as any]);
  MockBoardsAPI.prototype.getBoardWithIncludes.mockResolvedValue(SAMPLE_EXTENDED_BOARD as any);
  MockCardsAPI.prototype.listCards.mockResolvedValue(SAMPLE_CARDS as any);
  MockFavroApiClient.prototype.getMembers.mockResolvedValue(SAMPLE_MEMBERS as any);
  MockCustomFieldsAPI.prototype.listFields.mockResolvedValue(SAMPLE_CUSTOM_FIELDS as any);
});

// ─── resolveBoard ─────────────────────────────────────────────────────────────

// `resolveBoard` is one call into the resolver now (#122) — no local listing,
// no substring fallback. What it *resolves to* is BoardsAPI's contract and is
// pinned against a real wire in `boards-collections-resolve-wire.test.ts` and
// `context-aggregate-resolve-wire.test.ts`; all this mocked suite can honestly
// assert is that nothing is done to the argument on the way in or the answer
// on the way out.
describe('ContextAPI.resolveBoard()', () => {
  it('hands the reference to the resolver untouched', async () => {
    const api = buildAPI();
    const board = await api.resolveBoard('Sprint 42');
    expect(board.boardId).toBe('boards-1234');
    expect(MockBoardsAPI.prototype.getBoard).toHaveBeenCalledWith('Sprint 42');
  });

  it('never lists boards itself — the 100-board cap is gone with the fallback', async () => {
    const api = buildAPI();
    await api.resolveBoard('Sprint 42');
    expect(MockBoardsAPI.prototype.listBoards).not.toHaveBeenCalled();
  });

  it('propagates the resolver’s refusal instead of guessing a partial match', async () => {
    MockBoardsAPI.prototype.getBoard.mockRejectedValue(new Error('2 boards are named "Sprint"'));
    const api = buildAPI();
    await expect(api.resolveBoard('Sprint')).rejects.toThrow('2 boards are named "Sprint"');
    expect(MockBoardsAPI.prototype.listBoards).not.toHaveBeenCalled();
  });
});

// ─── getSnapshot ─────────────────────────────────────────────────────────────

describe('ContextAPI.getSnapshot()', () => {
  it('returns a valid snapshot structure', async () => {
    const api = buildAPI();
    const snapshot = await api.getSnapshot('boards-1234');

    expect(snapshot).toMatchObject({
      board: {
        id: 'boards-1234',
        name: 'Sprint 42',
      },
      columns: expect.any(Array),
      customFields: expect.any(Array),
      members: expect.any(Array),
      cards: expect.any(Array),
      stats: expect.any(Object),
      generatedAt: expect.any(String),
    });
  });

  it('includes board metadata', async () => {
    const api = buildAPI();
    const snapshot = await api.getSnapshot('boards-1234');

    expect(snapshot.board.id).toBe('boards-1234');
    expect(snapshot.board.name).toBe('Sprint 42');
    expect(snapshot.board.description).toBe('Q1 Sprint');
    expect(snapshot.board.type).toBe('kanban');
    expect(snapshot.board.collection).toBe('col-001');
  });

  it('includes columns from extended board', async () => {
    const api = buildAPI();
    const snapshot = await api.getSnapshot('boards-1234');

    expect(snapshot.columns).toHaveLength(3);
    expect(snapshot.columns[0]).toMatchObject({
      id: 'col-a',
      name: 'Backlog',
      cardCount: 3,
    });
  });

  it('includes custom field definitions with options', async () => {
    const api = buildAPI();
    const snapshot = await api.getSnapshot('boards-1234');

    expect(snapshot.customFields).toHaveLength(1);
    expect(snapshot.customFields[0]).toMatchObject({
      id: 'cf1',
      name: 'Priority',
      type: 'select',
      values: ['High', 'Medium', 'Low'],
      required: true,
    });
  });

  it('includes members with all fields', async () => {
    const api = buildAPI();
    const snapshot = await api.getSnapshot('boards-1234');

    expect(snapshot.members).toHaveLength(2);
    expect(snapshot.members[0]).toMatchObject({
      id: 'u1',
      name: 'Alice',
      email: 'alice@ex.com',
      role: 'admin',
    });
  });

  it('includes all cards with normalized fields', async () => {
    const api = buildAPI();
    const snapshot = await api.getSnapshot('boards-1234');

    expect(snapshot.cards).toHaveLength(2);
    const card = snapshot.cards[0];
    expect(card.id).toBe('card-001');
    expect(card.title).toBe('Fix login bug');
    expect(card.status).toBe('In Progress');
    expect(card.assignees).toEqual(['alice@ex.com']);
    expect(card.owner).toBe('alice@ex.com');
    expect(card.tags).toEqual(['bug']);
    expect(card.due).toBe('2026-03-25');
  });

  it('extracts card relationships (blockedBy, blocking)', async () => {
    const api = buildAPI();
    const snapshot = await api.getSnapshot('boards-1234');

    const card = snapshot.cards[0];
    expect(card.blockedBy).toEqual(['card-002']);
    expect(card.blocking).toEqual([]);
  });

  it('extracts custom field values per card', async () => {
    const api = buildAPI();
    const snapshot = await api.getSnapshot('boards-1234');

    const card = snapshot.cards[0];
    expect(card.customFields).toEqual({ Priority: 'High' });
  });

  it('builds correct stats', async () => {
    const api = buildAPI();
    const snapshot = await api.getSnapshot('boards-1234');

    expect(snapshot.stats.total).toBe(2);
    expect(snapshot.stats.by_status['In Progress']).toBe(1);
    expect(snapshot.stats.by_status['Done']).toBe(1);
    expect(snapshot.stats.by_owner['alice@ex.com']).toBe(1);
    expect(snapshot.stats.by_owner['bob@ex.com']).toBe(1);
  });

  it('handles cards with no assignees (unassigned)', async () => {
    MockCardsAPI.prototype.listCards.mockResolvedValue([
      { cardId: 'c1', name: 'Orphan', status: 'Backlog', createdAt: '2026-01-01T00:00:00Z' } as any,
    ]);
    const api = buildAPI();
    const snapshot = await api.getSnapshot('boards-1234');

    expect(snapshot.stats.by_owner['unassigned']).toBe(1);
  });

  // #44: `listCards` no longer takes a limit — it used to truncate the FETCH, so
  // the snapshot was assembled from a partial board and reported as the board.
  it('reads the whole board, with no limit on the fetch', async () => {
    const api = buildAPI();
    await api.getSnapshot('boards-1234', 500);
    expect(MockCardsAPI.prototype.listCards).toHaveBeenCalledWith('boards-1234');
  });

  it('fetches board data in parallel (Promise.all)', async () => {
    // Verify all 4 data sources are called
    const api = buildAPI();
    await api.getSnapshot('boards-1234');

    expect(MockBoardsAPI.prototype.getBoardWithIncludes).toHaveBeenCalledWith(
      'boards-1234',
      ['custom-fields', 'members']
    );
    expect(MockCardsAPI.prototype.listCards).toHaveBeenCalled();
    expect(MockFavroApiClient.prototype.getMembers).toHaveBeenCalledWith({ boardId: 'boards-1234' });
    expect(MockCustomFieldsAPI.prototype.listFields).toHaveBeenCalledWith('boards-1234');
  });

  it('gracefully handles API errors on secondary fetches', async () => {
    // Cards API fails — should still return snapshot (empty cards)
    MockCardsAPI.prototype.listCards.mockRejectedValue(new Error('API timeout'));
    MockFavroApiClient.prototype.getMembers.mockRejectedValue(new Error('API timeout'));

    const api = buildAPI();
    const snapshot = await api.getSnapshot('boards-1234');

    // Should still succeed with empty cards and members
    expect(snapshot.cards).toHaveLength(0);
    expect(snapshot.stats.total).toBe(0);
  });

  // ─── the hole the composite read used to swallow (#116) ────────────────────
  //
  // Five sub-fetches run in parallel behind one `.catch(() => [])` each, so a
  // failed cards read used to come back as `cards: []` / `stats.total: 0` and
  // nothing else — "we could not look" printed as "there is nothing there",
  // which is the exact failure `read-shape.ts` rule 3 exists to prevent. Every
  // consumer inherits it: `standup`, `sprint-plan` and `query` all sit on this
  // snapshot.
  it('reports a failed sub-fetch as unreachable rather than as emptiness', async () => {
    MockCardsAPI.prototype.listCards.mockRejectedValue(new Error('API timeout'));

    const api = buildAPI();
    const snapshot = await api.getSnapshot('boards-1234');

    // Rows AND the hole — the acceptance shape for a composite read.
    expect(snapshot.members.length).toBeGreaterThan(0);
    expect(snapshot.cards).toHaveLength(0);
    expect(snapshot.unreachable).toEqual([
      { id: 'cards', reason: expect.stringContaining('API timeout') },
    ]);
  });

  it('names every facet that failed, and only those', async () => {
    MockCardsAPI.prototype.listCards.mockRejectedValue(new Error('cards down'));
    MockFavroApiClient.prototype.getMembers.mockRejectedValue(new Error('members down'));

    const api = buildAPI();
    const snapshot = await api.getSnapshot('boards-1234');

    expect((snapshot.unreachable ?? []).map((u) => u.id).sort()).toEqual(['cards', 'members']);
  });

  it('omits unreachable entirely when every facet answered', async () => {
    // Absent, not empty: an empty array would read as a hole to a `?.length`
    // check and make "complete" indistinguishable from "we recorded nothing".
    const api = buildAPI();
    const snapshot = await api.getSnapshot('boards-1234');

    expect(snapshot).not.toHaveProperty('unreachable');
  });

  it('includes generatedAt timestamp in ISO format', async () => {
    const api = buildAPI();
    const snapshot = await api.getSnapshot('boards-1234');

    expect(snapshot.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// ─── Performance ─────────────────────────────────────────────────────────────

describe('ContextAPI performance', () => {
  it('getSnapshot resolves in < 1000ms for 500 mock cards', async () => {
    const cards500 = Array.from({ length: 500 }, (_, i) => ({
      cardId: `card-${i}`,
      name: `Card ${i}`,
      status: i % 3 === 0 ? 'Done' : 'In Progress',
      assignees: [`user${i % 5}@ex.com`],
      tags: [],
      createdAt: '2026-01-01T00:00:00Z',
      links: [],
    }));

    MockCardsAPI.prototype.listCards.mockResolvedValue(cards500 as any);

    const api = buildAPI();
    const start = Date.now();
    const snapshot = await api.getSnapshot('boards-1234', 500);
    const elapsed = Date.now() - start;

    expect(snapshot.cards).toHaveLength(500);
    expect(elapsed).toBeLessThan(1000);
  });
});

// ─── Shared helpers (#89) ────────────────────────────────────────────────────
// `buildWorkflow` and `extractEffort` each had copies elsewhere. These pin the
// one that survives, before the other call sites are pointed at it.

describe('buildWorkflow', () => {
  it('numbers steps from 1 and points each at the next column by NAME', () => {
    const steps = buildWorkflow([
      { id: 'c1', name: 'Backlog' },
      { id: 'c2', name: 'In Progress' },
      { id: 'c3', name: 'Done' },
    ]);

    expect(steps).toEqual([
      { columnId: 'c1', columnName: 'Backlog', position: 1, stage: 'backlog', nextColumn: 'In Progress' },
      { columnId: 'c2', columnName: 'In Progress', position: 2, stage: 'active', nextColumn: 'Done' },
      { columnId: 'c3', columnName: 'Done', position: 3, stage: 'done', nextColumn: undefined },
    ]);
  });

  it('returns an empty workflow for a board with no columns', () => {
    expect(buildWorkflow([])).toEqual([]);
  });
});

describe('extractEffort', () => {
  const withFields = (customFields?: Record<string, unknown>): ContextCard =>
    ({ id: 'c1', title: 'Card', customFields }) as ContextCard;

  it('reads an effort-shaped field name, whatever its casing', () => {
    expect(extractEffort(withFields({ effort: 3 }))).toBe(3);
    expect(extractEffort(withFields({ Effort: 5 }))).toBe(5);
  });

  it('reads the story-point spellings', () => {
    expect(extractEffort(withFields({ 'story points': '8' }))).toBe(8);
    expect(extractEffort(withFields({ 'Story Points': '3' }))).toBe(3);
    expect(extractEffort(withFields({ Points: 2 }))).toBe(2);
    expect(extractEffort(withFields({ Estimate: 8 }))).toBe(8);
  });

  it('is undefined — never 0 — when there is nothing to read', () => {
    expect(extractEffort(withFields(undefined))).toBeUndefined();
    expect(extractEffort(withFields({}))).toBeUndefined();
    expect(extractEffort(withFields({ Team: 'Platform' }))).toBeUndefined();
  });

  it('is undefined for an effort field that is not a number', () => {
    expect(extractEffort(withFields({ effort: 'large' }))).toBeUndefined();
  });

  it('keeps looking past an effort field with no value in it', () => {
    expect(extractEffort(withFields({ effort: null, Points: 4 }))).toBe(4);
  });
});
