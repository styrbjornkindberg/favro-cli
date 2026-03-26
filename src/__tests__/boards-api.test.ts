/**
 * Comprehensive tests for BoardsAPI and boards list command
 * CLA-1774: Unit Tests — All Commands
 */
import BoardsAPI, { Board, Collection } from '../lib/boards-api';
import FavroHttpClient from '../lib/http-client';

describe('Boards API', () => {
  let api: BoardsAPI;
  let mockClient: jest.Mocked<Pick<FavroHttpClient, 'get' | 'post' | 'patch' | 'delete'>>;

  const sampleBoard: Board = {
    boardId: 'board-1',
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
    expect(mockClient.get).toHaveBeenCalledWith('/boards', { params: { limit: 50 } });
  });

  test('listBoards passes custom limit', async () => {
    mockClient.get.mockResolvedValue({ entities: [] });
    await api.listBoards(100);
    expect(mockClient.get).toHaveBeenCalledWith('/boards', { params: { limit: 100 } });
  });

  test('listBoards returns multiple boards', async () => {
    const boards = [
      { boardId: 'b1', name: 'Board 1', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      { boardId: 'b2', name: 'Board 2', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      { boardId: 'b3', name: 'Board 3', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
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
    expect(mockClient.get).toHaveBeenCalledWith('/boards/board-1');
  });

  test('getBoard propagates 404 error', async () => {
    mockClient.get.mockRejectedValue(new Error('Not found'));
    await expect(api.getBoard('bad-id')).rejects.toThrow('Not found');
  });

  // --- createBoard ---

  test('createBoard posts data to /boards', async () => {
    mockClient.post.mockResolvedValue(sampleBoard);
    const result = await api.createBoard({ name: 'New Board' });
    expect(result.name).toBe('Board 1');
    expect(mockClient.post).toHaveBeenCalledWith('/boards', { name: 'New Board' });
  });

  test('createBoard with description and collectionId', async () => {
    mockClient.post.mockResolvedValue(sampleBoard);
    await api.createBoard({ name: 'Board', description: 'Desc', collectionId: 'coll-1' });
    expect(mockClient.post).toHaveBeenCalledWith('/boards', {
      name: 'Board', description: 'Desc', collectionId: 'coll-1'
    });
  });

  // --- updateBoard ---

  test('updateBoard patches board', async () => {
    const updated = { ...sampleBoard, name: 'Updated Board' };
    mockClient.patch.mockResolvedValue(updated);
    const result = await api.updateBoard('board-1', { name: 'Updated Board' });
    expect(result.name).toBe('Updated Board');
    expect(mockClient.patch).toHaveBeenCalledWith('/boards/board-1', { name: 'Updated Board' });
  });

  // --- deleteBoard ---

  test('deleteBoard calls DELETE', async () => {
    mockClient.delete.mockResolvedValue(undefined);
    await api.deleteBoard('board-1');
    expect(mockClient.delete).toHaveBeenCalledWith('/boards/board-1');
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
    const result = await api.addBoardToCollection('coll-1', 'board-1');
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
      { boardId: 'b1', name: 'Board 1', collectionId: 'coll-A', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      { boardId: 'b2', name: 'Board 2', collectionId: 'coll-B', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      { boardId: 'b3', name: 'Board 3', collectionId: 'coll-A', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    ];
    mockClient.get.mockResolvedValue({ entities: boards });
    const result = await api.listBoards();
    const filtered = result.filter(b => b.collectionId === 'coll-A');
    expect(filtered).toHaveLength(2);
  });
});
