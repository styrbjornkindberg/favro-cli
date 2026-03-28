/**
 * Integration Tests — Comments API
 * CLA-1789 FAVRO-027: Comments & Activity API
 *
 * Prerequisites:
 *   export FAVRO_API_TOKEN=<token>
 *   export FAVRO_TEST_BOARD_ID=<board-id>
 *
 * Optional for comment tests:
 *   export FAVRO_TEST_CARD_ID=<card-id>
 */

import { runCLI, integrationGuard, TEST_BOARD_ID } from './helpers';

const SKIP = !integrationGuard();
const describeOrSkip = SKIP ? describe.skip : describe;

const TEST_CARD_ID = process.env.FAVRO_TEST_CARD_ID || '';

describeOrSkip('Comments — real API', () => {
  it('fails gracefully when FAVRO_API_TOKEN is missing', async () => {
    const result = await runCLI(['comments', 'list', 'some-card-id'], { FAVRO_API_TOKEN: '' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/FAVRO_API_TOKEN/);
  }, 15000);
});

const describeCardOrSkip = SKIP || !TEST_CARD_ID ? describe.skip : describe;

describeCardOrSkip('Comments list — real API', () => {
  it('lists comments as table (zero or more)', async () => {
    const result = await runCLI(['comments', 'list', TEST_CARD_ID]);
    expect(result.exitCode).toBe(0);
    // Either "No comments found" or comments listed
    expect(result.stdout.length + result.stderr.length).toBeGreaterThan(0);
  }, 30000);

  it('lists comments as JSON (array)', async () => {
    const result = await runCLI(['comments', 'list', TEST_CARD_ID, '--json']);
    expect(result.exitCode).toBe(0);
    const comments = JSON.parse(result.stdout);
    expect(Array.isArray(comments)).toBe(true);
    for (const c of comments) {
      expect(c).toHaveProperty('commentId');
      expect(c).toHaveProperty('text');
    }
  }, 30000);

  it('respects --limit flag', async () => {
    const result = await runCLI(['comments', 'list', TEST_CARD_ID, '--limit', '1', '--json']);
    expect(result.exitCode).toBe(0);
    const comments = JSON.parse(result.stdout);
    expect(Array.isArray(comments)).toBe(true);
    expect(comments.length).toBeLessThanOrEqual(1);
  }, 30000);
});

describeCardOrSkip('Comments add — real API', () => {
  const addedCommentIds: string[] = [];

  it('adds a comment to a card', async () => {
    const timestamp = new Date().toISOString();
    const result = await runCLI([
      'comments', 'add', TEST_CARD_ID,
      '--text', `Integration test comment — ${timestamp}`,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Comment added/i);
  }, 30000);

  it('adds a comment and returns JSON', async () => {
    const timestamp = new Date().toISOString();
    const result = await runCLI([
      'comments', 'add', TEST_CARD_ID,
      '--text', `Integration test comment JSON — ${timestamp}`,
      '--json',
    ]);
    expect(result.exitCode).toBe(0);
    const comment = JSON.parse(result.stdout);
    expect(comment).toHaveProperty('commentId');
    expect(comment).toHaveProperty('text');
    addedCommentIds.push(comment.commentId);
  }, 30000);
});
