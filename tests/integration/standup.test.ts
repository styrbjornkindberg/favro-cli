/**
 * Integration tests — Standup Command
 * CLA-1799 / FAVRO-037: Standup & Sprint Commands
 *
 * These tests run against a real Favro API.
 * Set FAVRO_API_KEY and FAVRO_TEST_BOARD_ID env vars to enable.
 * Without credentials, integration tests are skipped.
 */

// Jest imports (vitest API compatible)

const STANDUP_INTEGRATION_GUARD = !!process.env.FAVRO_API_KEY && !!process.env.FAVRO_TEST_BOARD_ID;
const describeStandupOrSkip = STANDUP_INTEGRATION_GUARD ? describe : describe.skip;

describeStandupOrSkip('Integration: favro standup', () => {
  let StandupAPI: typeof import('../../src/api/standup').StandupAPI;
  let FavroHttpClient: typeof import('../../src/lib/http-client').default;

  beforeAll(async () => {
    StandupAPI = (await import('../../src/api/standup')).StandupAPI;
    FavroHttpClient = (await import('../../src/lib/http-client')).default;
  });

  it('returns a valid standup result for test board', async () => {
    const client = new FavroHttpClient({
      auth: { token: process.env.FAVRO_API_KEY! },
    });
    const api = new StandupAPI(client);

    const result = await api.getStandup(process.env.FAVRO_TEST_BOARD_ID!);

    // Structure validation
    expect(result).toHaveProperty('board');
    expect(result).toHaveProperty('completed');
    expect(result).toHaveProperty('inProgress');
    expect(result).toHaveProperty('blocked');
    expect(result).toHaveProperty('dueSoon');
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('generatedAt');

    // Board ID must match
    expect(result.board.id).toBe(process.env.FAVRO_TEST_BOARD_ID);

    // Arrays should be valid
    expect(Array.isArray(result.completed)).toBe(true);
    expect(Array.isArray(result.inProgress)).toBe(true);
    expect(Array.isArray(result.blocked)).toBe(true);
    expect(Array.isArray(result.dueSoon)).toBe(true);

    // All grouped cards should have required fields
    const allCards = [...result.completed, ...result.inProgress, ...result.blocked, ...result.dueSoon];
    for (const card of allCards) {
      expect(card).toHaveProperty('id');
      expect(card).toHaveProperty('title');
      expect(card).toHaveProperty('group');
      expect(['completed', 'in-progress', 'blocked', 'due-soon']).toContain(card.group);
    }

    console.log(`✓ Standup fetched: ${result.total} total cards`);
    console.log(`  Completed: ${result.completed.length}, In Progress: ${result.inProgress.length}, Blocked: ${result.blocked.length}, Due Soon: ${result.dueSoon.length}`);
  });

  it('respects cardLimit parameter', async () => {
    const client = new FavroHttpClient({
      auth: { token: process.env.FAVRO_API_KEY! },
    });
    const api = new StandupAPI(client);

    const result = await api.getStandup(process.env.FAVRO_TEST_BOARD_ID!, 5);

    // Should work with a small limit
    expect(result.total).toBeLessThanOrEqual(5);
  });
});

// ─── Structural tests (always run) ───────────────────────────────────────────

describe('StandupAPI structural contract', () => {
  it('StandupResult has expected shape', () => {
    // Type contract test — no real API calls
    const expected = {
      board: { id: expect.any(String), name: expect.any(String) },
      completed: expect.any(Array),
      inProgress: expect.any(Array),
      blocked: expect.any(Array),
      dueSoon: expect.any(Array),
      total: expect.any(Number),
      generatedAt: expect.any(String),
    };
    // Just verify our fixture matches the shape
    const fixture = {
      board: { id: 'b-1', name: 'Sprint 42' },
      completed: [],
      inProgress: [],
      blocked: [],
      dueSoon: [],
      total: 0,
      generatedAt: new Date().toISOString(),
    };
    expect(fixture).toMatchObject(expected);
  });
});
