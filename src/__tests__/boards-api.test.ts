/**
 * Comprehensive tests for BoardsAPI and boards list command
 * CLA-1774: Unit Tests — All Commands
 * CLA-1784: Advanced Boards Endpoints
 */
import BoardsAPI, {
  Board,
  Collection,
  ExtendedBoard,
  aggregateBoardStats,
  calculateVelocity,
} from '../lib/boards-api';
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

  test('getBoardWithIncludes computes stats when requested', async () => {
    const boardWithCards = {
      ...sampleBoard,
      cardCount: 3,
      cards: [
        { status: 'Done' },
        { status: 'In Progress' },
        { status: 'Todo' },
      ] as any,
    };
    mockClient.get.mockResolvedValue(boardWithCards);
    const result = await api.getBoardWithIncludes('board-1', ['stats']);
    expect(result.stats).toBeDefined();
    expect(result.stats!.totalCards).toBe(3);
    expect(result.stats!.doneCards).toBe(1);
    expect(result.stats!.openCards).toBe(2);
  });

  test('getBoardWithIncludes computes velocity when requested', async () => {
    mockClient.get.mockResolvedValue(sampleBoard);
    const result = await api.getBoardWithIncludes('board-1', ['velocity']);
    expect(result.velocity).toBeDefined();
    expect(result.velocity!.length).toBe(4); // 4 weeks
  });

  test('getBoardWithIncludes computes both stats and velocity', async () => {
    mockClient.get.mockResolvedValue(sampleBoard);
    const result = await api.getBoardWithIncludes('board-1', ['stats', 'velocity']);
    expect(result.stats).toBeDefined();
    expect(result.velocity).toBeDefined();
  });

  // --- listBoardsByCollection ---

  test('listBoardsByCollection queries with collectionId', async () => {
    mockClient.get.mockResolvedValue({ entities: [sampleBoard] });
    const result = await api.listBoardsByCollection('coll-1');
    expect(result).toHaveLength(1);
    expect(mockClient.get).toHaveBeenCalledWith('/widgets', expect.objectContaining({
      params: expect.objectContaining({ collectionId: 'coll-1' }),
    }));
  });

  test('listBoardsByCollection with include stats adds stats to each board', async () => {
    mockClient.get.mockResolvedValue({ entities: [sampleBoard] });
    const result = await api.listBoardsByCollection('coll-1', ['stats']);
    expect(result[0].stats).toBeDefined();
    expect(result[0].stats!.totalCards).toBeDefined();
  });

  test('listBoardsByCollection with include velocity adds velocity to each board', async () => {
    mockClient.get.mockResolvedValue({ entities: [sampleBoard] });
    const result = await api.listBoardsByCollection('coll-1', ['velocity']);
    expect(result[0].velocity).toBeDefined();
    expect(result[0].velocity!.length).toBe(4);
  });

  test('listBoardsByCollection with include stats,velocity adds both', async () => {
    mockClient.get.mockResolvedValue({ entities: [sampleBoard] });
    const result = await api.listBoardsByCollection('coll-1', ['stats', 'velocity']);
    expect(result[0].stats).toBeDefined();
    expect(result[0].velocity).toBeDefined();
  });

  test('listBoardsByCollection returns empty array for empty collection', async () => {
    mockClient.get.mockResolvedValue({ entities: [] });
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

  // --- listCollections ---

  test('listCollections returns array', async () => {
    mockClient.get.mockResolvedValue({ entities: [sampleCollection] });
    const result = await api.listCollections();
    expect(result).toHaveLength(1);
    expect(result[0].collectionId).toBe('coll-1');
  });

  test('listCollections returns empty array when none', async () => {
    mockClient.get.mockResolvedValue({ entities: [] });
    const result = await api.listCollections();
    expect(result).toEqual([]);
  });

  test('listCollections returns empty array when entities missing', async () => {
    mockClient.get.mockResolvedValue({});
    const result = await api.listCollections();
    expect(result).toEqual([]);
  });

  test('listCollections uses default limit', async () => {
    mockClient.get.mockResolvedValue({ entities: [] });
    await api.listCollections();
    expect(mockClient.get).toHaveBeenCalledWith('/collections', { params: { limit: 50 } });
  });

  test('listCollections passes custom limit', async () => {
    mockClient.get.mockResolvedValue({ entities: [] });
    await api.listCollections(25);
    expect(mockClient.get).toHaveBeenCalledWith('/collections', { params: { limit: 25 } });
  });

  // --- getCollection ---

  test('getCollection fetches single collection', async () => {
    mockClient.get.mockResolvedValue(sampleCollection);
    const result = await api.getCollection('coll-1');
    expect(result.name).toBe('Collection 1');
    expect(mockClient.get).toHaveBeenCalledWith('/collections/coll-1');
  });

  // --- createCollection ---

  test('createCollection posts data', async () => {
    mockClient.post.mockResolvedValue(sampleCollection);
    const result = await api.createCollection({ name: 'My Collection' });
    expect(result.collectionId).toBe('coll-1');
    expect(mockClient.post).toHaveBeenCalledWith('/collections', { name: 'My Collection' });
  });

  // --- updateCollection ---

  test('updateCollection patches collection', async () => {
    const updated = { ...sampleCollection, name: 'Updated Collection' };
    mockClient.patch.mockResolvedValue(updated);
    const result = await api.updateCollection('coll-1', { name: 'Updated Collection' });
    expect(result.name).toBe('Updated Collection');
    expect(mockClient.patch).toHaveBeenCalledWith('/collections/coll-1', { name: 'Updated Collection' });
  });

  // --- deleteCollection ---

  test('deleteCollection calls DELETE', async () => {
    mockClient.delete.mockResolvedValue(undefined);
    await api.deleteCollection('coll-1');
    expect(mockClient.delete).toHaveBeenCalledWith('/collections/coll-1');
  });

  // --- addBoardToCollection ---

  test('addBoardToCollection posts link', async () => {
    mockClient.post.mockResolvedValue(sampleCollection);
    await api.addBoardToCollection('coll-1', 'board-1');
    expect(mockClient.post).toHaveBeenCalledWith('/collections/coll-1/boards/board-1', {});
  });

  // --- removeBoardFromCollection ---

  test('removeBoardFromCollection calls DELETE', async () => {
    mockClient.delete.mockResolvedValue(undefined);
    await api.removeBoardFromCollection('coll-1', 'board-1');
    expect(mockClient.delete).toHaveBeenCalledWith('/collections/coll-1/boards/board-1');
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

  test('falls back to board cardCount when no cards', () => {
    const stats = aggregateBoardStats(baseBoard);
    expect(stats.totalCards).toBe(5);
    expect(stats.openCards).toBe(5);
    expect(stats.doneCards).toBe(0);
  });

  test('returns zeros when board has no cardCount and no cards', () => {
    const board: ExtendedBoard = { boardId: 'b', name: 'B', createdAt: '', updatedAt: '' };
    const stats = aggregateBoardStats(board);
    expect(stats.totalCards).toBe(0);
    expect(stats.doneCards).toBe(0);
    expect(stats.openCards).toBe(0);
    expect(stats.overdueCards).toBe(0);
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

  test('returns zero velocity when no cards', () => {
    const velocity = calculateVelocity([]);
    expect(velocity.every(v => v.completed === 0)).toBe(true);
  });

  test('returns zero velocity when cards is undefined', () => {
    const velocity = calculateVelocity(undefined);
    expect(velocity.every(v => v.completed === 0)).toBe(true);
  });

  test('each period has correct structure', () => {
    const velocity = calculateVelocity();
    for (const v of velocity) {
      expect(v).toHaveProperty('period');
      expect(v).toHaveProperty('completed');
      expect(v).toHaveProperty('added');
      expect(v).toHaveProperty('netChange');
      expect(typeof v.period).toBe('string');
      expect(typeof v.completed).toBe('number');
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
