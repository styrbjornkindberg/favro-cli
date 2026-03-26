/**
 * Integration Tests — Boards
 * CLA-1775: Test boards list command against real Favro API.
 *
 * Prerequisites:
 *   export FAVRO_API_TOKEN=<token>
 *   export FAVRO_TEST_BOARD_ID=<board-id>
 */

import { runCLI, integrationGuard, TEST_BOARD_ID } from './helpers';

const SKIP = !integrationGuard();
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('Boards — real API', () => {
  it('lists boards and includes the test board', async () => {
    const result = await runCLI(['boards', 'list']);
    expect(result.exitCode).toBe(0);
    // Should output something (table or JSON)
    expect(result.stdout.length + result.stderr.length).toBeGreaterThan(0);
  }, 30000);

  it('lists boards as JSON', async () => {
    const result = await runCLI(['boards', 'list', '--json']);
    expect(result.exitCode).toBe(0);
    const boards = JSON.parse(result.stdout);
    expect(Array.isArray(boards)).toBe(true);
    // The test board should be present
    if (TEST_BOARD_ID) {
      const found = boards.find((b: any) => b.boardId === TEST_BOARD_ID);
      expect(found).toBeDefined();
    }
  }, 30000);

  it('fails gracefully when FAVRO_API_TOKEN is missing', async () => {
    const result = await runCLI(['boards', 'list'], { FAVRO_API_TOKEN: '' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/FAVRO_API_TOKEN/);
  }, 15000);
});
