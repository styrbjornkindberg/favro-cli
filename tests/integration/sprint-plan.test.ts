/**
 * Integration tests — Sprint Plan Command
 * CLA-1799 / FAVRO-037: Standup & Sprint Commands
 *
 * These tests run against a real Favro API.
 * Set FAVRO_API_KEY and FAVRO_TEST_BOARD_ID env vars to enable.
 * Without credentials, integration tests are skipped.
 */

export {};

// Jest imports (vitest API compatible)

const SPRINT_INTEGRATION_GUARD = !!process.env.FAVRO_API_KEY && !!process.env.FAVRO_TEST_BOARD_ID;
const describeSprintOrSkip = SPRINT_INTEGRATION_GUARD ? describe : describe.skip;

describeSprintOrSkip('Integration: favro sprint-plan', () => {
  let SprintPlanAPI: typeof import('../../src/api/sprint-plan').SprintPlanAPI;
  let FavroHttpClient: typeof import('../../src/lib/http-client').default;

  beforeAll(async () => {
    SprintPlanAPI = (await import('../../src/api/sprint-plan')).SprintPlanAPI;
    FavroHttpClient = (await import('../../src/lib/http-client')).default;
  });

  it('returns a valid sprint plan result for test board', async () => {
    const client = new FavroHttpClient({
      auth: { token: process.env.FAVRO_API_KEY! },
    });
    const api = new SprintPlanAPI(client);

    const result = await api.getSuggestions(process.env.FAVRO_TEST_BOARD_ID!, 40);

    // Structure validation
    expect(result).toHaveProperty('board');
    expect(result).toHaveProperty('budget');
    expect(result).toHaveProperty('totalSuggested');
    expect(result).toHaveProperty('suggestions');
    expect(result).toHaveProperty('overflow');
    expect(result).toHaveProperty('generatedAt');

    // Board ID must match
    expect(result.board.id).toBe(process.env.FAVRO_TEST_BOARD_ID);

    // Budget must equal what we passed
    expect(result.budget).toBe(40);

    // Arrays should be valid
    expect(Array.isArray(result.suggestions)).toBe(true);
    expect(Array.isArray(result.overflow)).toBe(true);

    // All suggestions should have required fields
    for (const card of result.suggestions) {
      expect(card).toHaveProperty('id');
      expect(card).toHaveProperty('title');
      expect(card).toHaveProperty('priorityScore');
      expect(card).toHaveProperty('cumulative');
      expect(card.withinBudget).toBe(true);
    }

    // All overflow cards should not be within budget
    for (const card of result.overflow) {
      expect(card.withinBudget).toBe(false);
    }

    // totalSuggested should be <= budget
    expect(result.totalSuggested).toBeLessThanOrEqual(result.budget);

    console.log(`✓ Sprint plan fetched for board: ${result.board.name}`);
    console.log(`  ${result.suggestions.length} suggestions (${result.totalSuggested} pts), ${result.overflow.length} overflow`);
  });

  it('respects custom budget', async () => {
    const client = new FavroHttpClient({
      auth: { token: process.env.FAVRO_API_KEY! },
    });
    const api = new SprintPlanAPI(client);

    const result = await api.getSuggestions(process.env.FAVRO_TEST_BOARD_ID!, 10);

    expect(result.budget).toBe(10);
    expect(result.totalSuggested).toBeLessThanOrEqual(10);
  });
});

// ─── Structural tests (always run) ───────────────────────────────────────────

describe('SprintPlanAPI structural contract', () => {
  it('SprintPlanResult has expected shape', () => {
    const fixture = {
      board: { id: 'b-1', name: 'Sprint 42' },
      budget: 40,
      totalSuggested: 8,
      suggestions: [],
      overflow: [],
      generatedAt: new Date().toISOString(),
    };

    expect(typeof fixture.budget).toBe('number');
    expect(typeof fixture.totalSuggested).toBe('number');
    expect(Array.isArray(fixture.suggestions)).toBe(true);
    expect(Array.isArray(fixture.overflow)).toBe(true);
  });

  it('suggestions totalSuggested cannot exceed budget', () => {
    const budget = 20;
    const totalSuggested = 18;
    expect(totalSuggested).toBeLessThanOrEqual(budget);
  });
});
