/**
 * Comprehensive tests for BoardsAPI and boards list command
 * CLA-1774: Unit Tests — All Commands
 * CLA-1784: Advanced Boards Endpoints
 */
import BoardsAPI, {
  Board,
  ExtendedBoard,
  aggregateBoardStats,
  calculateVelocity,
} from '../lib/boards-api';
import { Collection } from '../lib/collections-api';
import FavroHttpClient from '../lib/http-client';

describe('Boards API', () => {
  let api: BoardsAPI;
  let mockClient: jest.Mocked<Pick<FavroHttpClient, 'get' | 'post' | 'put' | 'patch' | 'delete'>>;

  const sampleBoard = {
    widgetCommonId: 'board-1',
    name: 'Board 1',
    description: 'Test board',
    collectionId: 'coll-1',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };

  const sampleCollection: Collection = {
    collectionId: 'coll-1',
    name: 'Collection 1',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };

  beforeEach(() => {
    mockClient = {
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      patch: jest.fn(),
      delete: jest.fn(),
    };
    api = new BoardsAPI(mockClient as any);
  });

  // --- listBoards ---

  test('listBoards returns array of boards', async () => {
    mockClient.get.mockResolvedValue({ entities: [sampleBoard] });
    const result = await api.listBoards();
    expect(result).toHaveLength(1);
    expect(result[0].boardId).toBe('board-1');
    expect(result[0].name).toBe('Board 1');
  });

  test('listBoards returns empty array when no boards', async () => {
    mockClient.get.mockResolvedValue({ entities: [] });
    const result = await api.listBoards();
    expect(result).toEqual([]);
  });

  test('listBoards returns empty array when entities missing', async () => {
    mockClient.get.mockResolvedValue({});
    const result = await api.listBoards();
    expect(result).toEqual([]);
  });

  test('listBoards uses default limit of 50', async () => {
    mockClient.get.mockResolvedValue({ entities: [] });
    await api.listBoards();
    expect(mockClient.get).toHaveBeenCalledWith('/widgets', { params: { limit: 50 } });
  });

  test('listBoards passes custom limit', async () => {
    mockClient.get.mockResolvedValue({ entities: [] });
    await api.listBoards(100);
    expect(mockClient.get).toHaveBeenCalledWith('/widgets', { params: { limit: 100 } });
  });

  test('listBoards returns multiple boards', async () => {
    const boards = [
      { widgetCommonId: 'b1', name: 'Board 1', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      { widgetCommonId: 'b2', name: 'Board 2', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      { widgetCommonId: 'b3', name: 'Board 3', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    ];
    mockClient.get.mockResolvedValue({ entities: boards });
    const result = await api.listBoards();
    expect(result).toHaveLength(3);
  });

  test('listBoards propagates API errors', async () => {
    mockClient.get.mockRejectedValue(new Error('Network error'));
    await expect(api.listBoards()).rejects.toThrow('Network error');
  });

  test('listBoards propagates rate limit errors', async () => {
    const rateLimitError = Object.assign(new Error('Too Many Requests'), { response: { status: 429 } });
    mockClient.get.mockRejectedValue(rateLimitError);
    await expect(api.listBoards()).rejects.toThrow('Too Many Requests');
  });

  // --- getBoard ---

  test('getBoard fetches single board', async () => {
    mockClient.get.mockResolvedValue(sampleBoard);
    const result = await api.getBoard('board-1');
    expect(result.name).toBe('Board 1');
    expect(mockClient.get).toHaveBeenCalledWith('/widgets/board-1');
  });

  test('getBoard propagates 404 error', async () => {
    mockClient.get.mockRejectedValue(new Error('Not found'));
    await expect(api.getBoard('bad-id')).rejects.toThrow('Not found');
  });

  // --- getBoardWithIncludes ---

  test('getBoardWithIncludes fetches board without includes', async () => {
    mockClient.get.mockResolvedValue(sampleBoard);
    const result = await api.getBoardWithIncludes('board-1');
    expect(result.boardId).toBe('board-1');
    expect(mockClient.get).toHaveBeenCalledWith('/widgets/board-1', { params: {} });
  });

  test('getBoardWithIncludes passes include parameter', async () => {
    const extendedBoard = {
      ...sampleBoard,
      members: [{ userId: 'u1', name: 'Alice' }],
      customFields: [{ fieldId: 'f1', name: 'Priority', type: 'select', options: ['High', 'Low'] }],
    };
    mockClient.get.mockResolvedValue(extendedBoard);
    const result = await api.getBoardWithIncludes('board-1', ['members', 'custom-fields']);
    expect(result.members).toHaveLength(1);
    expect(result.customFields).toHaveLength(1);
    expect(mockClient.get).toHaveBeenCalledWith('/widgets/board-1', {
      params: { include: 'members,custom-fields' },
    });
  });

  // This test used to hand the widget a hand-written three-card `cards` array and
  // assert the counts derived from it — the fixture that let the printed zeros
  // ship, since `GET /widgets/{id}?include=cards` was measured on 2026-08-12 to
  // return no `cards` key at all. The wire arm now lives in
  // `board-stats-wire.test.ts` against a real server; what is left here is the
  // shape contract, asserted through a mock that no longer claims a field Favro
  // does not send.
  test('getBoardWithIncludes reports every card-derived stat unknown, never zero', async () => {
    mockClient.get.mockResolvedValue(sampleBoard);
    const result = await api.getBoardWithIncludes('board-1', ['stats']);
    expect(result.stats).toEqual({
      totalCards: null,
      doneCards: null,
      openCards: null,
      overdueCards: null,
    });
    expect(result.unmeasured).toContain('unknown, not zero');
  });

  test('getBoardWithIncludes names the four weeks and reports each unknown', async () => {
    mockClient.get.mockResolvedValue(sampleBoard);
    const result = await api.getBoardWithIncludes('board-1', ['velocity']);
    expect(result.velocity).toHaveLength(4); // 4 weeks
    for (const week of result.velocity!) {
      expect(week.period).toMatch(/^\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/);
      expect(week.completed).toBeNull();
      expect(week.added).toBeNull();
      expect(week.netChange).toBeNull();
    }
  });

  test('getBoardWithIncludes computes both stats and velocity', async () => {
    mockClient.get.mockResolvedValue(sampleBoard);
    const result = await api.getBoardWithIncludes('board-1', ['stats', 'velocity']);
    expect(result.stats).toBeDefined();
    expect(result.velocity).toBeDefined();
  });

  test('getBoardWithIncludes attaches neither facet, nor a note, when neither was asked for', async () => {
    mockClient.get.mockResolvedValue(sampleBoard);
    const result = await api.getBoardWithIncludes('board-1', ['members']);
    expect(result.stats).toBeUndefined();
    expect(result.velocity).toBeUndefined();
    expect(result.unmeasured).toBeUndefined();
  });

  // --- listBoardsByCollection ---
  //
  // The collection argument is resolved against `/collections` before the
  // widgets call, so these mocks answer both endpoints. Resolution is what makes
  // an unknown collection a refusal instead of a plausible empty page.

  function mockCollectionAnd(widgets: unknown[]) {
    mockClient.get.mockImplementation(async (url: string) => {
      if (url === '/collections') return { entities: [sampleCollection] };
      return { entities: widgets };
    });
  }

  test('listBoardsByCollection queries with collectionId', async () => {
    mockCollectionAnd([sampleBoard]);
    const result = await api.listBoardsByCollection('coll-1');
    expect(result).toHaveLength(1);
    expect(mockClient.get).toHaveBeenCalledWith('/widgets', expect.objectContaining({
      params: expect.objectContaining({ collectionId: 'coll-1' }),
    }));
  });

  test('listBoardsByCollection resolves an exact collection name to its id', async () => {
    mockCollectionAnd([sampleBoard]);
    await api.listBoardsByCollection('  collection 1  ');
    expect(mockClient.get).toHaveBeenCalledWith('/widgets', expect.objectContaining({
      params: expect.objectContaining({ collectionId: 'coll-1' }),
    }));
  });

  test('listBoardsByCollection refuses an unknown collection before calling /widgets', async () => {
    mockCollectionAnd([sampleBoard]);
    await expect(api.listBoardsByCollection('Ghost')).rejects.toThrow(
      /missing or not visible to your key/
    );
    expect(mockClient.get).not.toHaveBeenCalledWith('/widgets', expect.anything());
  });

  test('listBoardsByCollection with include stats adds stats to each board', async () => {
    mockCollectionAnd([sampleBoard]);
    const result = await api.listBoardsByCollection('coll-1', ['stats']);
    // The list read carries no cards on any wire, so every facet is unknown here
    // and `toBeDefined()` — which `null` satisfies — was not asking anything.
    expect(result[0].stats).toEqual({
      totalCards: null,
      doneCards: null,
      openCards: null,
      overdueCards: null,
    });
    expect(result[0].unmeasured).toContain('unknown, not zero');
  });

  test('listBoardsByCollection with include velocity adds velocity to each board', async () => {
    mockCollectionAnd([sampleBoard]);
    const result = await api.listBoardsByCollection('coll-1', ['velocity']);
    expect(result[0].velocity).toHaveLength(4);
    expect(result[0].velocity!.every(v => v.completed === null)).toBe(true);
  });

  test('listBoardsByCollection with include stats,velocity adds both', async () => {
    mockCollectionAnd([sampleBoard]);
    const result = await api.listBoardsByCollection('coll-1', ['stats', 'velocity']);
    expect(result[0].stats).toBeDefined();
    expect(result[0].velocity).toBeDefined();
  });

  test('listBoardsByCollection returns empty array for a collection with no boards', async () => {
    mockCollectionAnd([]);
    const result = await api.listBoardsByCollection('coll-1');
    expect(result).toEqual([]);
  });

  // --- createBoardInCollection ---

  test('createBoardInCollection posts with collectionId', async () => {
    const newBoard = { ...sampleBoard, widgetCommonId: 'new-board', type: 'board' as any };
    mockClient.post.mockResolvedValue(newBoard);
    const result = await api.createBoardInCollection('coll-1', { name: 'New Board', type: 'board' });
    expect(result.boardId).toBe('new-board');
    expect(mockClient.post).toHaveBeenCalledWith('/widgets', {
      name: 'New Board',
      type: 'board',
      collectionId: 'coll-1',
    });
  });

  test('createBoardInCollection with kanban type', async () => {
    mockClient.post.mockResolvedValue(sampleBoard);
    await api.createBoardInCollection('coll-1', { name: 'Kanban', type: 'kanban' });
    expect(mockClient.post).toHaveBeenCalledWith('/widgets', expect.objectContaining({ type: 'kanban' }));
  });

  test('createBoardInCollection with list type', async () => {
    mockClient.post.mockResolvedValue(sampleBoard);
    await api.createBoardInCollection('coll-1', { name: 'List', type: 'list' });
    expect(mockClient.post).toHaveBeenCalledWith('/widgets', expect.objectContaining({ type: 'list' }));
  });

  test('createBoardInCollection with description', async () => {
    mockClient.post.mockResolvedValue(sampleBoard);
    await api.createBoardInCollection('coll-1', { name: 'Board', description: 'My desc' });
    expect(mockClient.post).toHaveBeenCalledWith('/widgets', expect.objectContaining({
      description: 'My desc',
    }));
  });

  // --- createBoard ---

  test('createBoard posts data to /boards', async () => {
    mockClient.post.mockResolvedValue(sampleBoard);
    const result = await api.createBoard({ name: 'New Board' });
    expect(result.name).toBe('Board 1');
    expect(mockClient.post).toHaveBeenCalledWith('/widgets', { name: 'New Board' });
  });

  test('createBoard with description and collectionId', async () => {
    mockClient.post.mockResolvedValue(sampleBoard);
    await api.createBoard({ name: 'Board', description: 'Desc', collectionId: 'coll-1' });
    expect(mockClient.post).toHaveBeenCalledWith('/widgets', {
      name: 'Board', description: 'Desc', collectionId: 'coll-1'
    });
  });

  // --- updateBoard ---

  test('updateBoard patches board', async () => {
    const updated = { ...sampleBoard, name: 'Updated Board' };
    mockClient.put.mockResolvedValue(updated);
    const result = await api.updateBoard('board-1', { name: 'Updated Board' });
    expect(result.name).toBe('Updated Board');
    expect(mockClient.put).toHaveBeenCalledWith('/widgets/board-1', { name: 'Updated Board' });
  });

  test('updateBoard with description', async () => {
    mockClient.put.mockResolvedValue(sampleBoard);
    await api.updateBoard('board-1', { description: 'New desc' });
    expect(mockClient.put).toHaveBeenCalledWith('/widgets/board-1', { description: 'New desc' });
  });

  test('updateBoard with both name and description', async () => {
    mockClient.put.mockResolvedValue(sampleBoard);
    await api.updateBoard('board-1', { name: 'New', description: 'Desc' });
    expect(mockClient.put).toHaveBeenCalledWith('/widgets/board-1', { name: 'New', description: 'Desc' });
  });

  // --- deleteBoard ---

  test('deleteBoard calls DELETE', async () => {
    mockClient.delete.mockResolvedValue(undefined);
    await api.deleteBoard('board-1');
    expect(mockClient.delete).toHaveBeenCalledWith('/widgets/board-1');
  });

  // --- Collection filter on boards ---

  test('can filter boards by collectionId client-side', async () => {
    const boards = [
      { widgetCommonId: 'b1', name: 'Board 1', collectionIds: ['coll-A'], createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      { widgetCommonId: 'b2', name: 'Board 2', collectionIds: ['coll-B'], createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      { widgetCommonId: 'b3', name: 'Board 3', collectionIds: ['coll-A'], createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    ];
    mockClient.get.mockResolvedValue({ entities: boards });
    const result = await api.listBoards();
    const filtered = result.filter(b => b.collectionId === 'coll-A');
    expect(filtered).toHaveLength(2);
  });
});

describe('aggregateBoardStats', () => {
  const baseBoard: ExtendedBoard = {
    boardId: 'b1',
    name: 'Test',
    cardCount: 5,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };

  test('computes stats from cards array', () => {
    const cards = [
      { status: 'Done' },
      { status: 'Done' },
      { status: 'In Progress' },
      { status: 'Todo' },
    ];
    const stats = aggregateBoardStats(baseBoard, cards as any);
    expect(stats.totalCards).toBe(4);
    expect(stats.doneCards).toBe(2);
    expect(stats.openCards).toBe(2);
  });

  test('counts completed status as done', () => {
    const cards = [{ status: 'completed' }, { status: 'In Progress' }];
    const stats = aggregateBoardStats(baseBoard, cards as any);
    expect(stats.doneCards).toBe(1);
  });

  // A `cardCount` on the board is a total, not a split. It answers `totalCards`
  // and nothing else — reporting it as `openCards` asserts that no card on the
  // board is finished, which nothing measured.
  test('uses board cardCount for the total only, and reports the split unknown', () => {
    const stats = aggregateBoardStats(baseBoard);
    expect(stats.totalCards).toBe(5);
    expect(stats.openCards).toBeNull();
    expect(stats.doneCards).toBeNull();
    expect(stats.overdueCards).toBeNull();
  });

  test('reports unknown, not zero, when the board has no cardCount and no cards', () => {
    const board: ExtendedBoard = { boardId: 'b', name: 'B', createdAt: '', updatedAt: '' };
    const stats = aggregateBoardStats(board);
    expect(stats).toEqual({
      totalCards: null,
      doneCards: null,
      openCards: null,
      overdueCards: null,
    });
  });

  test('counts overdue cards (past due, not done)', () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString(); // yesterday
    const cards = [
      { status: 'In Progress', dueDate: pastDate },
      { status: 'Done', dueDate: pastDate },
      { status: 'Todo' },
    ];
    const stats = aggregateBoardStats(baseBoard, cards as any);
    expect(stats.overdueCards).toBe(1);
  });

  test('does not count done cards as overdue', () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    const cards = [{ status: 'Done', dueDate: pastDate }];
    const stats = aggregateBoardStats(baseBoard, cards as any);
    expect(stats.overdueCards).toBe(0);
  });
});

describe('calculateVelocity', () => {
  test('returns 4 weekly periods', () => {
    const velocity = calculateVelocity();
    expect(velocity).toHaveLength(4);
  });

  test('returns unknown velocity, not zero velocity, when no cards', () => {
    const velocity = calculateVelocity([]);
    expect(velocity.every(v => v.completed === null)).toBe(true);
  });

  test('returns unknown velocity when cards is undefined', () => {
    const velocity = calculateVelocity(undefined);
    expect(velocity.every(v => v.completed === null)).toBe(true);
  });

  // `added` has never had a source: no board path reads a card's creation date.
  // It was the literal `0`, and `netChange: completed` therefore asserted it.
  test('reports added and netChange unknown even when completions are counted', () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const velocity = calculateVelocity([{ status: 'Done', updatedAt: yesterday }] as any);
    const latest = velocity[velocity.length - 1];
    expect(latest.completed).toBe(1);
    expect(latest.added).toBeNull();
    expect(latest.netChange).toBeNull();
  });

  test('each period has correct structure', () => {
    const velocity = calculateVelocity();
    for (const v of velocity) {
      expect(v).toHaveProperty('period');
      expect(v).toHaveProperty('completed');
      expect(v).toHaveProperty('added');
      expect(v).toHaveProperty('netChange');
      expect(typeof v.period).toBe('string');
      // `number | null`, and with no cards it is `null` — a `number` assertion
      // here was what made "0 completed" look like a measured figure.
      expect(v.completed).toBeNull();
    }
  });

  test('counts recently completed cards in velocity', () => {
    // Card completed yesterday (within last week)
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const cards = [
      { status: 'Done', updatedAt: yesterday },
      { status: 'In Progress', updatedAt: yesterday },
    ];
    const velocity = calculateVelocity(cards as any);
    // Latest week should have at least 1 completed
    const latestWeek = velocity[velocity.length - 1];
    expect(latestWeek.completed).toBeGreaterThanOrEqual(1);
  });
});

/**
 * Both counters route through the ONE done judge (#157).
 *
 * `aggregateBoardStats` and `calculateVelocity` each carried their own exact
 * `status === 'done' || === 'completed'` test — the two judges #98's census of
 * eight missed and ADR-0005 recorded as knowingly left behind. `status` IS the
 * column name (Favro has no status field), so the judgement is
 * `isDoneStage(detectStage(status))`, the same composition `isCompleted` performs.
 *
 * WHY THE ARMS BELOW ARE SHAPED LIKE THIS. A *counter* fed a fixture where every
 * card is done — or none is — cannot tell a real judge from `() => true` or
 * `() => false`; it reports the array length or zero either way. So every arm
 * here carries cards on **both** sides plus one that is neither, and asserts
 * `doneCards`, `openCards` and `totalCards` together so a constant judge fails a
 * named assertion instead of coincidentally matching one field.
 *
 * The date fixtures are built RELATIVE TO NOW on purpose. `overdueCards` and
 * `calculateVelocity` both compare against an uncontrollable "today", and a
 * fixture straddling it asserted with `toBeGreaterThanOrEqual` passes for both a
 * real judge and a stub. Every date below is a fixed offset from `Date.now()`
 * with a card on each side of every boundary.
 */
describe('boards-api counts done through the one judge (#157)', () => {
  const board: ExtendedBoard = {
    boardId: 'b1',
    name: 'Test',
    cardCount: 99,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
  const stats = (cards: Array<{ status?: string; dueDate?: string }>) =>
    aggregateBoardStats(board, cards as any);

  // --- doneCards / openCards -------------------------------------------------

  // The widening, one name at a time, each against a fixture that also holds an
  // open card and a card with no status. `doneCards: 1` of 3 kills `() => true`;
  // `openCards: 2` kills `() => false`.
  it.each([
    'Klar',
    'Färdig',
    'Avslutad',
    'Approved',
    'Archived',
    'Closed',
    'Released',
    'Shipped',
    'Deployed',
    'Done ✅',
    'Resolved',
  ])('counts a card in the `%s` column as done, which the exact test did not', (name) => {
    const s = stats([{ status: name }, { status: 'In Progress' }, {}]);
    expect(s.doneCards).toBe(1);
    expect(s.openCards).toBe(2);
    expect(s.totalCards).toBe(3);
  });

  // The foreign arm. Nothing unfinished may count, and the fixture holds a real
  // done card so a `() => false` judge cannot pass by reporting zero.
  it.each(['Backlog', 'To Do', 'Doing', 'In Progress', 'In Review', 'Testing', 'Unresolved'])(
    'still counts a card in the `%s` column as open',
    (name) => {
      const s = stats([{ status: name }, { status: 'Klar' }]);
      expect(s.doneCards).toBe(1);
      expect(s.openCards).toBe(1);
    },
  );

  // The omit arm. A card Favro sent no column for is not finished — `detectStage`
  // falls through to `queued` rather than throwing.
  it('does not count a card with no status as done', () => {
    const s = stats([{}, { status: '' }, { status: 'Done' }]);
    expect(s.doneCards).toBe(1);
    expect(s.openCards).toBe(2);
  });

  // What the exact test already got right, unchanged.
  it.each(['Done', 'done', 'Completed', 'completed'])('keeps `%s` done', (name) => {
    const s = stats([{ status: name }, { status: 'Todo' }]);
    expect(s.doneCards).toBe(1);
    expect(s.openCards).toBe(1);
  });

  // --- overdueCards ----------------------------------------------------------

  const PAST = new Date(Date.now() - 86_400_000).toISOString();
  const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

  // The narrowing, stated as a count rather than left to be discovered. All four
  // cards are past due; only the two open ones are overdue.
  it('excludes a widened-done card from overdue, and only that card', () => {
    const s = stats([
      { status: 'In Progress', dueDate: PAST },
      { status: 'Backlog', dueDate: PAST },
      { status: 'Klar', dueDate: PAST },
      { status: 'Approved', dueDate: PAST },
    ]);
    expect(s.overdueCards).toBe(2);
    expect(s.doneCards).toBe(2);
  });

  // The old overdue conjunct was `!== 'done'`, which did not even exclude
  // `completed` — a past-due card in a `Completed` column counted as done AND
  // overdue at once. It now counts as neither.
  it('no longer counts a past-due `Completed` card as overdue', () => {
    const s = stats([{ status: 'Completed', dueDate: PAST }, { status: 'Todo', dueDate: PAST }]);
    expect(s.overdueCards).toBe(1);
    expect(s.doneCards).toBe(1);
  });

  // The `dueDate < now` conjunct, with a card on each side of now. Deleting the
  // comparison makes the future card overdue too.
  it('does not count a future due date as overdue', () => {
    const s = stats([{ status: 'Todo', dueDate: FUTURE }, { status: 'Todo', dueDate: PAST }]);
    expect(s.overdueCards).toBe(1);
  });

  // --- velocity.completed ----------------------------------------------------

  // Inside the newest week, with an open card and a status-less card alongside,
  // so the count discriminates the judge rather than the array length.
  it.each(['Klar', 'Färdig', 'Approved', 'Archived', 'Shipped', 'Closed'])(
    'counts a `%s` card in this week\'s velocity, which the exact test did not',
    (name) => {
      const yesterday = new Date(Date.now() - 86_400_000).toISOString();
      const velocity = calculateVelocity([
        { status: name, updatedAt: yesterday },
        { status: 'In Progress', updatedAt: yesterday },
        { updatedAt: yesterday },
      ] as any);
      expect(velocity[velocity.length - 1].completed).toBe(1);
      // `netChange` is null now, not `completed`: nothing measures cards ADDED in
      // a period, so a net cannot be taken. The arm keeps its second assertion by
      // reading the other side of the count instead.
      expect(velocity[velocity.length - 1].netChange).toBeNull();
      expect(velocity.reduce((n, v) => n + (v.completed ?? 0), 0)).toBe(1);
    },
  );

  it.each(['Backlog', 'In Progress', 'Testing', 'Unresolved'])(
    'keeps a `%s` card out of velocity',
    (name) => {
      const yesterday = new Date(Date.now() - 86_400_000).toISOString();
      const velocity = calculateVelocity([
        { status: name, updatedAt: yesterday },
        { status: 'Klar', updatedAt: yesterday },
      ] as any);
      expect(velocity[velocity.length - 1].completed).toBe(1);
    },
  );

  // The two window conjuncts, each with a done card outside it. Deleting either
  // comparison pulls one of these into the newest week's count.
  it('counts a done card only in the week it was updated', () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const fiveWeeksAgo = new Date(Date.now() - 35 * 86_400_000).toISOString();
    const nextWeek = new Date(Date.now() + 8 * 86_400_000).toISOString();
    const velocity = calculateVelocity([
      { status: 'Klar', updatedAt: yesterday },
      { status: 'Klar', updatedAt: fiveWeeksAgo },
      { status: 'Klar', updatedAt: nextWeek },
    ] as any);
    expect(velocity[velocity.length - 1].completed).toBe(1);
    expect(velocity.reduce((n, v) => n + (v.completed ?? 0), 0)).toBe(1);
  });

  it('does not count a done card with no updatedAt', () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const velocity = calculateVelocity([
      { status: 'Klar' },
      { status: 'Klar', updatedAt: yesterday },
    ] as any);
    expect(velocity.reduce((n, v) => n + (v.completed ?? 0), 0)).toBe(1);
  });

  // --- what an UNHYDRATED card would do to these counters --------------------
  //
  // Every arm above hands these counters a card with a column NAME on `status`.
  // Favro sends no `status` field — the column is the status, and the name is
  // filled in by `CardsAPI.hydrateNames` from `columnId` (`cards-api.ts`
  // normalizeCard, CONTEXT.md "column-as-status"). A card handed over raw
  // therefore reads as never-finished, whatever column it is really in.
  //
  // No board path reaches here at all any more: `/widgets/{id}?include=cards` was
  // measured (2026-08-12) to return no `cards` key, so `withBoardIncludes` takes
  // the unknown branch and nothing calls this branch with cards. The arm is kept
  // because the branch is still live code for the first caller that does hydrate,
  // and it states the trap that caller must avoid — pass raw wire cards and every
  // count here is wrong rather than unknown, which is worse than the zeros this
  // batch removed.
  it('reads a RAW wire card — columnId, no status — as open, which is why a caller must hydrate first', () => {
    const raw = [
      { columnId: 'col-klar', dueDate: PAST },
      { columnId: 'col-pagar', dueDate: PAST },
      { columnId: 'col-klar' },
    ];
    const s = stats(raw as any);
    expect(s.totalCards).toBe(3);
    expect(s.doneCards).toBe(0);
    expect(s.openCards).toBe(3);
    expect(s.overdueCards).toBe(2);

    const velocity = calculateVelocity(
      raw.map(c => ({ ...c, updatedAt: new Date(Date.now() - 86_400_000).toISOString() })) as any,
    );
    expect(velocity.reduce((n, v) => n + (v.completed ?? 0), 0)).toBe(0);
  });
});
