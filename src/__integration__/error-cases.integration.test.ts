/**
 * Integration Tests — Error Cases
 * CLA-1775: Verify graceful error handling for invalid inputs against real API.
 *
 * Prerequisites:
 *   export FAVRO_API_TOKEN=<token>
 *   export FAVRO_TEST_BOARD_ID=<board-id>
 *
 * These tests intentionally cause errors and verify helpful messages are shown.
 */

import { runCLI, integrationGuard, TEST_BOARD_ID } from './helpers';

const SKIP = !integrationGuard();
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('Error cases — real Favro API', () => {

  // ─── Missing token ────────────────────────────────────────────────────────

  it('cards list: fails with helpful message when FAVRO_API_TOKEN is missing', async () => {
    const result = await runCLI(
      ['cards', 'list', '--board', TEST_BOARD_ID],
      { FAVRO_API_TOKEN: '' }
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/FAVRO_API_TOKEN/);
  }, 15000);

  it('cards create: fails with helpful message when FAVRO_API_TOKEN is missing', async () => {
    const result = await runCLI(
      ['cards', 'create', 'Test card', '--board', TEST_BOARD_ID],
      { FAVRO_API_TOKEN: '' }
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/FAVRO_API_TOKEN/);
  }, 15000);

  it('cards export: fails with helpful message when FAVRO_API_TOKEN is missing', async () => {
    const result = await runCLI(
      ['cards', 'export', TEST_BOARD_ID, '--format', 'json'],
      { FAVRO_API_TOKEN: '' }
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/FAVRO_API_TOKEN/);
  }, 15000);

  // ─── Non-existent card ────────────────────────────────────────────────────

  it('cards update: graceful error for non-existent card ID', async () => {
    const result = await runCLI([
      'cards', 'update', 'nonexistent-card-id-00000000',
      '--status', 'Done',
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/✗ Error:/);
    // Should not throw an unhandled rejection
    expect(result.stderr).not.toMatch(/UnhandledPromiseRejection/);
  }, 30000);

  // ─── Invalid board ────────────────────────────────────────────────────────

  it('cards list: graceful error for invalid board ID', async () => {
    const result = await runCLI([
      'cards', 'list',
      '--board', 'invalid-board-id-000000',
    ]);
    // May return empty list or error — should not crash
    expect(result.stderr).not.toMatch(/UnhandledPromiseRejection/);
    // If exit code is non-zero, stderr should have a message
    if (result.exitCode !== 0) {
      expect(result.stderr).toMatch(/✗/);
    }
  }, 30000);

  it('cards export: graceful error for invalid board ID', async () => {
    const result = await runCLI([
      'cards', 'export', 'invalid-board-id-000000',
      '--format', 'json',
    ]);
    // Should exit non-zero with a descriptive error
    if (result.exitCode !== 0) {
      expect(result.stderr.length).toBeGreaterThan(0);
    }
    expect(result.stderr).not.toMatch(/UnhandledPromiseRejection/);
  }, 30000);

  // ─── Invalid export format ────────────────────────────────────────────────

  it('cards export: rejects invalid format flag', async () => {
    const result = await runCLI([
      'cards', 'export', TEST_BOARD_ID,
      '--format', 'xml',
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Invalid format/i);
  }, 15000);

  // ─── Invalid token ────────────────────────────────────────────────────────

  it('cards list: graceful 401 for invalid token', async () => {
    const result = await runCLI(
      ['cards', 'list', '--board', TEST_BOARD_ID],
      { FAVRO_API_TOKEN: 'invalid-token-abc123' }
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/✗ Error:/);
    expect(result.stderr).not.toMatch(/UnhandledPromiseRejection/);
  }, 30000);

  // ─── Missing bulk file ────────────────────────────────────────────────────

  it('cards create --bulk: graceful error for missing file', async () => {
    const result = await runCLI([
      'cards', 'create', 'ignored-title',
      '--bulk', '/tmp/nonexistent-file-999.json',
      '--board', TEST_BOARD_ID,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/✗ Error:/);
  }, 15000);
});
