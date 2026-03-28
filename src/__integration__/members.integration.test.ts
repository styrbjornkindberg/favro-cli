/**
 * Integration Tests — Members & Permissions
 * CLA-1788 FAVRO-026: Members & Permissions API
 *
 * Prerequisites:
 *   export FAVRO_API_TOKEN=<token>
 *   export FAVRO_TEST_BOARD_ID=<board-id>
 *
 * Optional for add test:
 *   export FAVRO_TEST_MEMBER_EMAIL=<email-to-add>
 *   export FAVRO_TEST_MEMBER_ID=<existing-member-id>
 */

import { runCLI, integrationGuard, TEST_BOARD_ID } from './helpers';

const SKIP = !integrationGuard();
const describeOrSkip = SKIP ? describe.skip : describe;

const TEST_MEMBER_EMAIL = process.env.FAVRO_TEST_MEMBER_EMAIL || '';
const TEST_MEMBER_ID = process.env.FAVRO_TEST_MEMBER_ID || '';

describeOrSkip('Members — real API', () => {
  it('lists members without filters', async () => {
    const result = await runCLI(['members', 'list']);
    expect(result.exitCode).toBe(0);
    // Should output members table or "No members found."
    expect(result.stdout.length + result.stderr.length).toBeGreaterThan(0);
  }, 30000);

  it('lists members as JSON (array)', async () => {
    const result = await runCLI(['members', 'list', '--json']);
    expect(result.exitCode).toBe(0);
    const members = JSON.parse(result.stdout);
    expect(Array.isArray(members)).toBe(true);
    for (const m of members) {
      expect(m).toHaveProperty('id');
      expect(m).toHaveProperty('email');
    }
  }, 30000);

  it('lists members filtered by board', async () => {
    if (!TEST_BOARD_ID) return;
    const result = await runCLI(['members', 'list', '--board', TEST_BOARD_ID]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length + result.stderr.length).toBeGreaterThan(0);
  }, 30000);

  it('errors when both --board and --collection are specified', async () => {
    const result = await runCLI(['members', 'list', '--board', 'board-1', '--collection', 'coll-1']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/cannot specify both/i);
  }, 15000);

  it('fails gracefully when FAVRO_API_TOKEN is missing', async () => {
    const result = await runCLI(['members', 'list'], { FAVRO_API_TOKEN: '' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/FAVRO_API_TOKEN/);
  }, 15000);
});

const describeAddOrSkip = SKIP || !TEST_MEMBER_EMAIL ? describe.skip : describe;

describeAddOrSkip('Members add — real API', () => {
  it('adds a member by email to a board', async () => {
    const result = await runCLI([
      'members', 'add', TEST_MEMBER_EMAIL,
      '--to', TEST_BOARD_ID,
      '--board-target',
    ]);
    // May succeed or fail with "already a member"; either is acceptable in integration context
    expect([0, 1]).toContain(result.exitCode);
    if (result.exitCode === 0) {
      expect(result.stdout).toMatch(/Member added/i);
    }
  }, 30000);

  it('rejects invalid email format', async () => {
    const result = await runCLI([
      'members', 'add', 'not-an-email',
      '--to', TEST_BOARD_ID,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/invalid email/i);
  }, 15000);
});

const describePermOrSkip = SKIP || !TEST_MEMBER_ID ? describe.skip : describe;

describePermOrSkip('Members permissions — real API', () => {
  it('returns permission level for a member on a board', async () => {
    const result = await runCLI([
      'members', 'permissions', TEST_MEMBER_ID,
      '--board', TEST_BOARD_ID,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/(viewer|editor|admin)/i);
  }, 30000);

  it('returns JSON with permissionLevel field', async () => {
    const result = await runCLI([
      'members', 'permissions', TEST_MEMBER_ID,
      '--board', TEST_BOARD_ID,
      '--json',
    ]);
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data).toHaveProperty('memberId', TEST_MEMBER_ID);
    expect(data).toHaveProperty('boardId', TEST_BOARD_ID);
    expect(['viewer', 'editor', 'admin']).toContain(data.permissionLevel);
  }, 30000);
});
