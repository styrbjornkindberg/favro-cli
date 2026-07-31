/**
 * Comprehensive tests for CardsAPI
 * CLA-1774: Unit Tests — All Commands
 */
import CardsAPI from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';

/** Card writes carry `descriptionFormat` on the query string (issue #17). */
const MARKDOWN_QUERY = { params: { descriptionFormat: 'markdown' } };

describe('Cards API', () => {
  let api: CardsAPI;
  let mockClient: jest.Mocked<Pick<FavroHttpClient, 'get' | 'post' | 'patch' | 'put' | 'delete'>>;

  beforeEach(() => {
    mockClient = {
      get: jest.fn(),
      post: jest.fn(),
      patch: jest.fn(),
      put: jest.fn(),
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
    expect(mockClient.get).toHaveBeenCalledWith('/cards', expect.objectContaining({ params: expect.objectContaining({ widgetCommonId: 'board-xyz' }) }));
  });

  test('listCards without board id uses /cards endpoint', async () => {
    mockClient.get.mockResolvedValue({ entities: [] });
    await api.listCards(undefined);
    expect(mockClient.get).toHaveBeenCalledWith('/cards', expect.any(Object));
  });

  // #44: `limit` is no longer a caller-shaped fetch cap — Favro clamps it to 100
  // per page regardless, so the loop always asks for the page maximum. #45: the
  // live-card selector rides every list read.
  test('listCards asks for the page maximum and selects live cards', async () => {
    mockClient.get.mockResolvedValue({ entities: [] });
    await api.listCards('board-1');
    expect(mockClient.get).toHaveBeenCalledWith('/cards', {
      params: { descriptionFormat: 'markdown', limit: 100, archived: false, widgetCommonId: 'board-1' },
    });
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
    const result = await api.listCards('board-1');
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

    const result = await api.listCards('board-1');

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

    const result = await api.listCards('board-1');

    // Should stop after empty page
    expect(mockClient.get).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
  });

  // #44 inverted this: truncating the FETCH was the defect, because every
  // client-side filter downstream then filtered a partial set. The read now runs
  // to completion and the caller caps its own OUTPUT.
  test('listCards keeps paging past any caller-sized number of cards', async () => {
    const page = (p: number) => ({
      entities: Array.from({ length: 5 }, (_, i) => ({
        cardId: `c${p}-${i}`, name: `Card ${p}-${i}`, createdAt: '2026-01-01', updatedAt: '2026-01-01'
      })),
      requestId: 'req-limit',
      pages: 3,
      page: p,
    });

    mockClient.get
      .mockResolvedValueOnce(page(0))
      .mockResolvedValueOnce(page(1))
      .mockResolvedValueOnce(page(2));

    const result = await api.listCards('board-1');

    expect(mockClient.get).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(15);
  });

  test('listCards handles single-page response without requestId', async () => {
    const cards = [
      { cardId: 'single', name: 'Single Card', createdAt: '2026-01-01', updatedAt: '2026-01-01' }
    ];
    // Response without requestId = single page
    mockClient.get.mockResolvedValue({ entities: cards });

    const result = await api.listCards('board-1');

    expect(mockClient.get).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
  });

  // --- getCard ---

  test('getCard fetches single card by id', async () => {
    const card = { cardId: 'card-1', name: 'Task', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
    mockClient.get.mockResolvedValue(card);
    const result = await api.getCard('card-1');
    expect(result.cardId).toBe('card-1');
    expect(mockClient.get).toHaveBeenCalledWith('/cards/card-1', { params: { descriptionFormat: 'markdown' } });
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
      params: { descriptionFormat: 'markdown', include: 'links,comments' },
    });
  });

  // --- linkCard / getCardLinks ---
  // Wire-level coverage lives in cards-api-dependencies-wire.test.ts. Client-mock
  // tests here asserted the request/response shapes the mock was given, so they
  // could not detect that both were wrong against the real API (issue #12).

  test('linkCard propagates errors', async () => {
    mockClient.post.mockRejectedValue(new Error('Card not found'));
    await expect(api.linkCard('bad-id', { toCardId: 'other', isBefore: true })).rejects.toThrow('Card not found');
  });

  // --- unlinkCard ---

  test('unlinkCard calls DELETE on /cards/:id/links/:fromId', async () => {
    mockClient.delete.mockResolvedValue(undefined);
    await api.unlinkCard('card-1', 'card-2');
    expect(mockClient.delete).toHaveBeenCalledWith('/cards/card-1/dependencies/card-2');
  });

  test('unlinkCard propagates errors', async () => {
    mockClient.delete.mockRejectedValue(new Error('Link not found'));
    await expect(api.unlinkCard('card-1', 'bad-link')).rejects.toThrow('Link not found');
  });

  // --- moveCard ---

  test('moveCard calls put on /cards/:id', async () => {
    const card = { cardId: 'card-1', name: 'Task', createdAt: '2026-01-01', boardId: 'board-2' };
    mockClient.put.mockResolvedValue(card);
    const result = await api.moveCard('card-1', { toBoardId: 'board-2', position: 'top' });
    expect(result.boardId).toBe('board-2');
    expect(mockClient.put).toHaveBeenCalledWith('/cards/card-1', {
      widgetCommonId: 'board-2',
      position: 'top',
    });
  });

  test('moveCard without position sends undefined position', async () => {
    const card = { cardId: 'card-1', name: 'Task', createdAt: '2026-01-01' };
    mockClient.put.mockResolvedValue(card);
    await api.moveCard('card-1', { toBoardId: 'board-2' });
    expect(mockClient.put).toHaveBeenCalledWith('/cards/card-1', {
      widgetCommonId: 'board-2',
      position: undefined,
    });
  });

  test('moveCard propagates errors', async () => {
    mockClient.put.mockRejectedValue(new Error('Board not found'));
    await expect(api.moveCard('card-1', { toBoardId: 'bad-board' })).rejects.toThrow('Board not found');
  });

  // --- createCard ---

  test('createCard posts data to /cards', async () => {
    const card = { cardId: '2', name: 'New', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
    mockClient.post.mockResolvedValue(card);
    const result = await api.createCard({ name: 'New' });
    expect(result.name).toBe('New');
    expect(mockClient.post).toHaveBeenCalledWith('/cards', { name: 'New' }, MARKDOWN_QUERY);
  });

  test('createCard with all fields', async () => {
    const card = {
      cardId: '3', name: 'Full', description: 'desc', status: 'todo',
      createdAt: '2026-01-01', updatedAt: '2026-01-01'
    };
    mockClient.post.mockResolvedValue(card);
    // `status` used to be asserted here riding the body — Favro has no such
    // field on POST, so that assertion pinned a silent no-op. The honoured field
    // is `columnId`; the name → `columnId` resolution is covered on the wire in
    // cards-create-wire.test.ts (issue #48).
    const result = await api.createCard({ name: 'Full', description: 'desc', columnId: 'col-1', boardId: 'board-1' });
    expect(result.description).toBe('desc');
    // `descriptionFormat` rides the query string, never the body — in the body
    // Favro ignores it and escapes the markdown (issue #17).
    expect(mockClient.post).toHaveBeenCalledWith('/cards', {
      name: 'Full', detailedDescription: 'desc', columnId: 'col-1', widgetCommonId: 'board-1'
    }, MARKDOWN_QUERY);
  });

  test('createCard propagates API errors', async () => {
    mockClient.post.mockRejectedValue(new Error('Validation error'));
    await expect(api.createCard({ name: 'Bad' })).rejects.toThrow('Validation error');
  });

  // --- createCards ---
  // Favro has no bulk-create route (verified live, issue #12), so createCards
  // loops POST /cards. Per-call wiring is covered in
  // cards-api-dependencies-wire.test.ts.

  test('createCards propagates rate limit errors', async () => {
    const rateLimitError = Object.assign(new Error('Too Many Requests'), { response: { status: 429 } });
    mockClient.post.mockRejectedValue(rateLimitError);
    await expect(api.createCards([{ name: 'Test' }])).rejects.toThrow('Too Many Requests');
  });

  // --- updateCard ---

  test('updateCard updates card by id', async () => {
    const updated = { cardId: 'card-1', name: 'Updated', createdAt: '2026-01-01', updatedAt: '2026-01-02' };
    mockClient.put.mockResolvedValue(updated);
    const result = await api.updateCard('card-1', { name: 'Updated' });
    expect(result.name).toBe('Updated');
    expect(mockClient.put).toHaveBeenCalledWith('/cards/card-1', { name: 'Updated' }, MARKDOWN_QUERY);
  });

  // `updateCard with tags parsed as array` lived here and asserted that `tags`
  // reached the client untouched — which is the bug (#16): Favro 200s on `tags`
  // and changes nothing. The tag path is covered by cards-api-tags-wire.test.ts,
  // against a real http server rather than a mock that echoes its own input.

  test('updateCard propagates errors', async () => {
    mockClient.put.mockRejectedValue(new Error('Card not found'));
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
    expect(mockClient.get).toHaveBeenCalledWith('/cards/search', { params: { descriptionFormat: 'markdown', q: 'login bug', limit: 50 } });
  });

  test('searchCards with custom limit', async () => {
    mockClient.get.mockResolvedValue({ entities: [] });
    await api.searchCards('query', 10);
    expect(mockClient.get).toHaveBeenCalledWith('/cards/search', { params: { descriptionFormat: 'markdown', q: 'query', limit: 10 } });
  });

  test('searchCards returns empty array on no matches', async () => {
    mockClient.get.mockResolvedValue({ entities: [] });
    const result = await api.searchCards('nonexistent');
    expect(result).toEqual([]);
  });
});
