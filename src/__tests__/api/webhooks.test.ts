/**
 * Unit tests — FavroWebhooksAPI
 * CLA-1792 FAVRO-030: Integration Test Suite (coverage gap fix)
 */
import { FavroWebhooksAPI, isValidWebhookEvent, isValidWebhookUrl } from '../../api/webhooks';

const SAMPLE_WEBHOOK = {
  webhookId: 'wh-1',
  event: 'card.created',
  targetUrl: 'https://example.com/hook',
  organizationId: 'org-1',
  createdAt: '2024-01-01T00:00:00Z',
};

function makeMockClient(getResponse?: any, postResponse?: any, deleteResponse?: any): any {
  return {
    get: jest.fn().mockResolvedValue(getResponse ?? { entities: [] }),
    post: jest.fn().mockResolvedValue(postResponse ?? SAMPLE_WEBHOOK),
    delete: jest.fn().mockResolvedValue(undefined),
  };
}

// ─── Utility functions ────────────────────────────────────────────────────────

describe('isValidWebhookEvent', () => {
  it('accepts card.created', () => expect(isValidWebhookEvent('card.created')).toBe(true));
  it('accepts card.updated', () => expect(isValidWebhookEvent('card.updated')).toBe(true));
  it('rejects card.deleted', () => expect(isValidWebhookEvent('card.deleted')).toBe(false));
  it('rejects empty string', () => expect(isValidWebhookEvent('')).toBe(false));
  it('rejects arbitrary strings', () => expect(isValidWebhookEvent('random')).toBe(false));
});

describe('isValidWebhookUrl', () => {
  it('accepts HTTPS URL', () => expect(isValidWebhookUrl('https://example.com/hook')).toBe(true));
  it('accepts HTTP URL', () => expect(isValidWebhookUrl('http://localhost:3000/hook')).toBe(true));
  it('rejects FTP URL', () => expect(isValidWebhookUrl('ftp://example.com')).toBe(false));
  it('rejects empty string', () => expect(isValidWebhookUrl('')).toBe(false));
  it('rejects whitespace', () => expect(isValidWebhookUrl('   ')).toBe(false));
  it('rejects non-URL string', () => expect(isValidWebhookUrl('not-a-url')).toBe(false));
});

// ─── FavroWebhooksAPI.list ────────────────────────────────────────────────────

