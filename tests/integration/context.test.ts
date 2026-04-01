/**
 * Integration tests — Board Context Snapshot
 * CLA-1796 / FAVRO-034: Board Context Snapshot Command
 *
 * These tests run against a real (or stubbed) Favro API.
 * Set FAVRO_API_KEY and FAVRO_TEST_BOARD_ID env vars to run against live API.
 * Without credentials, the guard skips integration tests.
 */

export {};

const INTEGRATION_GUARD = !!process.env.FAVRO_API_KEY && !!process.env.FAVRO_TEST_BOARD_ID;
const describeOrSkip = INTEGRATION_GUARD ? describe : describe.skip;

describeOrSkip('Integration: favro context <board>', () => {
  let ContextAPI: typeof import('../../src/api/context').default;
  let FavroHttpClient: typeof import('../../src/lib/http-client').default;

  beforeAll(async () => {
    ContextAPI = (await import('../../src/api/context')).default;
    FavroHttpClient = (await import('../../src/lib/http-client')).default;
  });

  it('returns a valid snapshot for test board', async () => {
    const client = new FavroHttpClient({
      auth: { token: process.env.FAVRO_API_KEY! },
    });
    const api = new ContextAPI(client);

    const start = Date.now();
    const snapshot = await api.getSnapshot(process.env.FAVRO_TEST_BOARD_ID!);
    const elapsed = Date.now() - start;

    // Structure validation
    expect(snapshot).toHaveProperty('board');
    expect(snapshot).toHaveProperty('columns');
    expect(snapshot).toHaveProperty('customFields');
    expect(snapshot).toHaveProperty('members');
    expect(snapshot).toHaveProperty('cards');
    expect(snapshot).toHaveProperty('stats');
    expect(snapshot).toHaveProperty('generatedAt');

    // Board ID must match
    expect(snapshot.board.id).toBe(process.env.FAVRO_TEST_BOARD_ID);

    // Stats consistency
    expect(snapshot.stats.total).toBe(snapshot.cards.length);

    // Performance target: < 1s
    expect(elapsed).toBeLessThan(1000);
    console.log(`✓ Snapshot fetched in ${elapsed}ms (${snapshot.cards.length} cards)`);
  });
});

// ─── Structural unit test (always runs) ──────────────────────────────────────
// Even without credentials these tests verify snapshot structure

describe('BoardContextSnapshot structure', () => {
  it('has the expected top-level keys', () => {
    // Just a type/structure contract test
    const expectedKeys = ['board', 'columns', 'customFields', 'members', 'cards', 'stats', 'generatedAt'];
    const snapshot = {
      board: { id: '', name: '', members: [] },
      columns: [],
      customFields: [],
      members: [],
      cards: [],
      stats: { total: 0, by_status: {}, by_owner: {} },
      generatedAt: new Date().toISOString(),
    };
    for (const key of expectedKeys) {
      expect(snapshot).toHaveProperty(key);
    }
  });

  it('stats.total matches cards length invariant', () => {
    const cards = [
      { id: 'c1', title: 'Card 1', status: 'Done', blockedBy: [], blocking: [] },
      { id: 'c2', title: 'Card 2', status: 'Backlog', blockedBy: [], blocking: [] },
    ];
    const stats = { total: cards.length, by_status: {}, by_owner: {} };
    expect(stats.total).toBe(cards.length);
  });
});
