/**
 * Unit tests — webhooks CLI commands
 * CLA-1790 FAVRO-028: Implement Webhooks API
 */
import { Command } from 'commander';
import { registerWebhooksCommand } from '../../commands/webhooks';
import * as config from '../../lib/config';
import * as apiWebhooks from '../../api/webhooks';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../api/webhooks');

const MockFavroWebhooksAPI = apiWebhooks.FavroWebhooksAPI as jest.MockedClass<typeof apiWebhooks.FavroWebhooksAPI>;

const SAMPLE_WEBHOOKS = [
  {
    id: 'wh-1',
    event: 'card.created',
    targetUrl: 'https://example.com/webhook1',
    organizationId: 'org-1',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'wh-2',
    event: 'card.updated',
    targetUrl: 'https://example.com/webhook2',
    organizationId: 'org-1',
    createdAt: '2026-01-02T00:00:00.000Z',
  },
];

function buildProgram(): Command {
  const program = new Command();
  // The runner's three flags live on the root (ADR-0002).
  program.option('--verbose', 'Show stack traces').option('--human').option('--pretty');
  registerWebhooksCommand(program);
  return program;
}

async function runCli(args: string[]): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  await program.parseAsync(['node', 'favro', ...args]);
}

beforeEach(() => {
  jest.clearAllMocks();
  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
});

// ─── webhooks list ─────────────────────────────────────────────────────────────

describe('favro webhooks list', () => {
  let consoleSpy: jest.SpyInstance;
  let consoleTableSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleTableSpy = jest.spyOn(console, 'table').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleTableSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('shows "no webhooks" message when list is empty', async () => {
    MockFavroWebhooksAPI.prototype.list = jest.fn().mockResolvedValue([]);

    await runCli(['webhooks', 'list', '--human']);

    expect(MockFavroWebhooksAPI.prototype.list).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith('No webhooks configured.');
  });

  it('shows table under --human when webhooks exist', async () => {
    MockFavroWebhooksAPI.prototype.list = jest.fn().mockResolvedValue(SAMPLE_WEBHOOKS);

    await runCli(['webhooks', 'list', '--human']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('2 webhook'));
    expect(consoleTableSpy).toHaveBeenCalled();
  });

  it('answers the rows envelope by default \u2014 --format is gone (#116)', async () => {
    MockFavroWebhooksAPI.prototype.list = jest.fn().mockResolvedValue(SAMPLE_WEBHOOKS);

    await runCli(['webhooks', 'list']);

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify({ rows: SAMPLE_WEBHOOKS }));
    expect(consoleTableSpy).not.toHaveBeenCalled();
  });

  it('an empty list still prints an envelope rather than nothing', async () => {
    // ADR-0002: a successful command never prints nothing.
    MockFavroWebhooksAPI.prototype.list = jest.fn().mockResolvedValue([]);

    await runCli(['webhooks', 'list']);

    expect(consoleSpy).toHaveBeenCalledWith('{"rows":[]}');
  });

  it('answers an error envelope when the API key is missing', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);

    await runCli(['webhooks', 'list']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/^\{"error":/));
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });
});

// ─── webhooks create ──────────────────────────────────────────────────────────

