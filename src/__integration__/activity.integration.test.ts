/**
 * Integration Tests — Activity API
 * CLA-1789 FAVRO-027: Comments & Activity API
 *
 * Card-scoped since issue #18: Favro has no board-level activity feed, so there
 * is no board form to test. A cardId is discovered from the test board at run
 * time rather than configured, so no new env var is needed.
 *
 * Prerequisites:
 *   export FAVRO_API_TOKEN=<token>
 *   export FAVRO_TEST_BOARD_ID=<board-id>
 */

import { runCLI, integrationGuard, TEST_BOARD_ID } from './helpers';

const SKIP = !integrationGuard();
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('Activity log — real API', () => {
  let cardId = '';

  beforeAll(async () => {
    const result = await runCLI(['cards', 'list', TEST_BOARD_ID, '--format', 'json']);
    if (result.exitCode !== 0) return;
    const cards = JSON.parse(result.stdout);
    cardId = Array.isArray(cards) && cards.length > 0 ? cards[0].cardId : '';
  }, 60000);

  it('shows activity as a table', async () => {
    const result = await runCLI(['activity', cardId]);
    expect(result.exitCode).toBe(0);
    // Either "No activity found" or activity listed
    expect(result.stdout.length + result.stderr.length).toBeGreaterThan(0);
  }, 60000);

  it('shows activity as JSON, in Favro field names', async () => {
    const result = await runCLI(['activity', cardId, '--format', 'json']);
    expect(result.exitCode).toBe(0);
    const entries = JSON.parse(result.stdout);
    expect(Array.isArray(entries)).toBe(true);
    for (const e of entries) {
      expect(e).toHaveProperty('type');
      expect(e).toHaveProperty('time');
      expect(e).toHaveProperty('cardId');
      // The wire carries none of these — nothing may be fabricated for display.
      expect(e).not.toHaveProperty('activityId');
      expect(e).not.toHaveProperty('description');
      expect(e).not.toHaveProperty('createdAt');
      expect(new Date(e.time).getTime()).not.toBeNaN();
    }
  }, 60000);

  it('shows activity with --json shorthand', async () => {
    const result = await runCLI(['activity', cardId, '--json']);
    expect(result.exitCode).toBe(0);
    expect(Array.isArray(JSON.parse(result.stdout))).toBe(true);
  }, 60000);

  it('supports --since filter (1w)', async () => {
    const result = await runCLI(['activity', cardId, '--since', '1w', '--format', 'json']);
    expect(result.exitCode).toBe(0);
    const entries = JSON.parse(result.stdout);
    expect(Array.isArray(entries)).toBe(true);
    // Favro filters server-side; verify it actually honoured the window.
    const oneWeekAgo = Date.now() - 604_800_000;
    for (const e of entries) {
      expect(new Date(e.time).getTime()).toBeGreaterThanOrEqual(oneWeekAgo);
    }
  }, 60000);

  it('supports --until filter', async () => {
    const result = await runCLI(['activity', cardId, '--until', '1h', '--format', 'json']);
    expect(result.exitCode).toBe(0);
    const entries = JSON.parse(result.stdout);
    expect(Array.isArray(entries)).toBe(true);
    const oneHourAgo = Date.now() - 3_600_000;
    for (const e of entries) {
      expect(new Date(e.time).getTime()).toBeLessThanOrEqual(oneHourAgo);
    }
  }, 60000);

  it('respects --limit option', async () => {
    const result = await runCLI(['activity', cardId, '--limit', '2', '--format', 'json']);
    expect(result.exitCode).toBe(0);
    // Favro ignores a `limit` param, so this only passes if we cap client-side.
    expect(JSON.parse(result.stdout).length).toBeLessThanOrEqual(2);
  }, 60000);

  it('rejects the retired `activity log <boardId>` form', async () => {
    const result = await runCLI(['activity', 'log', TEST_BOARD_ID]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/no board-level/i);
  }, 15000);

  it('rejects invalid --since format', async () => {
    const result = await runCLI(['activity', cardId, '--since', 'bad-format']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/invalid.*since/i);
  }, 15000);

  it('rejects invalid --format value', async () => {
    const result = await runCLI(['activity', cardId, '--format', 'xml']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/invalid format/i);
  }, 15000);

  it('fails gracefully when FAVRO_API_TOKEN is missing', async () => {
    const result = await runCLI(['activity', cardId], { FAVRO_API_TOKEN: '' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/FAVRO_API_TOKEN/);
  }, 15000);
});