describe('FavroWebhooksAPI.list', () => {

  it('returns empty array when no webhooks', async () => {
    const client = makeMockClient({ entities: [] });
    const api = new FavroWebhooksAPI(client);
    const result = await api.list();
    expect(result).toEqual([]);
  });

  it('returns normalized webhooks', async () => {
    const client = makeMockClient({ entities: [SAMPLE_WEBHOOK] });
    const api = new FavroWebhooksAPI(client);
    const result = await api.list();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('wh-1');
    expect(result[0].event).toBe('card.created');
    expect(result[0].targetUrl).toBe('https://example.com/hook');
  });

  it('normalizes alternate field names (id, url)', async () => {
    const client = makeMockClient({
      entities: [{ id: 'wh-alt', event: 'card.updated', url: 'https://alt.com/hook', createdAt: '2024-01-01T00:00:00Z' }]
    });
    const api = new FavroWebhooksAPI(client);
    const result = await api.list();
    expect(result[0].id).toBe('wh-alt');
    expect(result[0].targetUrl).toBe('https://alt.com/hook');
  });

  it('paginates across multiple pages', async () => {
    const client = {
      get: jest.fn()
        .mockResolvedValueOnce({
          entities: [{ webhookId: 'wh-1', event: 'card.created', targetUrl: 'https://a.com', createdAt: '' }],
          requestId: 'req-1',
          pages: 2,
        })
        .mockResolvedValueOnce({
          entities: [{ webhookId: 'wh-2', event: 'card.updated', targetUrl: 'https://b.com', createdAt: '' }],
          requestId: 'req-1',
          pages: 2,
        })
        .mockResolvedValueOnce({ entities: [] }),
    };
    const api = new FavroWebhooksAPI(client as any);
    const result = await api.list();
    expect(result.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── FavroWebhooksAPI.create ──────────────────────────────────────────────────

describe('FavroWebhooksAPI.create', () => {

  it('creates a webhook and returns normalized result', async () => {
    const client = makeMockClient({ entities: [] }, SAMPLE_WEBHOOK);
    const api = new FavroWebhooksAPI(client);
    const result = await api.create('card.created', 'https://example.com/hook');
    expect(client.post).toHaveBeenCalledWith('/webhooks', {
      event: 'card.created',
      targetUrl: 'https://example.com/hook',
    });
    expect(result.id).toBe('wh-1');
  });

  it('throws for invalid event type', async () => {
    const client = makeMockClient({ entities: [] });
    const api = new FavroWebhooksAPI(client);
    await expect(api.create('card.deleted' as any, 'https://example.com/hook')).rejects.toThrow(/Invalid event type/);
  });

  it('throws for invalid URL', async () => {
    const client = makeMockClient({ entities: [] });
    const api = new FavroWebhooksAPI(client);
    await expect(api.create('card.created', 'not-a-url')).rejects.toThrow(/Invalid webhook URL/);
  });

  it('throws for duplicate webhook (same event + target)', async () => {
    const existing = [{ ...SAMPLE_WEBHOOK, id: 'wh-1', event: 'card.created', targetUrl: 'https://example.com/hook' }];
    // The list() call will return existing webhooks
    const client = {
      get: jest.fn().mockResolvedValue({ entities: [{ webhookId: 'wh-1', event: 'card.created', targetUrl: 'https://example.com/hook', createdAt: '' }] }),
      post: jest.fn(),
    };
    const api = new FavroWebhooksAPI(client as any);
    await expect(api.create('card.created', 'https://example.com/hook')).rejects.toThrow(/Duplicate/i);
  });

  it('handles 409 Conflict from API (duplicate)', async () => {
    const err: any = new Error('Conflict');
    err.response = { status: 409 };
    const client = {
      get: jest.fn().mockResolvedValue({ entities: [] }),
      post: jest.fn().mockRejectedValue(err),
    };
    const api = new FavroWebhooksAPI(client as any);
    await expect(api.create('card.created', 'https://example.com/hook')).rejects.toThrow(/Duplicate/i);
  });

  it('re-throws non-409 API errors', async () => {
    const err: any = new Error('Server error');
    err.response = { status: 500 };
    const client = {
      get: jest.fn().mockResolvedValue({ entities: [] }),
      post: jest.fn().mockRejectedValue(err),
    };
    const api = new FavroWebhooksAPI(client as any);
    await expect(api.create('card.created', 'https://example.com/hook')).rejects.toThrow('Server error');
  });

  it('trims whitespace from target URL', async () => {
    const client = makeMockClient({ entities: [] }, SAMPLE_WEBHOOK);
    const api = new FavroWebhooksAPI(client);
    await api.create('card.created', '  https://example.com/hook  ');
    expect(client.post).toHaveBeenCalledWith('/webhooks', {
      event: 'card.created',
      targetUrl: 'https://example.com/hook',
    });
  });
});

// ─── FavroWebhooksAPI.delete ──────────────────────────────────────────────────

describe('FavroWebhooksAPI.delete', () => {

  it('deletes a webhook by ID', async () => {
    const client = makeMockClient();
    const api = new FavroWebhooksAPI(client);
    await api.delete('wh-1');
    expect(client.delete).toHaveBeenCalledWith('/webhooks/wh-1');
  });

  it('throws when webhook ID is empty', async () => {
    const client = makeMockClient();
    const api = new FavroWebhooksAPI(client);
    await expect(api.delete('')).rejects.toThrow(/cannot be empty/);
    await expect(api.delete('   ')).rejects.toThrow(/cannot be empty/);
  });

  it('throws 404 as "not found" error', async () => {
    const err: any = new Error('Not found');
    err.response = { status: 404 };
    const client = {
      delete: jest.fn().mockRejectedValue(err),
    };
    const api = new FavroWebhooksAPI(client as any);
    await expect(api.delete('wh-nonexistent')).rejects.toThrow(/not found/i);
  });

  it('re-throws non-404 API errors', async () => {
    const err: any = new Error('Internal error');
    err.response = { status: 500 };
    const client = { delete: jest.fn().mockRejectedValue(err) };
    const api = new FavroWebhooksAPI(client as any);
    await expect(api.delete('wh-1')).rejects.toThrow('Internal error');
  });

  it('trims whitespace from webhook ID', async () => {
    const client = makeMockClient();
    const api = new FavroWebhooksAPI(client);
    await api.delete('  wh-1  ');
    expect(client.delete).toHaveBeenCalledWith('/webhooks/wh-1');
  });
});
