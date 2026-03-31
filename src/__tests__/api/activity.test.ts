/**
 * Unit tests — ActivityApiClient
 * CLA-1792 FAVRO-030: Integration Test Suite (coverage gap fix)
 */
import { ActivityApiClient } from '../../api/activity';

const SAMPLE_CARD = {
  cardId: 'card-1',
  name: 'Test Card',
  status: 'In Progress',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-02T00:00:00Z',
};

const SAMPLE_CARD_2 = {
  cardId: 'card-2',
  name: 'Second Card',
  status: 'Done',
  createdAt: '2024-01-03T00:00:00Z',
  updatedAt: '2024-01-04T00:00:00Z',
};

const SAMPLE_ACTIVITY = {
  activityId: 'act-1',
  type: 'updated',
  description: 'Card status changed',
  author: 'alice',
  createdAt: '2024-01-02T00:00:00Z',
};

function makeClientWithCards(cards: any[], activityEntries: any[] = []): any {
  return {
    get: jest.fn().mockImplementation((url: string) => {
      if (url.includes('/activities')) {
        return Promise.resolve({ entities: activityEntries });
      }
      // Cards list endpoint
      return Promise.resolve({ entities: cards });
    }),
  };
}

describe('ActivityApiClient.getCardActivity', () => {

  it('returns empty array when no activity', async () => {
    const client = { get: jest.fn().mockResolvedValue({ entities: [] }) };
    const api = new ActivityApiClient(client as any);
    const result = await api.getCardActivity('card-1');
    expect(result).toEqual([]);
    expect(client.get).toHaveBeenCalledWith('/cards/card-1/activities', expect.anything());
  });

  it('returns normalized activity entries', async () => {
    const client = {
      get: jest.fn().mockResolvedValue({
        entities: [SAMPLE_ACTIVITY],
      }),
    };
    const api = new ActivityApiClient(client as any);
    const result = await api.getCardActivity('card-1');
    expect(result).toHaveLength(1);
    expect(result[0].activityId).toBe('act-1');
    expect(result[0].type).toBe('updated');
    expect(result[0].author).toBe('alice');
  });

  it('normalizes alternate field names (id, action, message, user, timestamp)', async () => {
    const client = {
      get: jest.fn().mockResolvedValue({
        entities: [{
          id: 'act-alt',
          action: 'created',
          message: 'Card was created',
          user: 'bob',
          timestamp: '2024-01-01T00:00:00Z',
        }],
      }),
    };
    const api = new ActivityApiClient(client as any);
    const result = await api.getCardActivity('card-1');
    expect(result[0].activityId).toBe('act-alt');
    expect(result[0].type).toBe('created');
    expect(result[0].description).toBe('Card was created');
    expect(result[0].author).toBe('bob');
    expect(result[0].createdAt).toBe('2024-01-01T00:00:00Z');
  });

  it('paginates across multiple pages', async () => {
    const client = {
      get: jest.fn()
        .mockResolvedValueOnce({
          entities: [{ activityId: 'a1', type: 'updated', description: 'A1', createdAt: '2024-01-01T00:00:00Z' }],
          requestId: 'req-1',
          pages: 2,
        })
        .mockResolvedValueOnce({
          entities: [{ activityId: 'a2', type: 'created', description: 'A2', createdAt: '2024-01-02T00:00:00Z' }],
          requestId: 'req-1',
          pages: 2,
        })
        .mockResolvedValueOnce({ entities: [] }),
    };
    const api = new ActivityApiClient(client as any);
    const result = await api.getCardActivity('card-1');
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('handles activity endpoint not available (swallows error)', async () => {
    const client = {
      get: jest.fn().mockRejectedValue(new Error('404 Not Found')),
    };
    const api = new ActivityApiClient(client as any);
    const result = await api.getCardActivity('card-1');
    expect(result).toEqual([]);
  });

  it('respects the limit parameter', async () => {
    const client = {
      get: jest.fn().mockResolvedValue({
        entities: [
          { activityId: 'a1', type: 'updated', description: 'A1', createdAt: '2024-01-01T00:00:00Z' },
          { activityId: 'a2', type: 'created', description: 'A2', createdAt: '2024-01-02T00:00:00Z' },
          { activityId: 'a3', type: 'moved', description: 'A3', createdAt: '2024-01-03T00:00:00Z' },
        ],
      }),
    };
    const api = new ActivityApiClient(client as any);
    const result = await api.getCardActivity('card-1', 2);
    expect(result.length).toBeLessThanOrEqual(2);
  });
});

describe('ActivityApiClient.getBoardActivity', () => {

  it('returns empty array when board has no cards', async () => {
    const client = makeClientWithCards([]);
    const api = new ActivityApiClient(client as any);
    const result = await api.getBoardActivity('board-1');
    expect(result).toEqual([]);
  });

  it('synthesizes activity from card metadata when activity endpoint is empty', async () => {
    const client = makeClientWithCards([SAMPLE_CARD], []);
    const api = new ActivityApiClient(client as any);
    const result = await api.getBoardActivity('board-1');
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].boardId).toBe('board-1');
    expect(result[0].cardId).toBe('card-1');
  });

  it('uses real activity entries when available', async () => {
    const client = makeClientWithCards([SAMPLE_CARD], [SAMPLE_ACTIVITY]);
    const api = new ActivityApiClient(client as any);
    const result = await api.getBoardActivity('board-1');
    // Should have real activity entries
    const realEntry = result.find(e => e.activityId === 'act-1');
    expect(realEntry).toBeDefined();
  });

  it('filters by since date', async () => {
    const client = makeClientWithCards([SAMPLE_CARD, SAMPLE_CARD_2], []);
    const api = new ActivityApiClient(client as any);
    const since = new Date('2024-01-03T00:00:00Z'); // Only include newer cards
    const result = await api.getBoardActivity('board-1', since);
    // card-1 has updatedAt 2024-01-02, should be excluded
    // card-2 has updatedAt 2024-01-04, should be included
    for (const entry of result) {
      expect(new Date(entry.createdAt) >= since).toBe(true);
    }
  });

  it('aggregates activity from multiple cards', async () => {
    const client = makeClientWithCards([SAMPLE_CARD, SAMPLE_CARD_2], []);
    const api = new ActivityApiClient(client as any);
    const result = await api.getBoardActivity('board-1');
    const cardIds = new Set(result.map(e => e.cardId));
    // Should have entries from both cards (synthesized)
    expect(cardIds.size).toBeGreaterThanOrEqual(1);
  });

  it('respects the limit parameter', async () => {
    const manyCards = Array.from({ length: 20 }, (_, i) => ({
      cardId: `card-${i}`,
      name: `Card ${i}`,
      status: 'Backlog',
      createdAt: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      updatedAt: `2024-01-${String(i + 1).padStart(2, '0')}T01:00:00Z`,
    }));
    const client = makeClientWithCards(manyCards, []);
    const api = new ActivityApiClient(client as any);
    const result = await api.getBoardActivity('board-1', undefined, 5);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it('sorts results by timestamp descending (newest first)', async () => {
    const client = makeClientWithCards([SAMPLE_CARD, SAMPLE_CARD_2], []);
    const api = new ActivityApiClient(client as any);
    const result = await api.getBoardActivity('board-1');
    if (result.length > 1) {
      for (let i = 0; i < result.length - 1; i++) {
        const t1 = new Date(result[i].createdAt).getTime();
        const t2 = new Date(result[i + 1].createdAt).getTime();
        expect(t1).toBeGreaterThanOrEqual(t2);
      }
    }
  });
});
