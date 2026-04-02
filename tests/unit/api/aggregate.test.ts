/**
 * Unit tests — AggregateAPI
 * v2.0: Cross-board aggregation layer tests.
 *
 * AggregateAPI creates sub-API instances (CardsAPI, BoardsAPI, etc.) from the
 * shared FavroHttpClient.  All sub-APIs call client.get() with different URL
 * paths. We mock by inspecting the first argument (path) of each call.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import AggregateAPI from '../../../src/api/aggregate';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeRawCard(overrides: Record<string, any> = {}) {
  return {
    cardId: 'card-1',
    name: 'Test Card',
    status: 'In Progress',
    assignees: ['user-1'],
    tags: [],
    createdAt: '2026-01-01',
    updatedAt: '2026-01-02',
    ...overrides,
  };
}

/**
 * Build a mock FavroHttpClient whose get() dispatches on URL path.
 * Callers provide a map of path-prefix → response (or response fn).
 */
function routingClient(routes: Record<string, any>) {
  const get = vi.fn().mockImplementation((path: string) => {
    for (const [prefix, response] of Object.entries(routes)) {
      if (path.startsWith(prefix)) {
        return Promise.resolve(typeof response === 'function' ? response(path) : response);
      }
    }
    return Promise.resolve({ entities: [] });
  });
  return { get, post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AggregateAPI', () => {
  it('constructs without error', () => {
    const client = routingClient({});
    const api = new AggregateAPI(client as any);
    expect(api).toBeDefined();
  });

  it('getMultiBoardSnapshot returns empty snapshot when no collections', async () => {
    const client = routingClient({
      '/collections': { entities: [] },
    });
    const api = new AggregateAPI(client as any);
    const snapshot = await api.getMultiBoardSnapshot({}, 100);

    expect(snapshot.allCards).toEqual([]);
    expect(snapshot.collections).toEqual([]);
    expect(snapshot.stats.total).toBe(0);
    expect(snapshot.generatedAt).toBeTruthy();
  });

  it('getMultiBoardSnapshot with collectionIds fetches and enriches cards', async () => {
    const client = routingClient({
      // getCollection('col-1') → GET /collections/col-1
      '/collections/': { collectionId: 'col-1', name: 'Sprint', createdAt: '', updatedAt: '' },
      // listCards → GET /cards
      '/cards': { entities: [makeRawCard({ cardId: 'card-1', name: 'Task A', columnId: 'col-a', boardId: 'board-1' })] },
      // listBoardsByCollection → GET /widgets
      '/widgets': { entities: [{ widgetCommonId: 'board-1', name: 'Dev Board' }] },
      // listColumns → GET /columns
      '/columns': { entities: [{ columnId: 'col-a', name: 'In Progress' }, { columnId: 'col-b', name: 'Done' }] },
      // getMembers → GET /users
      '/users': { entities: [{ userId: 'user-1', name: 'Alice', email: 'alice@example.com' }] },
    });

    const api = new AggregateAPI(client as any);
    const snapshot = await api.getMultiBoardSnapshot({ collectionIds: ['col-1'] }, 100);

    expect(snapshot.allCards.length).toBe(1);
    expect(snapshot.allCards[0].title).toBe('Task A');
    expect(snapshot.allCards[0].boardName).toBe('Dev Board');
    expect(snapshot.allCards[0].collectionName).toBe('Sprint');
    expect(snapshot.allCards[0].stage).toBe('active'); // "In Progress" → active stage
    expect(snapshot.stats.total).toBe(1);
    expect(snapshot.members.length).toBe(1);
    expect(snapshot.members[0].name).toBe('Alice');
  });

  it('getMultiBoardSnapshot assigns correct workflow stages from column names', async () => {
    const client = routingClient({
      '/collections/': { collectionId: 'col-1', name: 'Sprint', createdAt: '', updatedAt: '' },
      '/cards': {
        entities: [
          makeRawCard({ cardId: 'card-1', columnId: 'col-done', boardId: 'board-1' }),
          makeRawCard({ cardId: 'card-2', columnId: 'col-backlog', boardId: 'board-1' }),
        ],
      },
      '/widgets': { entities: [{ widgetCommonId: 'board-1', name: 'Board' }] },
      '/columns': {
        entities: [
          { columnId: 'col-done', name: 'Done' },
          { columnId: 'col-backlog', name: 'Backlog' },
        ],
      },
      '/users': { entities: [] },
    });

    const api = new AggregateAPI(client as any);
    const snapshot = await api.getMultiBoardSnapshot({ collectionIds: ['col-1'] }, 100);

    const stages = snapshot.allCards.map(c => c.stage);
    expect(stages).toContain('done');
    expect(stages).toContain('backlog');
  });

  it('stats aggregate by_board and by_status correctly', async () => {
    const client = routingClient({
      '/collections/': { collectionId: 'col-1', name: 'Sprint', createdAt: '', updatedAt: '' },
      '/cards': {
        entities: [
          makeRawCard({ cardId: 'c1', status: 'Active', boardId: 'b1' }),
          makeRawCard({ cardId: 'c2', status: 'Active', boardId: 'b1' }),
          makeRawCard({ cardId: 'c3', status: 'Done', boardId: 'b1' }),
        ],
      },
      '/widgets': { entities: [{ widgetCommonId: 'b1', name: 'Board A' }] },
      '/columns': { entities: [] },
      '/users': { entities: [] },
    });

    const api = new AggregateAPI(client as any);
    const snapshot = await api.getMultiBoardSnapshot({ collectionIds: ['col-1'] }, 500);
    expect(snapshot.stats.total).toBe(3);
    expect(snapshot.stats.by_board['Board A']).toBe(3);
  });
});
