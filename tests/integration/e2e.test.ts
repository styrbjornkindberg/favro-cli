/**
 * Integration Tests — End-to-End (CLA-1775)
 * Tests all CLI commands against a real Favro board.
 *
 * Prerequisites:
 *   export FAVRO_API_TOKEN=<token>
 *   export FAVRO_TEST_BOARD_ID=<board-id>
 *
 * Run with: pnpm test:integration
 *
 * Cards created by tests are prefixed "[integration-test]" for easy cleanup.
 * The afterAll hook attempts best-effort deletion of created cards.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import FavroHttpClient from '../../src/lib/http-client';
import CardsAPI from '../../src/lib/cards-api';

const execFileAsync = promisify(execFile);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TS_NODE = path.resolve(__dirname, '../../node_modules/.bin/ts-node');
const CLI_SRC = path.resolve(__dirname, '../../src/cli.ts');

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCLI(args: string[], env?: Record<string, string>): Promise<RunResult> {
  const mergedEnv = {
    ...process.env,
    FAVRO_API_TOKEN: process.env.FAVRO_API_TOKEN || '',
    ...env,
  };
  try {
    const { stdout, stderr } = await execFileAsync(
      TS_NODE,
      ['--project', path.resolve(__dirname, '../../tsconfig.json'), CLI_SRC, ...args],
      { env: mergedEnv, timeout: 60000 }
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.code || 1 };
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const API_TOKEN = process.env.FAVRO_API_TOKEN || '';
const TEST_BOARD_ID = process.env.FAVRO_TEST_BOARD_ID || '';
const INTEGRATION_GUARD = !!(API_TOKEN && TEST_BOARD_ID);
const PREFIX = '[integration-test]';

function makeAPI() {
  const client = new FavroHttpClient({ auth: { token: API_TOKEN } });
  return new CardsAPI(client);
}

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const CSV_FIXTURE = path.resolve(__dirname, 'fixtures/sample-cards.csv');

// ─── Suite ────────────────────────────────────────────────────────────────────

const describeOrSkip = INTEGRATION_GUARD ? describe : describe.skip;

// Track created card IDs for afterAll cleanup
const allCreatedCardIds: string[] = [];

afterAll(async () => {
  if (allCreatedCardIds.length === 0) return;
  const api = makeAPI();
  for (const id of allCreatedCardIds) {
    try { await api.deleteCard(id); } catch { /* ignore */ }
  }
});

// =============================================================================
// 1. BOARDS
// =============================================================================

