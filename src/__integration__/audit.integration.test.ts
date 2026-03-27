/**
 * Integration Tests — Audit & Change Log Commands
 * CLA-1802: FAVRO-040: Audit & Change Log Commands
 *
 * Prerequisites:
 *   export FAVRO_API_TOKEN=<token>
 *   export FAVRO_TEST_BOARD_ID=<board-id>
 *
 * These tests run against a real Favro board.
 * They are skipped when env vars are not set.
 */

import { runCLI, integrationGuard, TEST_BOARD_ID } from './helpers';

const SKIP = !integrationGuard();
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('favro audit — real board', () => {
  it('returns audit entries for a board', async () => {
    const result = await runCLI(['audit', TEST_BOARD_ID]);
    expect(result.exitCode).toBe(0);
    // Either found entries or prints "No audit entries found"
    expect(result.stdout + result.stderr).toMatch(/audit log|No audit entries found/i);
  }, 30000);

  it('filters audit entries with --since 1w', async () => {
    const result = await runCLI(['audit', TEST_BOARD_ID, '--since', '1w']);
    expect(result.exitCode).toBe(0);
  }, 30000);

  it('outputs JSON with --json flag', async () => {
    const result = await runCLI(['audit', TEST_BOARD_ID, '--json']);
    expect(result.exitCode).toBe(0);
    // Should be valid JSON
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  }, 30000);

  it('exits with code 1 for invalid --since value', async () => {
    const result = await runCLI(['audit', TEST_BOARD_ID, '--since', 'badvalue']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Invalid --since value');
  }, 15000);
});

describeOrSkip('favro who-changed — real board', () => {
  it('shows "no cards found" message for unknown title', async () => {
    const result = await runCLI(['who-changed', '__nonexistent_card_xyz_12345__', '--board', TEST_BOARD_ID]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No cards found matching');
  }, 30000);

  it('outputs JSON format with --json flag', async () => {
    // Use a partial title that may match something — just test the JSON format
    // (exits 1 if no match, exits 0 if found)
    const result = await runCLI(['who-changed', 'a', '--board', TEST_BOARD_ID, '--json']);
    if (result.exitCode === 0) {
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      const parsed = JSON.parse(result.stdout);
      expect(Array.isArray(parsed)).toBe(true);
    } else {
      expect(result.stderr).toContain('No cards found matching');
    }
  }, 30000);
});
