/**
 * Integration Tests — Activity API
 * CLA-1789 FAVRO-027: Comments & Activity API
 *
 * Prerequisites:
 *   export FAVRO_API_TOKEN=<token>
 *   export FAVRO_TEST_BOARD_ID=<board-id>
 */

import { runCLI, integrationGuard, TEST_BOARD_ID } from './helpers';

const SKIP = !integrationGuard();
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('Activity log — real API', () => {
  it('shows activity log as table', async () => {
    const result = await runCLI(['activity', 'log', TEST_BOARD_ID]);
    expect(result.exitCode).toBe(0);
    // Either "No activity found" or activity listed
    expect(result.stdout.length + result.stderr.length).toBeGreaterThan(0);
  }, 60000);

  it('shows activity log as JSON (array)', async () => {
    const result = await runCLI(['activity', 'log', TEST_BOARD_ID, '--format', 'json']);
    expect(result.exitCode).toBe(0);
    const entries = JSON.parse(result.stdout);
    expect(Array.isArray(entries)).toBe(true);
    for (const e of entries) {
      expect(e).toHaveProperty('activityId');
      expect(e).toHaveProperty('type');
      expect(e).toHaveProperty('createdAt');
    }
  }, 60000);

  it('shows activity log with --json shorthand', async () => {
    const result = await runCLI(['activity', 'log', TEST_BOARD_ID, '--json']);
    expect(result.exitCode).toBe(0);
    const entries = JSON.parse(result.stdout);
    expect(Array.isArray(entries)).toBe(true);
  }, 60000);

  it('supports --since filter (1d)', async () => {
    const result = await runCLI(['activity', 'log', TEST_BOARD_ID, '--since', '1d', '--format', 'json']);
    expect(result.exitCode).toBe(0);
    const entries = JSON.parse(result.stdout);
    expect(Array.isArray(entries)).toBe(true);
    // All entries should be within the last day
    const oneDayAgo = Date.now() - 86_400_000;
    for (const e of entries) {
      expect(new Date(e.createdAt).getTime()).toBeGreaterThanOrEqual(oneDayAgo);
    }
  }, 60000);

  it('supports --since filter (1h)', async () => {
    const result = await runCLI(['activity', 'log', TEST_BOARD_ID, '--since', '1h', '--format', 'json']);
    expect(result.exitCode).toBe(0);
    const entries = JSON.parse(result.stdout);
    expect(Array.isArray(entries)).toBe(true);
  }, 60000);

  it('respects --limit option', async () => {
    const result = await runCLI(['activity', 'log', TEST_BOARD_ID, '--limit', '5', '--format', 'json']);
    expect(result.exitCode).toBe(0);
    const entries = JSON.parse(result.stdout);
    expect(entries.length).toBeLessThanOrEqual(5);
  }, 60000);

  it('respects --offset option (pagination)', async () => {
    const result1 = await runCLI(['activity', 'log', TEST_BOARD_ID, '--limit', '10', '--format', 'json']);
    const result2 = await runCLI(['activity', 'log', TEST_BOARD_ID, '--limit', '5', '--offset', '5', '--format', 'json']);

    if (result1.exitCode === 0 && result2.exitCode === 0) {
      const all = JSON.parse(result1.stdout);
      const page2 = JSON.parse(result2.stdout);
      if (all.length >= 10 && page2.length > 0) {
        // Entries from offset 5 should match last 5 entries of first page
        expect(page2[0].activityId).toBe(all[5].activityId);
      }
    }
  }, 60000);

  it('rejects invalid --since format', async () => {
    const result = await runCLI(['activity', 'log', TEST_BOARD_ID, '--since', 'bad-format']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/invalid.*since/i);
  }, 15000);

  it('rejects invalid --format value', async () => {
    const result = await runCLI(['activity', 'log', TEST_BOARD_ID, '--format', 'xml']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/invalid format/i);
  }, 15000);

  it('fails gracefully when FAVRO_API_TOKEN is missing', async () => {
    const result = await runCLI(['activity', 'log', TEST_BOARD_ID], { FAVRO_API_TOKEN: '' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/FAVRO_API_TOKEN/);
  }, 15000);
});