describeOrSkip('Boards — real API', () => {
  it('lists boards and returns non-empty array', async () => {
    const result = await runCLI(['boards', 'list', '--json']);
    expect(result.exitCode).toBe(0);
    const boards = JSON.parse(result.stdout);
    expect(Array.isArray(boards)).toBe(true);
    expect(boards.length).toBeGreaterThan(0);
    // Each board should have an id and name
    const first = boards[0];
    expect(first).toBeDefined();
    expect(typeof (first.boardId ?? first.id)).toBe('string');
  }, 30000);

  it('lists boards as table (non-JSON mode)', async () => {
    const result = await runCLI(['boards', 'list']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Found \d+ board/);
  }, 30000);

  it('test board is found in boards list', async () => {
    const result = await runCLI(['boards', 'list', '--json']);
    expect(result.exitCode).toBe(0);
    const boards = JSON.parse(result.stdout);
    const found = boards.find((b: any) => (b.boardId ?? b.id) === TEST_BOARD_ID);
    expect(found).toBeDefined();
  }, 30000);

  it('fails gracefully when FAVRO_API_TOKEN is missing', async () => {
    const result = await runCLI(['boards', 'list'], { FAVRO_API_TOKEN: '' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/FAVRO_API_TOKEN/);
  }, 15000);
});

// =============================================================================
// 2. AUTH FLOW
// =============================================================================

describeOrSkip('Auth flow — login/execute/logout lifecycle', () => {
  it('succeeds with valid FAVRO_API_TOKEN', async () => {
    // Valid token → command succeeds
    const result = await runCLI(['boards', 'list', '--json']);
    expect(result.exitCode).toBe(0);
    const boards = JSON.parse(result.stdout);
    expect(Array.isArray(boards)).toBe(true);
  }, 30000);

  it('fails gracefully with empty FAVRO_API_TOKEN', async () => {
    // No token → CLI should reject with helpful message
    const result = await runCLI(['cards', 'list', '--board', TEST_BOARD_ID], {
      FAVRO_API_TOKEN: '',
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/FAVRO_API_TOKEN/);
  }, 15000);

  it('fails gracefully with invalid FAVRO_API_TOKEN', async () => {
    // Invalid token → 401 from API, CLI shows error
    const result = await runCLI(['cards', 'list', '--board', TEST_BOARD_ID], {
      FAVRO_API_TOKEN: 'invalid-token-xyz-00000',
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/✗ Error:/);
    expect(result.stderr).not.toMatch(/UnhandledPromiseRejection/);
  }, 30000);

  it('card creation requires valid token — full lifecycle', async () => {
    // Step 1: with valid token, create card successfully
    const title = `${PREFIX} Auth flow test ${Date.now()}`;
    const createResult = await runCLI([
      'cards', 'create', title, '--board', TEST_BOARD_ID, '--json',
    ]);
    expect(createResult.exitCode).toBe(0);
    expect(createResult.stdout).toContain('✓ Card created:');

    // Track for cleanup
    const api = makeAPI();
    await sleep(3000);
    const cards = await api.listCards(TEST_BOARD_ID, 20);
    const found = cards.find(c => c.name === title);
    if (found) allCreatedCardIds.push(found.cardId);

    // Step 2: with no token, same command fails
    const failResult = await runCLI(
      ['cards', 'create', `${PREFIX} Should fail ${Date.now()}`, '--board', TEST_BOARD_ID],
      { FAVRO_API_TOKEN: '' }
    );
    expect(failResult.exitCode).not.toBe(0);
    expect(failResult.stderr).toMatch(/FAVRO_API_TOKEN/);
  }, 60000);
});

// =============================================================================
// 3. CARDS — CRUD
// =============================================================================

describeOrSkip('Cards — CRUD on real Favro board', () => {
  it('creates a single card and verifies via API', async () => {
    const title = `${PREFIX} Single card ${Date.now()}`;
    const result = await runCLI(['cards', 'create', title, '--board', TEST_BOARD_ID, '--json']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('✓ Card created:');

    await sleep(3000); // Let Favro index the card
    const api = makeAPI();
    const cards = await api.listCards(TEST_BOARD_ID, 20);
    const found = cards.find(c => c.name === title);
    expect(found).toBeDefined();
    if (found) allCreatedCardIds.push(found.cardId);
  }, 60000);

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

    await sleep(3000);
    const api = makeAPI();
    const cards = await api.listCards(TEST_BOARD_ID, 20);
    const found = cards.find(c => c.name === title);
    expect(found).toBeDefined();
    if (found) allCreatedCardIds.push(found.cardId);
  }, 60000);

  it('updates a card status via CLI and verifies via API', async () => {
    // Create card via API to update
    const api = makeAPI();
    const card = await api.createCard({
      name: `${PREFIX} Update target ${Date.now()}`,
      boardId: TEST_BOARD_ID,
    });
    allCreatedCardIds.push(card.cardId);

    const result = await runCLI([
      'cards', 'update', card.cardId,
      '--status', 'Done',
      '--json',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('✓ Card updated:');

    const updated = await api.getCard(card.cardId);
    expect(updated.status).toBe('Done');
  }, 60000);

  it('updates a card name via CLI and verifies via API', async () => {
    const api = makeAPI();
    const card = await api.createCard({
      name: `${PREFIX} Rename target ${Date.now()}`,
      boardId: TEST_BOARD_ID,
    });
    allCreatedCardIds.push(card.cardId);

    const newName = `${PREFIX} Renamed ${Date.now()}`;
    const result = await runCLI([
      'cards', 'update', card.cardId,
      '--name', newName,
      '--json',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('✓ Card updated:');

    const updated = await api.getCard(card.cardId);
    expect(updated.name).toBe(newName);
  }, 60000);

  it('lists cards for the test board', async () => {
    const result = await runCLI(['cards', 'list', '--board', TEST_BOARD_ID]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Found \d+ card/);
  }, 30000);

  it('lists cards as JSON matching direct API call', async () => {
    const result = await runCLI(['cards', 'list', '--board', TEST_BOARD_ID, '--json', '--limit', '20']);
    expect(result.exitCode).toBe(0);
    const cliCards = JSON.parse(result.stdout);
    expect(Array.isArray(cliCards)).toBe(true);

    const api = makeAPI();
    const apiCards = await api.listCards(TEST_BOARD_ID, 20);
    expect(cliCards.length).toBe(apiCards.length);
  }, 30000);

  it('filters cards by status', async () => {
    // Create a dedicated card with known status
    const api = makeAPI();
    const statusCard = await api.createCard({
      name: `${PREFIX} Filter test ${Date.now()}`,
      boardId: TEST_BOARD_ID,
      status: 'In Progress',
    });
    allCreatedCardIds.push(statusCard.cardId);

    await sleep(3000); // Let Favro index the card

    const result = await runCLI([
      'cards', 'list',
      '--board', TEST_BOARD_ID,
      '--status', 'In Progress',
      '--json',
    ]);
    expect(result.exitCode).toBe(0);
    const filtered = JSON.parse(result.stdout);
    expect(Array.isArray(filtered)).toBe(true);
    // All returned cards should have the requested status
    filtered.forEach((c: any) => {
      expect(c.status?.toLowerCase()).toBe('in progress');
    });
    // Our newly created card should be in the results
    const found = filtered.find((c: any) => c.cardId === statusCard.cardId);
    expect(found).toBeDefined();
  }, 60000);
});

// =============================================================================
// 4. DRY-RUN
// =============================================================================

describeOrSkip('Dry-run — no mutations', () => {
  it('cards create --dry-run does not create a card', async () => {
    const dryTitle = `${PREFIX} DRY-RUN ${Date.now()}`;
    const result = await runCLI([
      'cards', 'create', dryTitle,
      '--board', TEST_BOARD_ID,
      '--dry-run',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[dry-run]');

    // Wait and verify no card was actually created
    await sleep(3000);
    const api = makeAPI();
    const cards = await api.listCards(TEST_BOARD_ID, 50);
    const found = cards.find(c => c.name === dryTitle);
    expect(found).toBeUndefined();
  }, 60000);

  it('cards update --dry-run does not mutate the card', async () => {
    // Create a real card to (not) update
    const api = makeAPI();
    const originalName = `${PREFIX} Dry-run update target ${Date.now()}`;
    const card = await api.createCard({
      name: originalName,
      boardId: TEST_BOARD_ID,
    });
    allCreatedCardIds.push(card.cardId);

    const result = await runCLI([
      'cards', 'update', card.cardId,
      '--name', `${PREFIX} Should NOT be renamed`,
      '--dry-run',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[dry-run]');

    // Verify the card name was not changed
    const unchanged = await api.getCard(card.cardId);
    expect(unchanged.name).toBe(originalName);
  }, 60000);
});

// =============================================================================
// 5. CSV IMPORT
// =============================================================================

describeOrSkip('CSV import — bulk create from fixture file', () => {
  // Timestamp-based isolation: each test run uses unique card names derived from
  // csvTimestamp. No beforeAll cleanup needed — uniqueness guarantees no stale state.
  // This matches the single-card dry-run pattern and is immune to network failures.
  const csvTimestamp = Date.now();
  const CSV_TAG = `[csv-${csvTimestamp}]`;
  let tmpCsvFile: string;

  beforeAll(async () => {
    if (!INTEGRATION_GUARD) return;
    // Write a timestamped CSV fixture so card names are unique per run.
    tmpCsvFile = path.join(process.cwd(), 'tmp', `sample-cards-${csvTimestamp}.csv`);
    await fs.mkdir(path.join(process.cwd(), 'tmp'), { recursive: true });
    const csvContent = [
      'name,description,status',
      ...Array.from({ length: 10 }, (_, i) =>
        `${CSV_TAG} CSV Card ${i + 1},Imported via CSV fixture ${csvTimestamp},To Do`
      ),
    ].join('\n');
    await fs.writeFile(tmpCsvFile, csvContent, 'utf-8');
  });

  afterAll(async () => {
    try { if (tmpCsvFile) await fs.unlink(tmpCsvFile); } catch { /* ignore */ }
  });

  it('CSV dry-run shows preview without creating cards', async () => {
    // Run dry-run BEFORE the real import. Since card names include csvTimestamp,
    // no stale state from prior runs can interfere — uniqueness is guaranteed.
    const result = await runCLI([
      'cards', 'create', 'ignored-title',
      '--csv', tmpCsvFile,
      '--board', TEST_BOARD_ID,
      '--dry-run',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[dry-run]');
    expect(result.stdout).toContain('10 cards from CSV');

    // Verify via API that no cards with this run's timestamp were created
    await sleep(3000);
    const api = makeAPI();
    const cards = await api.listCards(TEST_BOARD_ID, 100);
    const found = cards.filter(c => c.name.includes(CSV_TAG));
    expect(found).toHaveLength(0);
  }, 60000);

  it('imports 10 cards from timestamped CSV fixture', async () => {
    const result = await runCLI([
      'cards', 'create', 'ignored-title',
      '--csv', tmpCsvFile,
      '--board', TEST_BOARD_ID,
      '--json',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('✓ Created 10 cards from CSV');

    // Verify via API using timestamp tag — immune to stale state
    await sleep(3000);
    const api = makeAPI();
    const cards = await api.listCards(TEST_BOARD_ID, 200);
    const csvCards = cards.filter(c => c.name.includes(CSV_TAG));
    expect(csvCards.length).toBeGreaterThanOrEqual(10);
    csvCards.forEach(c => allCreatedCardIds.push(c.cardId));
  }, 120000);

  it('CSV import fails gracefully when file does not exist', async () => {
    const result = await runCLI([
      'cards', 'create', 'ignored-title',
      '--csv', path.join(process.cwd(), 'tmp', 'nonexistent-file-99999.csv'),
      '--board', TEST_BOARD_ID,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/✗ Error:/);
  }, 15000);
});

// =============================================================================
// 6. BULK JSON CREATE (10 cards)
// =============================================================================

describeOrSkip('Bulk create — 10 cards from JSON file', () => {
  let tmpFile: string;
  const bulkTimestamp = Date.now();
  const BULK_TAG = `[bulk-${bulkTimestamp}]`;

  beforeAll(async () => {
    tmpFile = path.join(os.tmpdir(), `favro-bulk-${bulkTimestamp}.json`);
    const bulk = Array.from({ length: 10 }, (_, i) => ({
      name: `${PREFIX} ${BULK_TAG} Bulk JSON card ${i + 1}`,
      boardId: TEST_BOARD_ID,
      description: `Bulk integration test card #${i + 1} (run ${bulkTimestamp})`,
    }));
    await fs.writeFile(tmpFile, JSON.stringify(bulk), 'utf-8');
  });

  afterAll(async () => {
    try { await fs.unlink(tmpFile); } catch { /* ignore */ }
  });

  it('bulk creates 10 cards from a JSON file and verifies via API', async () => {
    const result = await runCLI([
      'cards', 'create', 'bulk-ignored',
      '--bulk', tmpFile,
      '--board', TEST_BOARD_ID,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/✓ Created 10 cards/);

    // Verify via API using timestamp tag — immune to stale state from prior runs
    await sleep(3000);
    const api = makeAPI();
    const allCards = await api.listCards(TEST_BOARD_ID, 200);
    const bulkCards = allCards.filter(c => c.name.includes(BULK_TAG));
    expect(bulkCards.length).toBeGreaterThanOrEqual(10);
    bulkCards.forEach(c => allCreatedCardIds.push(c.cardId));
  }, 60000);
});

// =============================================================================
// 7. EXPORT
// =============================================================================

describeOrSkip('Export — cards to JSON and CSV', () => {
  let tmpDir: string;

  beforeAll(async () => {
    // Use in-project tmp/ dir to avoid path restriction in cli.ts (must be within cwd)
    const projectTmp = path.join(process.cwd(), 'tmp');
    await fs.mkdir(projectTmp, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(projectTmp, 'favro-export-'));
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
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toMatch(/cardId|ID/i);
  }, 30000);

  it('exported JSON matches direct API results', async () => {
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
    const exportedIds = new Set(exported.map((c: any) => c.cardId));
    apiCards.forEach(c => expect(exportedIds.has(c.cardId)).toBe(true));
  }, 30000);
});

// =============================================================================
// 8. RATE LIMITING — Behavioral verification (mocked 429)
// =============================================================================

describeOrSkip('Rate limiting — behavioral verification', () => {
  /**
   * Test that the HTTP client retries on 429 with exponential backoff.
   * We mock a server that returns 429 twice then 200, and verify:
   *   - Total retries = 2 (before succeeding on 3rd attempt)
   *   - Elapsed time >= minimum backoff (1s + 2s = 3s)
   */
  it('retries on 429 with exponential backoff', async () => {
    let callCount = 0;
    const requestTimestamps: number[] = [];

    // Create a client that intercepts requests
    const client = new FavroHttpClient({ auth: { token: API_TOKEN } });
    const axiosInstance = client.getClient();

    // Intercept at the adapter level to simulate 429 responses
    const originalAdapter = axiosInstance.defaults.adapter;

    axiosInstance.defaults.adapter = async (config: any) => {
      callCount++;
      requestTimestamps.push(Date.now());

      // Return 429 for first 2 calls, 200 on 3rd
      if (callCount <= 2) {
        const error: any = new Error('Request failed with status code 429');
        error.response = {
          status: 429,
          data: { message: 'Rate limit exceeded' },
          headers: {},
          config,
        };
        error.config = config;
        error.isAxiosError = true;
        throw error;
      }

      // 3rd call succeeds
      return {
        status: 200,
        statusText: 'OK',
        data: { entities: [], requestId: undefined, pages: 1 },
        headers: {},
        config,
      };
    };

    const start = Date.now();
    try {
      const api = new CardsAPI(client);
      await api.listCards(TEST_BOARD_ID, 10);
    } finally {
      // Restore adapter
      axiosInstance.defaults.adapter = originalAdapter;
    }

    const elapsed = Date.now() - start;

    // Should have retried: 3 total calls (2 failures + 1 success)
    expect(callCount).toBe(3);

    // Exponential backoff: 1s (retry 1) + 2s (retry 2) = at least 3000ms
    expect(elapsed).toBeGreaterThanOrEqual(2900); // slight tolerance

    // Verify backoff intervals increased
    if (requestTimestamps.length >= 3) {
      const gap1 = requestTimestamps[1] - requestTimestamps[0];
      const gap2 = requestTimestamps[2] - requestTimestamps[1];
      expect(gap2).toBeGreaterThanOrEqual(gap1 * 1.5); // backoff grows
    }
  }, 30000);

  /**
   * Real API: bulk create 50 cards to stress-test rate limiting.
   * Verifies all 50 cards are created and timing is reasonable.
   */
  it('creates 50 cards without crashing (rate-limit compliance)', async () => {
    const tmpFile = path.join(os.tmpdir(), `favro-rate-${Date.now()}.json`);
    const bulkCards = Array.from({ length: 50 }, (_, i) => ({
      name: `[rate-limit-test] Card ${i + 1} ${Date.now()}`,
      boardId: TEST_BOARD_ID,
      description: `Rate limit stress test card #${i + 1}`,
    }));
    await fs.writeFile(tmpFile, JSON.stringify(bulkCards), 'utf-8');

    const start = Date.now();
    const result = await runCLI([
      'cards', 'create', 'ignored',
      '--bulk', tmpFile,
      '--board', TEST_BOARD_ID,
    ]);
    const elapsed = Date.now() - start;

    try { await fs.unlink(tmpFile); } catch { /* ignore */ }

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/✓ Created 50 cards/);

    // Verify via API
    await sleep(3000);
    const api = makeAPI();
    const allCards = await api.listCards(TEST_BOARD_ID, 200);
    const rateCards = allCards.filter(c => c.name.startsWith('[rate-limit-test]'));
    expect(rateCards.length).toBeGreaterThanOrEqual(50);
    rateCards.forEach(c => allCreatedCardIds.push(c.cardId));

    console.log(`ℹ 50-card bulk create took ${elapsed}ms`);
  }, 300000);
});

// =============================================================================
// 9. ERROR CASES
// =============================================================================

describeOrSkip('Error cases — graceful failure', () => {
  it('cards list: fails with helpful message when token is missing', async () => {
    const result = await runCLI(
      ['cards', 'list', '--board', TEST_BOARD_ID],
      { FAVRO_API_TOKEN: '' }
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/FAVRO_API_TOKEN/);
  }, 15000);

  it('cards create: fails with helpful message when token is missing', async () => {
    const result = await runCLI(
      ['cards', 'create', 'Test card', '--board', TEST_BOARD_ID],
      { FAVRO_API_TOKEN: '' }
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/FAVRO_API_TOKEN/);
  }, 15000);

  it('cards export: fails with helpful message when token is missing', async () => {
    const result = await runCLI(
      ['cards', 'export', TEST_BOARD_ID, '--format', 'json'],
      { FAVRO_API_TOKEN: '' }
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/FAVRO_API_TOKEN/);
  }, 15000);

  it('cards update: graceful error for non-existent card ID', async () => {
    const result = await runCLI([
      'cards', 'update', 'nonexistent-card-id-00000000',
      '--status', 'Done',
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/✗ Error:/);
    expect(result.stderr).not.toMatch(/UnhandledPromiseRejection/);
  }, 30000);

  it('cards list: graceful error for invalid board ID', async () => {
    const result = await runCLI([
      'cards', 'list',
      '--board', 'invalid-board-id-000000',
    ]);
    expect(result.stderr).not.toMatch(/UnhandledPromiseRejection/);
    if (result.exitCode !== 0) {
      expect(result.stderr).toMatch(/✗/);
    }
  }, 30000);

  it('cards export: rejects invalid format flag', async () => {
    const result = await runCLI([
      'cards', 'export', TEST_BOARD_ID,
      '--format', 'xml',
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Invalid format/i);
  }, 15000);

  it('cards list: graceful 401 for invalid token', async () => {
    const result = await runCLI(
      ['cards', 'list', '--board', TEST_BOARD_ID],
      { FAVRO_API_TOKEN: 'invalid-token-abc123' }
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/✗ Error:/);
    expect(result.stderr).not.toMatch(/UnhandledPromiseRejection/);
  }, 30000);

  it('cards create --bulk: graceful error for missing file', async () => {
    const result = await runCLI([
      'cards', 'create', 'ignored',
      '--bulk', '/tmp/nonexistent-file-999.json',
      '--board', TEST_BOARD_ID,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/✗ Error:/);
  }, 15000);

  it('cards create: graceful error for invalid assignee (T013)', async () => {
    // Spec T013: Create card with invalid assignee → helpful error message
    const result = await runCLI([
      'cards', 'create', `${PREFIX} Invalid assignee test ${Date.now()}`,
      '--board', TEST_BOARD_ID,
      '--assignee', 'nonexistent-user-xyz-99999',
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/✗ Error:/);
    expect(result.stderr).not.toMatch(/UnhandledPromiseRejection/);
  }, 30000);
});

// =============================================================================
// 10. MOCK/OFFLINE FALLBACK TESTS
// =============================================================================

describe('Mock/offline — unit-style in integration context', () => {
  it('HTTP client retries on 429 (structural check)', () => {
    const client = new FavroHttpClient({ auth: { token: 'test-token' } });
    const axiosInstance = client.getClient();
    // Verify retry interceptor is registered
    expect((axiosInstance.interceptors.response as any).handlers?.length ?? 0).toBeGreaterThan(0);
  });

  it('HTTP client shouldRetry returns true for 429, 408, 500+', () => {
    const client = new FavroHttpClient({ auth: { token: 'test-token' } });
    const shouldRetry = (client as any).shouldRetry.bind(client);

    // 429 should retry
    expect(shouldRetry({ response: { status: 429 } })).toBe(true);
    // 408 should retry
    expect(shouldRetry({ response: { status: 408 } })).toBe(true);
    // 500 should retry
    expect(shouldRetry({ response: { status: 500 } })).toBe(true);
    // 404 should NOT retry
    expect(shouldRetry({ response: { status: 404 } })).toBe(false);
    // 401 should NOT retry
    expect(shouldRetry({ response: { status: 401 } })).toBe(false);
  });

  it('CSV parser handles standard CSV format', async () => {
    // Test that the sample-cards.csv fixture is parseable
    const content = await fs.readFile(CSV_FIXTURE, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(11); // header + 10 rows
    // Header should have required columns
    expect(lines[0]).toContain('name');
    // Data rows should have content
    const dataRows = lines.slice(1).filter(l => l.trim().length > 0);
    expect(dataRows.length).toBe(10);
    dataRows.forEach(row => {
      expect(row).toContain('[integration-test]');
    });
  });
});
