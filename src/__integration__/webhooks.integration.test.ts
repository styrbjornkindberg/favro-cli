/**
 * Integration Tests — Webhooks API
 * CLA-1790 FAVRO-028: Implement Webhooks API
 *
 * Prerequisites:
 *   export FAVRO_API_TOKEN=<token>
 *   export FAVRO_TEST_BOARD_ID=<board-id>
 *
 * Note: These tests use a unique target URL with a timestamp to avoid duplicate conflicts.
 * Webhooks created during tests are cleaned up after the suite.
 */

import { runCLI, integrationGuard } from './helpers';

const SKIP = !integrationGuard();
const describeOrSkip = SKIP ? describe.skip : describe;

// Unique target URL for each test run to avoid duplicates
const TEST_TARGET_URL = `https://webhook.site/test-${Date.now()}`;

const createdWebhookIds: string[] = [];

describeOrSkip('Webhooks — real API', () => {
  afterAll(async () => {
    // Cleanup: delete all webhooks created during tests
    for (const id of createdWebhookIds) {
      await runCLI(['webhooks', 'delete', id]);
    }
  });

  it('lists webhooks (may be empty)', async () => {
    const result = await runCLI(['webhooks', 'list']);
    expect(result.exitCode).toBe(0);
    // Either shows "No webhooks configured." or a table
    expect(result.stdout.length + result.stderr.length).toBeGreaterThan(0);
  }, 30000);

  it('lists webhooks as JSON (array)', async () => {
    const result = await runCLI(['webhooks', 'list', '--format', 'json']);
    expect(result.exitCode).toBe(0);
    const webhooks = JSON.parse(result.stdout);
    expect(Array.isArray(webhooks)).toBe(true);
  }, 30000);

  it('creates a webhook with card.created event', async () => {
    const result = await runCLI([
      'webhooks', 'create',
      '--event', 'card.created',
      '--target', `${TEST_TARGET_URL}/created`,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/✓ Webhook created:/);
    // Extract the webhook ID from output "✓ Webhook created: <id>"
    const match = result.stdout.match(/✓ Webhook created:\s+(\S+)/);
    if (match?.[1]) {
      createdWebhookIds.push(match[1]);
    }
  }, 30000);

  it('lists created webhook in results', async () => {
    // Only meaningful if we created one
    if (createdWebhookIds.length === 0) return;

    const result = await runCLI(['webhooks', 'list', '--format', 'json']);
    expect(result.exitCode).toBe(0);
    const webhooks = JSON.parse(result.stdout);
    const found = webhooks.find((w: any) => createdWebhookIds.includes(w.id));
    expect(found).toBeDefined();
  }, 30000);

  it('creates a webhook with card.updated event', async () => {
    const result = await runCLI([
      'webhooks', 'create',
      '--event', 'card.updated',
      '--target', `${TEST_TARGET_URL}/updated`,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/✓ Webhook created:/);
    const match = result.stdout.match(/✓ Webhook created:\s+(\S+)/);
    if (match?.[1]) {
      createdWebhookIds.push(match[1]);
    }
  }, 30000);

  it('rejects invalid event type', async () => {
    const result = await runCLI([
      'webhooks', 'create',
      '--event', 'card.deleted',
      '--target', `${TEST_TARGET_URL}/invalid`,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Invalid event type/i);
  }, 30000);

  it('rejects invalid URL', async () => {
    const result = await runCLI([
      'webhooks', 'create',
      '--event', 'card.created',
      '--target', 'not-a-valid-url',
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Invalid webhook URL/i);
  }, 30000);

  it('rejects duplicate webhook', async () => {
    // Create first webhook
    const first = await runCLI([
      'webhooks', 'create',
      '--event', 'card.created',
      '--target', `${TEST_TARGET_URL}/dup-test`,
    ]);
    if (first.exitCode === 0) {
      const match = first.stdout.match(/✓ Webhook created:\s+(\S+)/);
      if (match?.[1]) createdWebhookIds.push(match[1]);
    }

    // Attempt to create a duplicate
    const second = await runCLI([
      'webhooks', 'create',
      '--event', 'card.created',
      '--target', `${TEST_TARGET_URL}/dup-test`,
    ]);
    expect(second.exitCode).not.toBe(0);
    expect(second.stderr).toMatch(/[Dd]uplicate/i);
  }, 60000);

  it('deletes a webhook and confirms', async () => {
    if (createdWebhookIds.length === 0) return;

    const idToDelete = createdWebhookIds[0];
    const result = await runCLI(['webhooks', 'delete', idToDelete]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/✓ Webhook deleted:/);

    // Remove from list so cleanup doesn't try to delete again
    createdWebhookIds.splice(0, 1);
  }, 30000);

  it('fails gracefully when FAVRO_API_TOKEN is missing', async () => {
    const result = await runCLI(['webhooks', 'list'], { FAVRO_API_TOKEN: '' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/FAVRO_API_TOKEN/);
  }, 15000);
});
