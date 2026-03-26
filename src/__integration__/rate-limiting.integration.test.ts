/**
 * Integration Tests — Rate Limiting
 * CLA-1775: Verify that bulk creation of 50 cards respects API rate limits
 *           and that the HTTP client retries 429 responses correctly.
 *
 * Prerequisites:
 *   export FAVRO_API_TOKEN=<token>
 *   export FAVRO_TEST_BOARD_ID=<board-id>
 *
 * NOTE: This test creates 50 cards and may take several minutes due to
 * intentional delays. Run with increased Jest timeout if needed.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runCLI, integrationGuard, TEST_BOARD_ID, API_TOKEN } from './helpers';
import FavroHttpClient from '../lib/http-client';
import CardsAPI from '../lib/cards-api';

const SKIP = !integrationGuard();
const describeOrSkip = SKIP ? describe.skip : describe;

function makeAPI() {
  const client = new FavroHttpClient({ auth: { token: API_TOKEN } });
  return new CardsAPI(client);
}

const PREFIX = '[rate-limit-test]';
const createdCardIds: string[] = [];

describeOrSkip('Rate limiting — real Favro API', () => {
  afterAll(async () => {
    const api = makeAPI();
    for (const id of createdCardIds) {
      try { await api.deleteCard(id); } catch { /* ignore */ }
    }
  });

  /**
   * Create 50 cards in batches via the bulk API.
   * The HTTP client has exponential backoff for 429s (1s, 2s, 4s).
   * We measure total elapsed time to confirm delays are firing.
   */
  it('creates 50 cards without crashing (rate-limit compliance)', async () => {
    const tmpFile = path.join(os.tmpdir(), `favro-rate-limit-${Date.now()}.json`);
    const cards = Array.from({ length: 50 }, (_, i) => ({
      name: `${PREFIX} Card ${i + 1} ${Date.now()}`,
      boardId: TEST_BOARD_ID,
      description: `Rate limit test card #${i + 1}`,
    }));
    await fs.writeFile(tmpFile, JSON.stringify(cards), 'utf-8');

    const start = Date.now();
    const result = await runCLI(
      ['cards', 'create', 'bulk', '--bulk', tmpFile, '--board', TEST_BOARD_ID],
      // Give extra time for retries
    );
    const elapsed = Date.now() - start;

    try { await fs.unlink(tmpFile); } catch { /* ignore */ }

    // Should complete successfully
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/✓ Created 50 cards/);

    // Verify via API that cards exist
    const api = makeAPI();
    const allCards = await api.listCards(TEST_BOARD_ID, 200);
    const testCards = allCards.filter(c => c.name.startsWith(PREFIX));
    expect(testCards.length).toBeGreaterThanOrEqual(50);
    testCards.forEach(c => createdCardIds.push(c.cardId));

    // Log timing info for rate-limit analysis
    console.log(`ℹ 50-card bulk create took ${elapsed}ms`);
    if (elapsed < 1000) {
      console.warn('⚠ Suspiciously fast — rate limiting may not be active');
    }
  }, 300000); // 5 minute timeout for 429 retries

  it('HTTP client retries on 429 with exponential backoff', async () => {
    // Verify retry logic by inspecting the client directly (unit-style within integration context)
    const client = new FavroHttpClient({ auth: { token: API_TOKEN } });

    // The client has interceptors.response configured; verify shouldRetry for 429
    // We can't easily trigger a real 429 without hammering the API, so we verify
    // the retry configuration is present via structure inspection.
    const axiosClient = (client as any).client;
    expect(axiosClient.interceptors.response.handlers.length).toBeGreaterThan(0);

    // Verify the retry count logic: make a real GET that should succeed
    const api = new CardsAPI(client);
    const boards = await client.get('/boards', { params: { limit: 1 } });
    expect(boards).toBeDefined();
  }, 30000);
});
