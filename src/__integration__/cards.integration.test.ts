/**
 * Integration Tests — Cards CRUD
 * CLA-1775: Test create, bulk-create, update, list, and export commands
 *           against a real Favro board.
 *
 * Prerequisites:
 *   export FAVRO_API_TOKEN=<token>
 *   export FAVRO_TEST_BOARD_ID=<board-id>
 *
 * Create a dedicated "CLI Test Board" in Favro and use its board ID.
 * All cards created by these tests are prefixed "[integration-test]" so
 * they can be cleaned up manually if needed.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runCLI, integrationGuard, TEST_BOARD_ID, API_TOKEN, sleep } from './helpers';
import FavroHttpClient from '../lib/http-client';
import CardsAPI from '../lib/cards-api';

const SKIP = !integrationGuard();
const describeOrSkip = SKIP ? describe.skip : describe;

/** API client for post-action verification */
function makeAPI() {
  const client = new FavroHttpClient({ auth: { token: API_TOKEN } });
  return new CardsAPI(client);
}

/** Prefix so these cards are identifiable in the UI */
const PREFIX = '[integration-test]';

/** Track created card IDs for cleanup */
const createdCardIds: string[] = [];

describeOrSkip('Cards — real Favro board', () => {
  afterAll(async () => {
    // Best-effort cleanup: delete cards created during this suite
    if (createdCardIds.length === 0) return;
    const api = makeAPI();
    for (const id of createdCardIds) {
      try {
        await api.deleteCard(id);
      } catch {
        // Ignore – card may already be deleted
      }
    }
  });

  // ─── Single create ────────────────────────────────────────────────────────

  describe('cards create (single)', () => {
    it('creates a card and returns the card ID', async () => {
      const title = `${PREFIX} Single card ${Date.now()}`;
      const args = ['cards', 'create', title, '--board', TEST_BOARD_ID, '--json'];
      const result = await runCLI(args);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('✓ Card created:');

      // Verify via API
      const api = makeAPI();
      const cards = await api.listCards(TEST_BOARD_ID, 10);
      const found = cards.find(c => c.name === title);
      expect(found).toBeDefined();
      if (found) createdCardIds.push(found.cardId);
    }, 30000);

    it('creates a card with description and status', async () => {
      const title = `${PREFIX} Card with meta ${Date.now()}`;
      const result = await runCLI([
        'cards', 'create', title,
        '--board', TEST_BOARD_ID,
        '--description', 'Integration test card',
        '--status', 'In Progress',
        '--json',
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('✓ Card created:');

      const api = makeAPI();
      const cards = await api.listCards(TEST_BOARD_ID, 20);
      const found = cards.find(c => c.name === title);
      expect(found).toBeDefined();
      if (found) createdCardIds.push(found.cardId);
    }, 30000);
  });

  // ─── Bulk create from CSV ─────────────────────────────────────────────────

  describe('cards create --bulk (10 cards from JSON file)', () => {
    let tmpFile: string;

    beforeAll(async () => {
      tmpFile = path.join(os.tmpdir(), `favro-bulk-${Date.now()}.json`);
      const bulk = Array.from({ length: 10 }, (_, i) => ({
        name: `${PREFIX} Bulk card ${i + 1} ${Date.now()}`,
        boardId: TEST_BOARD_ID,
        description: `Bulk integration test card #${i + 1}`,
      }));
      await fs.writeFile(tmpFile, JSON.stringify(bulk), 'utf-8');
    });

    afterAll(async () => {
      try { await fs.unlink(tmpFile); } catch { /* ignore */ }
    });

    it('bulk creates 10 cards from a JSON file', async () => {
      const result = await runCLI(['cards', 'create', 'bulk', '--bulk', tmpFile, '--board', TEST_BOARD_ID]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/✓ Created 10 cards/);
    }, 60000);
  });

  // ─── Update ───────────────────────────────────────────────────────────────

  describe('cards update', () => {
    let cardId: string;

    beforeAll(async () => {
      // Create a card to update
      const api = makeAPI();
      const card = await api.createCard({
        name: `${PREFIX} Update target ${Date.now()}`,
        boardId: TEST_BOARD_ID,
      });
      cardId = card.cardId;
      createdCardIds.push(cardId);
    });

    it('updates a card status via CLI', async () => {
      const result = await runCLI([
        'cards', 'update', cardId,
        '--status', 'Done',
        '--json',
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('✓ Card updated:');

      // Verify the change via API
      const api = makeAPI();
      const updated = await api.getCard(cardId);
      expect(updated.status).toBe('Done');
    }, 30000);

    it('updates a card name via CLI', async () => {
      const newName = `${PREFIX} Renamed ${Date.now()}`;
      const result = await runCLI([
        'cards', 'update', cardId,
        '--name', newName,
        '--json',
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('✓ Card updated:');

      const api = makeAPI();
      const updated = await api.getCard(cardId);
      expect(updated.name).toBe(newName);
    }, 30000);
  });

  // ─── List ─────────────────────────────────────────────────────────────────

  describe('cards list', () => {
    it('lists cards for the test board', async () => {
      const result = await runCLI(['cards', 'list', '--board', TEST_BOARD_ID]);
      expect(result.exitCode).toBe(0);
      // Should print card count line
      expect(result.stdout).toMatch(/Found \d+ card/);
    }, 30000);

    it('lists cards as JSON matching direct API call', async () => {
      const result = await runCLI(['cards', 'list', '--board', TEST_BOARD_ID, '--json', '--limit', '20']);
      expect(result.exitCode).toBe(0);

      const cliCards = JSON.parse(result.stdout);
      expect(Array.isArray(cliCards)).toBe(true);

      // Cross-check count via API
      const api = makeAPI();
      const apiCards = await api.listCards(TEST_BOARD_ID, 20);
      // CLI and API should return same number (both fetching 20)
      expect(cliCards.length).toBe(apiCards.length);
    }, 30000);

    it('filters cards by status', async () => {
      // First create a card with a specific status
      const api = makeAPI();
      const card = await api.createCard({
        name: `${PREFIX} Filter test ${Date.now()}`,
        boardId: TEST_BOARD_ID,
        status: 'In Progress',
      });
      createdCardIds.push(card.cardId);

      await sleep(1000); // Let Favro index the card

      const result = await runCLI([
        'cards', 'list',
        '--board', TEST_BOARD_ID,
        '--status', 'In Progress',
        '--json',
      ]);
      expect(result.exitCode).toBe(0);
      const filtered = JSON.parse(result.stdout);
      expect(Array.isArray(filtered)).toBe(true);
      filtered.forEach((c: any) => {
        expect(c.status?.toLowerCase()).toBe('in progress');
      });
    }, 30000);
  });

  // ─── Export ───────────────────────────────────────────────────────────────

  describe('cards export', () => {
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-export-'));
    });

    afterAll(async () => {
      try { await fs.rm(tmpDir, { recursive: true }); } catch { /* ignore */ }
    });

    it('exports cards as JSON to file', async () => {
      const outFile = path.join(tmpDir, 'cards.json');
      const result = await runCLI([
        'cards', 'export', TEST_BOARD_ID,
        '--format', 'json',
        '--out', outFile,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/✓ Exported \d+ card/);

      const content = await fs.readFile(outFile, 'utf-8');
      const exported = JSON.parse(content);
      expect(Array.isArray(exported)).toBe(true);
      expect(exported.length).toBeGreaterThan(0);
      // Each card should have expected fields
      exported.forEach((c: any) => {
        expect(c).toHaveProperty('cardId');
        expect(c).toHaveProperty('name');
      });
    }, 30000);

    it('exports cards as CSV to file', async () => {
      const outFile = path.join(tmpDir, 'cards.csv');
      const result = await runCLI([
        'cards', 'export', TEST_BOARD_ID,
        '--format', 'csv',
        '--out', outFile,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/✓ Exported \d+ card/);

      const content = await fs.readFile(outFile, 'utf-8');
      const lines = content.trim().split('\n');
      // Header + at least 1 data row
      expect(lines.length).toBeGreaterThan(1);
      // Header should contain expected columns
      expect(lines[0]).toMatch(/cardId|ID/i);
    }, 30000);

    it('exported JSON data matches API data', async () => {
      const outFile = path.join(tmpDir, 'verify.json');
      const result = await runCLI([
        'cards', 'export', TEST_BOARD_ID,
        '--format', 'json',
        '--out', outFile,
        '--limit', '10',
      ]);
      expect(result.exitCode).toBe(0);

      const exported = JSON.parse(await fs.readFile(outFile, 'utf-8'));
      const api = makeAPI();
      const apiCards = await api.listCards(TEST_BOARD_ID, 10);

      expect(exported.length).toBe(apiCards.length);
      // Check IDs match (same cards)
      const exportedIds = new Set(exported.map((c: any) => c.cardId));
      apiCards.forEach(c => expect(exportedIds.has(c.cardId)).toBe(true));
    }, 30000);
  });
});
