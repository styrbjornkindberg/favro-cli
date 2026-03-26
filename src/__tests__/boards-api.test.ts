import BoardsAPI from '../lib/boards-api';
import FavroHttpClient from '../lib/http-client';

describe('Boards API', () => {
  let api: BoardsAPI;
  let mockClient: any;

  beforeEach(() => {
    mockClient = { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() };
    api = new BoardsAPI(mockClient as FavroHttpClient);
  });

  test('listBoards returns array', async () => {
    mockClient.get.mockResolvedValue({ entities: [{ boardId: '1', name: 'Board 1', createdAt: '2026-01-01', updatedAt: '2026-01-01' }] });
    const result = await api.listBoards();
    expect(result).toHaveLength(1);
  });

  test('getBoard fetches single board', async () => {
    const board = { boardId: '1', name: 'Board 1', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
    mockClient.get.mockResolvedValue(board);
    const result = await api.getBoard('1');
    expect(result.name).toBe('Board 1');
  });

  test('createBoard posts data', async () => {
    const board = { boardId: '2', name: 'New Board', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
    mockClient.post.mockResolvedValue(board);
    const result = await api.createBoard({ name: 'New Board' });
    expect(result.name).toBe('New Board');
  });

  test('listCollections returns array', async () => {
    mockClient.get.mockResolvedValue({ entities: [{ collectionId: '1', name: 'Coll 1', createdAt: '2026-01-01', updatedAt: '2026-01-01' }] });
    const result = await api.listCollections();
    expect(result).toHaveLength(1);
  });

  test('addBoardToCollection posts link', async () => {
    const coll = { collectionId: '1', name: 'Coll 1', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
    mockClient.post.mockResolvedValue(coll);
    const result = await api.addBoardToCollection('1', 'board-1');
    expect(mockClient.post).toHaveBeenCalled();
  });
});
