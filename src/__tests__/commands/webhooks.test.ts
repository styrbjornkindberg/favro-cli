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
  program.option('--verbose', 'Show stack traces');
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

    await runCli(['webhooks', 'list']);

    expect(MockFavroWebhooksAPI.prototype.list).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith('No webhooks configured.');
  });

  it('shows table when webhooks exist', async () => {
    MockFavroWebhooksAPI.prototype.list = jest.fn().mockResolvedValue(SAMPLE_WEBHOOKS);

    await runCli(['webhooks', 'list']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('2 webhook'));
    expect(consoleTableSpy).toHaveBeenCalled();
  });

  it('outputs JSON when --format json is set', async () => {
    MockFavroWebhooksAPI.prototype.list = jest.fn().mockResolvedValue(SAMPLE_WEBHOOKS);

    await runCli(['webhooks', 'list', '--format', 'json']);

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(SAMPLE_WEBHOOKS, null, 2));
    expect(consoleTableSpy).not.toHaveBeenCalled();
  });

  it('defaults to table format', async () => {
    MockFavroWebhooksAPI.prototype.list = jest.fn().mockResolvedValue(SAMPLE_WEBHOOKS);

    await runCli(['webhooks', 'list']);

    expect(consoleTableSpy).toHaveBeenCalled();
  });

  it('exits with error when API key is missing', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);
    const processExit = jest.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${code}`);
    });

    await expect(runCli(['webhooks', 'list'])).rejects.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error:'));
    processExit.mockRestore();
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

    await runCli(['webhooks', 'create', '--event', 'card.created', '--target', 'https://example.com/webhook']);

    expect(MockFavroWebhooksAPI.prototype.create).toHaveBeenCalledWith(
      'card.created',
      'https://example.com/webhook'
    );
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('✓ Webhook created: wh-new'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('card.created'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('https://example.com/webhook'));
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

  it('shows error message for invalid event type', async () => {
    const processExit = jest.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${code}`);
    });
    MockFavroWebhooksAPI.prototype.create = jest.fn().mockRejectedValue(
      new Error('Invalid event type: "card.deleted". Must be one of: card.created, card.updated')
    );

    await expect(runCli(['webhooks', 'create', '--event', 'card.deleted', '--target', 'https://example.com/hook'])).rejects.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid event type'));
    processExit.mockRestore();
  });

  it('shows error message for invalid URL', async () => {
    const processExit = jest.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${code}`);
    });
    MockFavroWebhooksAPI.prototype.create = jest.fn().mockRejectedValue(
      new Error('Invalid webhook URL: "not-a-url". Must be a valid HTTP or HTTPS URL.')
    );

    await expect(runCli(['webhooks', 'create', '--event', 'card.created', '--target', 'not-a-url'])).rejects.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid webhook URL'));
    processExit.mockRestore();
  });

  it('shows error for duplicate webhook', async () => {
    const processExit = jest.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${code}`);
    });
    MockFavroWebhooksAPI.prototype.create = jest.fn().mockRejectedValue(
      new Error('Duplicate webhook: a webhook for event "card.created" targeting "https://example.com/webhook" already exists (ID: wh-1).')
    );

    await expect(runCli(['webhooks', 'create', '--event', 'card.created', '--target', 'https://example.com/webhook'])).rejects.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Duplicate webhook'));
    processExit.mockRestore();
  });

  it('exits with error when API key is missing', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);
    const processExit = jest.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${code}`);
    });

    await expect(runCli(['webhooks', 'create', '--event', 'card.created', '--target', 'https://example.com'])).rejects.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error:'));
    processExit.mockRestore();
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

    await runCli(['webhooks', 'delete', 'wh-1']);

    expect(MockFavroWebhooksAPI.prototype.delete).toHaveBeenCalledWith('wh-1');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('✓ Webhook deleted: wh-1'));
  });

  it('shows error when webhook not found', async () => {
    const processExit = jest.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${code}`);
    });
    MockFavroWebhooksAPI.prototype.delete = jest.fn().mockRejectedValue(
      new Error('Webhook not found: "nonexistent-id". It may have already been deleted.')
    );

    await expect(runCli(['webhooks', 'delete', 'nonexistent-id'])).rejects.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Webhook not found'));
    processExit.mockRestore();
  });

  it('exits with error when API key is missing', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);
    const processExit = jest.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${code}`);
    });

    await expect(runCli(['webhooks', 'delete', 'wh-1'])).rejects.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error:'));
    processExit.mockRestore();
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
