import CardsAPI from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';

describe('Cards API', () => {
  let api: CardsAPI;
  let mockClient: any;

  beforeEach(() => {
    mockClient = { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() };
    api = new CardsAPI(mockClient as FavroHttpClient);
  });

  test('listCards returns array', async () => {
    mockClient.get.mockResolvedValue({ entities: [{ cardId: '1', name: 'Task 1', createdAt: '2026-01-01', updatedAt: '2026-01-01' }] });
    const result = await api.listCards('board-1');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Task 1');
  });

  test('createCard posts data', async () => {
    const card = { cardId: '2', name: 'New', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
    mockClient.post.mockResolvedValue(card);
    const result = await api.createCard({ name: 'New' });
    expect(result.name).toBe('New');
  });
});
