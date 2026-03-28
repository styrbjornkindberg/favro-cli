/**
 * Webhooks API — FavroWebhooksAPI
 * CLA-1790 FAVRO-028: Implement Webhooks API
 */
import FavroHttpClient from '../lib/http-client';
import { Webhook, WebhookEvent, VALID_WEBHOOK_EVENTS } from '../types/webhooks';

export { Webhook, WebhookEvent, VALID_WEBHOOK_EVENTS };

interface RawWebhook {
  webhookId?: string;
  id?: string;
  event?: string;
  targetUrl?: string;
  url?: string;
  organizationId?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface PaginatedResponse<T> {
  entities: T[];
  requestId?: string;
  pages?: number;
}

function normalizeWebhook(raw: RawWebhook): Webhook {
  return {
    id: raw.webhookId ?? raw.id ?? '',
    event: (raw.event ?? 'card.created') as WebhookEvent,
    targetUrl: raw.targetUrl ?? raw.url ?? '',
    organizationId: raw.organizationId ?? '',
    createdAt: raw.createdAt ?? '',
    updatedAt: raw.updatedAt,
  };
}

/**
 * Validate that the event is one of the accepted values.
 */
export function isValidWebhookEvent(event: string): event is WebhookEvent {
  return VALID_WEBHOOK_EVENTS.includes(event as WebhookEvent);
}

/**
 * Validate that the target URL is a valid HTTP/HTTPS URL.
 */
export function isValidWebhookUrl(url: string): boolean {
  if (!url || !url.trim()) return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export class FavroWebhooksAPI {
  constructor(private client: FavroHttpClient) {}

  /**
   * List all webhooks for the organization.
   */
  async list(): Promise<Webhook[]> {
    const allWebhooks: Webhook[] = [];
    let requestId: string | undefined;
    let page = 1;

    while (true) {
      const params: Record<string, any> = { limit: 100 };
      if (requestId) {
        params.requestId = requestId;
        params.page = page;
      }

      const response = await this.client.get<PaginatedResponse<RawWebhook>>(
        '/webhooks',
        { params }
      );

      const batch = (response.entities ?? []).map(normalizeWebhook);
      allWebhooks.push(...batch);

      requestId = response.requestId;
      if (!requestId || !response.pages || page >= response.pages || batch.length === 0) break;
      page++;
    }

    return allWebhooks;
  }

  /**
   * Create a webhook with the given event and target URL.
   * Validates inputs and checks for duplicates before calling the API.
   */
  async create(event: WebhookEvent, target: string): Promise<Webhook> {
    if (!isValidWebhookEvent(event)) {
      throw new Error(
        `Invalid event type: "${event}". Must be one of: ${VALID_WEBHOOK_EVENTS.join(', ')}`
      );
    }

    if (!isValidWebhookUrl(target)) {
      throw new Error(
        `Invalid webhook URL: "${target}". Must be a valid HTTP or HTTPS URL.`
      );
    }

    // Check for duplicates before creating
    const existing = await this.list();
    const duplicate = existing.find(
      w => w.event === event && w.targetUrl === target.trim()
    );
    if (duplicate) {
      throw new Error(
        `Duplicate webhook: a webhook for event "${event}" targeting "${target}" already exists (ID: ${duplicate.id}).`
      );
    }

    try {
      const raw = await this.client.post<RawWebhook>('/webhooks', {
        event,
        targetUrl: target.trim(),
      });
      return normalizeWebhook(raw);
    } catch (error: any) {
      // Handle 409 Conflict from Favro API (duplicate webhook)
      if (error.response?.status === 409) {
        throw new Error(
          `Duplicate webhook: a webhook for event "${event}" targeting "${target}" already exists.`
        );
      }
      throw error;
    }
  }

  /**
   * Delete a webhook by ID.
   */
  async delete(webhookId: string): Promise<void> {
    if (!webhookId || !webhookId.trim()) {
      throw new Error('Webhook ID cannot be empty.');
    }

    try {
      await this.client.delete(`/webhooks/${webhookId.trim()}`);
    } catch (error: any) {
      if (error.response?.status === 404) {
        throw new Error(`Webhook not found: "${webhookId}". It may have already been deleted.`);
      }
      throw error;
    }
  }
}

export default FavroWebhooksAPI;