describe('favro webhooks create', () => {
  let consoleSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('creates webhook with valid event and target', async () => {
    const created = {
      id: 'wh-new',
      event: 'card.created',
      targetUrl: 'https://example.com/webhook',
      organizationId: 'org-1',
      createdAt: '2026-01-03T00:00:00.000Z',
    };
    MockFavroWebhooksAPI.prototype.create = jest.fn().mockResolvedValue(created);

    await runCli(['webhooks', 'create', '--event', 'card.created', '--target', 'https://example.com/webhook', '--human']);

    expect(MockFavroWebhooksAPI.prototype.create).toHaveBeenCalledWith(
      'card.created',
      'https://example.com/webhook'
    );
    const printed = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('✓ Webhook created: wh-new');
    expect(printed).toContain('card.created');
    expect(printed).toContain('https://example.com/webhook');
  });

  it('a successful create prints the webhook in JSON mode too', async () => {
    // The regression #113's own review caught: a success path that prints
    // nothing is the silent-no-output failure ADR-0002 exists to kill.
    const created = { id: 'wh-new', event: 'card.created', targetUrl: 'https://example.com/webhook' };
    MockFavroWebhooksAPI.prototype.create = jest.fn().mockResolvedValue(created);

    await runCli(['webhooks', 'create', '--event', 'card.created', '--target', 'https://example.com/webhook']);

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(created));
  });

  it('--dry-run answers a parseable preview instead of a prose line', async () => {
    MockFavroWebhooksAPI.prototype.create = jest.fn();

    await runCli(['webhooks', 'create', '--event', 'card.created', '--target', 'https://example.com/x', '--dry-run']);

    expect(MockFavroWebhooksAPI.prototype.create).not.toHaveBeenCalled();
    expect(JSON.parse(String(consoleSpy.mock.calls[0][0]))).toEqual({
      dryRun: true, event: 'card.created', targetUrl: 'https://example.com/x',
    });
  });

  it('creates webhook with card.updated event', async () => {
    const created = {
      id: 'wh-upd',
      event: 'card.updated',
      targetUrl: 'https://api.example.com/hooks',
      organizationId: 'org-1',
      createdAt: '2026-01-03T00:00:00.000Z',
    };
    MockFavroWebhooksAPI.prototype.create = jest.fn().mockResolvedValue(created);

    await runCli(['webhooks', 'create', '--event', 'card.updated', '--target', 'https://api.example.com/hooks']);

    expect(MockFavroWebhooksAPI.prototype.create).toHaveBeenCalledWith(
      'card.updated',
      'https://api.example.com/hooks'
    );
  });

  const errorEnvelope = (spy: jest.SpyInstance) =>
    JSON.parse(spy.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('{"error"'))!);

  it.each([
    ['an invalid event type', 'Invalid event type: "card.deleted". Must be one of: card.created, card.updated', ['--event', 'card.deleted', '--target', 'https://example.com/hook']],
    ['an invalid URL', 'Invalid webhook URL: "not-a-url". Must be a valid HTTP or HTTPS URL.', ['--event', 'card.created', '--target', 'not-a-url']],
    ['a duplicate webhook', 'Duplicate webhook: a webhook for event "card.created" already exists (ID: wh-1).', ['--event', 'card.created', '--target', 'https://example.com/webhook']],
  ])('answers an error envelope on stdout for %s', async (_name, message, args) => {
    MockFavroWebhooksAPI.prototype.create = jest.fn().mockRejectedValue(new Error(message));

    await runCli(['webhooks', 'create', ...args]);

    expect(errorEnvelope(consoleSpy).error.message).toBe(message);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it('answers an error envelope when the API key is missing', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);

    await runCli(['webhooks', 'create', '--event', 'card.created', '--target', 'https://example.com']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/^\{"error":/));
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });
});

// ─── webhooks delete ──────────────────────────────────────────────────────────

describe('favro webhooks delete', () => {
  let consoleSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('deletes a webhook by ID and shows confirmation', async () => {
    MockFavroWebhooksAPI.prototype.delete = jest.fn().mockResolvedValue(undefined);

    await runCli(['webhooks', 'delete', 'wh-1', '--human']);

    expect(MockFavroWebhooksAPI.prototype.delete).toHaveBeenCalledWith('wh-1');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('✓ Webhook deleted: wh-1'));
  });

  it('a successful delete prints a parseable result in JSON mode', async () => {
    MockFavroWebhooksAPI.prototype.delete = jest.fn().mockResolvedValue(undefined);

    await runCli(['webhooks', 'delete', 'wh-1']);

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify({ deleted: true, webhookId: 'wh-1' }));
  });

  it('answers an error envelope when the webhook is not found', async () => {
    const message = 'Webhook not found: "nonexistent-id". It may have already been deleted.';
    MockFavroWebhooksAPI.prototype.delete = jest.fn().mockRejectedValue(new Error(message));

    await runCli(['webhooks', 'delete', 'nonexistent-id']);

    const envelope = JSON.parse(consoleSpy.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('{"error"'))!);
    expect(envelope.error.message).toBe(message);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it('answers an error envelope when the API key is missing', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);

    await runCli(['webhooks', 'delete', 'wh-1']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/^\{"error":/));
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });
});

// ─── API module: isValidWebhookEvent ──────────────────────────────────────────

describe('isValidWebhookEvent', () => {
  const { isValidWebhookEvent: realFn } = jest.requireActual('../../api/webhooks') as typeof apiWebhooks;

  it('accepts card.created', () => {
    expect(realFn('card.created')).toBe(true);
  });

  it('accepts card.updated', () => {
    expect(realFn('card.updated')).toBe(true);
  });

  it('rejects invalid events', () => {
    expect(realFn('card.deleted')).toBe(false);
    expect(realFn('')).toBe(false);
    expect(realFn('card.moved')).toBe(false);
  });
});

// ─── API module: isValidWebhookUrl ────────────────────────────────────────────

describe('isValidWebhookUrl', () => {
  const { isValidWebhookUrl: realFn } = jest.requireActual('../../api/webhooks') as typeof apiWebhooks;

  it('accepts http URLs', () => {
    expect(realFn('http://example.com/webhook')).toBe(true);
  });

  it('accepts https URLs', () => {
    expect(realFn('https://example.com/webhook')).toBe(true);
  });

  it('rejects non-URL strings', () => {
    expect(realFn('not-a-url')).toBe(false);
    expect(realFn('ftp://example.com')).toBe(false);
    expect(realFn('')).toBe(false);
  });

  it('rejects blank/empty strings', () => {
    expect(realFn('')).toBe(false);
    expect(realFn('   ')).toBe(false);
  });
});
