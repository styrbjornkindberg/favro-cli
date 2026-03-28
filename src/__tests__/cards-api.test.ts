/**
 * Comprehensive tests for CardsAPI
 * CLA-1774: Unit Tests — All Commands
 */
import CardsAPI from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';

describe('Cards API', () => {
  let api: CardsAPI;
  let mockClient: jest.Mocked<Pick<FavroHttpClient, 'get' | 'post' | 'patch' | 'delete'>>;

  beforeEach(() => {
    mockClient = {
      get: jest.fn(),
      post: jest.fn(),
      patch: jest.fn(),
      delete: jest.fn(),
    };
    api = new CardsAPI(mockClient as any);
  });

  // --- listCards ---

  test('listCards returns array of cards', async () => {
    mockClient.get.mockResolvedValue({
      entities: [
        { cardId: '1', name: 'Task 1', createdAt: '2026-01-01', updatedAt: '2026-01-01' }
      ]
    });
    const result = await api.listCards('board-1');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Task 1');
  });

  test('listCards with board id uses correct endpoint', async () => {
    mockClient.get.mockResolvedValue({ entities: [] });
    await api.listCards('board-xyz');
    expect(mockClient.get).toHaveBeenCalledWith('/boards/board-xyz/cards', expect.any(Object));
  });

  test('listCards without board id uses /cards endpoint', async () => {
    mockClient.get.mockResolvedValue({ entities: [] });
    await api.listCards(undefined);
    expect(mockClient.get).toHaveBeenCalledWith('/cards', expect.any(Object));
  });

  test('listCards with custom limit passes it to API', async () => {
    mockClient.get.mockResolvedValue({ entities: [] });
    await api.listCards('board-1', 100);
    expect(mockClient.get).toHaveBeenCalledWith(expect.any(String), { params: { limit: 100 } });
  });

  test('listCards returns empty array when entities missing', async () => {
    mockClient.get.mockResolvedValue({});
    const result = await api.listCards('board-1');
    expect(result).toEqual([]);
  });

  test('listCards returns 100+ cards without truncation', async () => {
    const bigList = Array.from({ length: 120 }, (_, i) => ({
      cardId: `card-${i}`, name: `Card ${i}`, createdAt: '2026-01-01', updatedAt: '2026-01-01'
    }));
    mockClient.get.mockResolvedValue({ entities: bigList });
    const result = await api.listCards('board-1', 120);
    expect(result).toHaveLength(120);
  });

  test('listCards propagates API errors', async () => {
    mockClient.get.mockRejectedValue(new Error('Network error'));
    await expect(api.listCards('board-1')).rejects.toThrow('Network error');
  });

  test('listCards fetches second page when pages > 1', async () => {
    const page0Cards = [
      { cardId: 'p0-1', name: 'Page0 Card1', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      { cardId: 'p0-2', name: 'Page0 Card2', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    ];
    const page1Cards = [
      { cardId: 'p1-1', name: 'Page1 Card1', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    ];

    mockClient.get
      .mockResolvedValueOnce({
        entities: page0Cards,
        requestId: 'req-abc-123',
        pages: 2,
        page: 0,
      })
      .mockResolvedValueOnce({
        entities: page1Cards,
        requestId: 'req-abc-123',
        pages: 2,
        page: 1,
      });

    const result = await api.listCards('board-1', 50);

    expect(result).toHaveLength(3);
    expect(result[0].cardId).toBe('p0-1');
    expect(result[2].cardId).toBe('p1-1');

    // Second call should include requestId and page params
    expect(mockClient.get).toHaveBeenCalledTimes(2);
    const secondCall = mockClient.get.mock.calls[1];
    expect(secondCall[1]).toEqual({ params: expect.objectContaining({ requestId: 'req-abc-123', page: 1 }) });
  });

  test('listCards stops fetching when entities is empty on a page', async () => {
    mockClient.get
      .mockResolvedValueOnce({
        entities: [{ cardId: 'c1', name: 'Card', createdAt: '2026-01-01', updatedAt: '2026-01-01' }],
        requestId: 'req-xyz',
        pages: 3,
        page: 0,
      })
      .mockResolvedValueOnce({
        entities: [],
        requestId: 'req-xyz',
        pages: 3,
        page: 1,
      });

    const result = await api.listCards('board-1', 50);

    // Should stop after empty page
    expect(mockClient.get).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
  });

  test('listCards stops at limit even with more pages available', async () => {
    const page0Cards = Array.from({ length: 5 }, (_, i) => ({
      cardId: `c${i}`, name: `Card ${i}`, createdAt: '2026-01-01', updatedAt: '2026-01-01'
    }));

    mockClient.get
      .mockResolvedValueOnce({
        entities: page0Cards,
        requestId: 'req-limit',
        pages: 10,
        page: 0,
      });

    // Request only 5 cards
    const result = await api.listCards('board-1', 5);

    // Should only make one request since we've hit the limit
    expect(mockClient.get).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(5);
  });

  test('listCards handles single-page response without requestId', async () => {
    const cards = [
      { cardId: 'single', name: 'Single Card', createdAt: '2026-01-01', updatedAt: '2026-01-01' }
    ];
    // Response without requestId = single page
    mockClient.get.mockResolvedValue({ entities: cards });

    const result = await api.listCards('board-1', 50);

    expect(mockClient.get).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
  });

  // --- getCard ---

  test('getCard fetches single card by id', async () => {
    const card = { cardId: 'card-1', name: 'Task', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
    mockClient.get.mockResolvedValue(card);
    const result = await api.getCard('card-1');
    expect(result.cardId).toBe('card-1');
    expect(mockClient.get).toHaveBeenCalledWith('/cards/card-1', undefined);
  });

  test('getCard propagates 404 errors', async () => {
    mockClient.get.mockRejectedValue(new Error('Not found'));
    await expect(api.getCard('bad-id')).rejects.toThrow('Not found');
  });

  test('getCard with include options passes include param', async () => {
    const card = { cardId: 'card-1', name: 'Task', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
    mockClient.get.mockResolvedValue(card);
    await api.getCard('card-1', { include: ['links', 'comments'] });
    expect(mockClient.get).toHaveBeenCalledWith('/cards/card-1', {
      params: { include: 'links,comments' },
    });
  });

  // --- linkCard ---

  test('linkCard posts to /cards/:id/links', async () => {
    const link = { linkId: 'lnk-1', type: 'depends-on', cardId: 'card-2' };
    mockClient.post.mockResolvedValue(link);
    const result = await api.linkCard('card-1', { toCardId: 'card-2', type: 'depends-on' });
    expect(result.linkId).toBe('lnk-1');
    expect(mockClient.post).toHaveBeenCalledWith('/cards/card-1/links', {
      toCardId: 'card-2',
      type: 'depends-on',
    });
  });

  test('linkCard propagates errors', async () => {
    mockClient.post.mockRejectedValue(new Error('Card not found'));
    await expect(api.linkCard('bad-id', { toCardId: 'other', type: 'related' })).rejects.toThrow('Card not found');
  });

  // --- getCardLinks ---

  test('getCardLinks fetches /cards/:id/links', async () => {
    const links = [{ linkId: 'lnk-1', type: 'depends-on', cardId: 'card-2' }];
    mockClient.get.mockResolvedValue({ entities: links });
    const result = await api.getCardLinks('card-1');
    expect(result).toEqual(links);
    expect(mockClient.get).toHaveBeenCalledWith('/cards/card-1/links');
  });

  test('getCardLinks returns empty array when entities missing', async () => {
    mockClient.get.mockResolvedValue({});
    const result = await api.getCardLinks('card-1');
    expect(result).toEqual([]);
  });

  // --- unlinkCard ---

  test('unlinkCard calls DELETE on /cards/:id/links/:fromId', async () => {
    mockClient.delete.mockResolvedValue(undefined);
    await api.unlinkCard('card-1', 'card-2');
    expect(mockClient.delete).toHaveBeenCalledWith('/cards/card-1/links/card-2');
  });

  test('unlinkCard propagates errors', async () => {
    mockClient.delete.mockRejectedValue(new Error('Link not found'));
    await expect(api.unlinkCard('card-1', 'bad-link')).rejects.toThrow('Link not found');
  });

  // --- moveCard ---

  test('moveCard patches /cards/:id/move', async () => {
    const card = { cardId: 'card-1', name: 'Task', createdAt: '2026-01-01', boardId: 'board-2' };
    mockClient.patch.mockResolvedValue(card);
    const result = await api.moveCard('card-1', { toBoardId: 'board-2', position: 'top' });
    expect(result.boardId).toBe('board-2');
    expect(mockClient.patch).toHaveBeenCalledWith('/cards/card-1/move', {
      boardId: 'board-2',
      position: 'top',
    });
  });

  test('moveCard without position sends undefined position', async () => {
    const card = { cardId: 'card-1', name: 'Task', createdAt: '2026-01-01' };
    mockClient.patch.mockResolvedValue(card);
    await api.moveCard('card-1', { toBoardId: 'board-2' });
    expect(mockClient.patch).toHaveBeenCalledWith('/cards/card-1/move', {
      boardId: 'board-2',
      position: undefined,
    });
  });

  test('moveCard propagates errors', async () => {
    mockClient.patch.mockRejectedValue(new Error('Board not found'));
    await expect(api.moveCard('card-1', { toBoardId: 'bad-board' })).rejects.toThrow('Board not found');
  });

  // --- createCard ---

  test('createCard posts data to /cards', async () => {
    const card = { cardId: '2', name: 'New', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
    mockClient.post.mockResolvedValue(card);
    const result = await api.createCard({ name: 'New' });
    expect(result.name).toBe('New');
    expect(mockClient.post).toHaveBeenCalledWith('/cards', { name: 'New' });
  });

  test('createCard with all fields', async () => {
    const card = {
      cardId: '3', name: 'Full', description: 'desc', status: 'todo',
      createdAt: '2026-01-01', updatedAt: '2026-01-01'
    };
    mockClient.post.mockResolvedValue(card);
    const result = await api.createCard({ name: 'Full', description: 'desc', status: 'todo', boardId: 'board-1' });
    expect(result.description).toBe('desc');
    expect(mockClient.post).toHaveBeenCalledWith('/cards', {
      name: 'Full', description: 'desc', status: 'todo', boardId: 'board-1'
    });
  });

  test('createCard propagates API errors', async () => {
    mockClient.post.mockRejectedValue(new Error('Validation error'));
    await expect(api.createCard({ name: 'Bad' })).rejects.toThrow('Validation error');
  });

  // --- createCards (bulk) ---

  test('createCards posts bulk data to /cards/bulk', async () => {
    const cards = [
      { cardId: 'b1', name: 'Bulk 1', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      { cardId: 'b2', name: 'Bulk 2', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    ];
    mockClient.post.mockResolvedValue({ cards });
    const result = await api.createCards([{ name: 'Bulk 1' }, { name: 'Bulk 2' }]);
    expect(result).toHaveLength(2);
    expect(mockClient.post).toHaveBeenCalledWith('/cards/bulk', {
      cards: [{ name: 'Bulk 1' }, { name: 'Bulk 2' }]
    });
  });

  test('createCards returns empty array when response.cards missing', async () => {
    mockClient.post.mockResolvedValue({});
    const result = await api.createCards([{ name: 'X' }]);
    expect(result).toEqual([]);
  });

  test('createCards handles 100+ items', async () => {
    const inputCards = Array.from({ length: 150 }, (_, i) => ({ name: `Card ${i}` }));
    const outputCards = inputCards.map((c, i) => ({
      cardId: `bulk-${i}`, name: c.name, createdAt: '2026-01-01', updatedAt: '2026-01-01'
    }));
    mockClient.post.mockResolvedValue({ cards: outputCards });
    const result = await api.createCards(inputCards);
    expect(result).toHaveLength(150);
  });

  test('createCards propagates rate limit errors', async () => {
    const rateLimitError = Object.assign(new Error('Too Many Requests'), { response: { status: 429 } });
    mockClient.post.mockRejectedValue(rateLimitError);
    await expect(api.createCards([{ name: 'Test' }])).rejects.toThrow('Too Many Requests');
  });

  // --- updateCard ---

  test('updateCard patches card by id', async () => {
    const updated = { cardId: 'card-1', name: 'Updated', createdAt: '2026-01-01', updatedAt: '2026-01-02' };
    mockClient.patch.mockResolvedValue(updated);
    const result = await api.updateCard('card-1', { name: 'Updated' });
    expect(result.name).toBe('Updated');
    expect(mockClient.patch).toHaveBeenCalledWith('/cards/card-1', { name: 'Updated' });
  });

  test('updateCard with tags parsed as array', async () => {
    const updated = { cardId: 'card-1', name: 'Task', tags: ['bug', 'urgent'], createdAt: '2026-01-01', updatedAt: '2026-01-02' };
    mockClient.patch.mockResolvedValue(updated);
    const result = await api.updateCard('card-1', { tags: ['bug', 'urgent'] });
    expect(result.tags).toEqual(['bug', 'urgent']);
  });

  test('updateCard propagates errors', async () => {
    mockClient.patch.mockRejectedValue(new Error('Card not found'));
    await expect(api.updateCard('bad-id', { name: 'X' })).rejects.toThrow('Card not found');
  });

  // --- deleteCard ---

  test('deleteCard calls DELETE on /cards/:id', async () => {
    mockClient.delete.mockResolvedValue(undefined);
    await api.deleteCard('card-del');
    expect(mockClient.delete).toHaveBeenCalledWith('/cards/card-del');
  });

  test('deleteCard propagates errors', async () => {
    mockClient.delete.mockRejectedValue(new Error('Delete failed'));
    await expect(api.deleteCard('bad-id')).rejects.toThrow('Delete failed');
  });

  // --- searchCards ---

  test('searchCards calls GET with query params', async () => {
    const cards = [{ cardId: 's1', name: 'Search Result', createdAt: '2026-01-01', updatedAt: '2026-01-01' }];
    mockClient.get.mockResolvedValue({ entities: cards });
    const result = await api.searchCards('login bug');
    expect(result).toHaveLength(1);
    expect(mockClient.get).toHaveBeenCalledWith('/cards/search', { params: { q: 'login bug', limit: 50 } });
  });

  test('searchCards with custom limit', async () => {
    mockClient.get.mockResolvedValue({ entities: [] });
    await api.searchCards('query', 10);
    expect(mockClient.get).toHaveBeenCalledWith('/cards/search', { params: { q: 'query', limit: 10 } });
  });

  test('searchCards returns empty array on no matches', async () => {
    mockClient.get.mockResolvedValue({ entities: [] });
    const result = await api.searchCards('nonexistent');
    expect(result).toEqual([]);
  });
});
