/**
 * Integration Tests — Webhooks API
 * CLA-1790 FAVRO-028: Implement Webhooks API
 *
 * Prerequisites:
 *   export FAVRO_API_TOKEN=<token>
 *   export FAVRO_TEST_BOARD_ID=<board-id>
 *
 * Note: A unique target URL with timestamp is used to avoid duplicate conflicts.
 * Webhooks created during tests are cleaned up in afterAll.
 */

import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

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

const API_TOKEN = process.env.FAVRO_API_TOKEN || '';
const INTEGRATION_GUARD = !!API_TOKEN;
const describeOrSkip = INTEGRATION_GUARD ? describe : describe.skip;

// Unique target URL for each test run to avoid duplicates
const TEST_TARGET_BASE = `https://webhook.site/favro-cli-test-${Date.now()}`;

const createdWebhookIds: string[] = [];

describeOrSkip('Webhooks — real API', () => {
  afterAll(async () => {
    // Cleanup: delete all webhooks created during tests
    for (const id of createdWebhookIds) {
      try {
        await runCLI(['webhooks', 'delete', id]);
      } catch {
        // ignore cleanup errors
      }
    }
  });

  it('lists webhooks as JSON (array)', async () => {
    const result = await runCLI(['webhooks', 'list', '--format', 'json']);
    expect(result.exitCode).toBe(0);
    const webhooks = JSON.parse(result.stdout);
    expect(Array.isArray(webhooks)).toBe(true);
  }, 30000);

  it('lists webhooks (default table format)', async () => {
    const result = await runCLI(['webhooks', 'list']);
    expect(result.exitCode).toBe(0);
    // Either shows "No webhooks configured." or a table
    expect(result.stdout.length + result.stderr.length).toBeGreaterThan(0);
  }, 30000);

  it('creates a webhook with card.created event', async () => {
    const result = await runCLI([
      'webhooks', 'create',
      '--event', 'card.created',
      '--target', `${TEST_TARGET_BASE}/created`,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/✓ Webhook created:/);
    const match = result.stdout.match(/✓ Webhook created:\s+(\S+)/);
    if (match?.[1]) {
      createdWebhookIds.push(match[1]);
    }
  }, 30000);

  it('lists the created webhook in results', async () => {
    if (createdWebhookIds.length === 0) {
      console.warn('Skipping: no webhook was created in previous test.');
      return;
    }
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
      '--target', `${TEST_TARGET_BASE}/updated`,
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
      '--target', `${TEST_TARGET_BASE}/invalid`,
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
    const dupTarget = `${TEST_TARGET_BASE}/dup-test`;

    // Create first webhook
    const first = await runCLI([
      'webhooks', 'create',
      '--event', 'card.created',
      '--target', dupTarget,
    ]);
    if (first.exitCode === 0) {
      const match = first.stdout.match(/✓ Webhook created:\s+(\S+)/);
      if (match?.[1]) createdWebhookIds.push(match[1]);
    }

    // Attempt to create a duplicate — should fail
    const second = await runCLI([
      'webhooks', 'create',
      '--event', 'card.created',
      '--target', dupTarget,
    ]);
    expect(second.exitCode).not.toBe(0);
    expect(second.stderr).toMatch(/[Dd]uplicate/i);
  }, 60000);

  it('deletes a webhook and shows confirmation', async () => {
    if (createdWebhookIds.length === 0) {
      console.warn('Skipping: no webhook was created to delete.');
      return;
    }

    const idToDelete = createdWebhookIds[createdWebhookIds.length - 1];
    const result = await runCLI(['webhooks', 'delete', idToDelete]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/✓ Webhook deleted:/);

    // Remove from cleanup list since it's already deleted
    createdWebhookIds.splice(createdWebhookIds.length - 1, 1);
  }, 30000);

  it('fails gracefully when FAVRO_API_TOKEN is missing', async () => {
    const result = await runCLI(['webhooks', 'list'], { FAVRO_API_TOKEN: '' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/FAVRO_API_TOKEN/);
  }, 15000);
});
