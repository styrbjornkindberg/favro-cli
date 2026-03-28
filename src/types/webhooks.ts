/**
 * Webhook Types
 * CLA-1790 FAVRO-028: Implement Webhooks API
 */

export interface Webhook {
  id: string;
  event: 'card.created' | 'card.updated';
  targetUrl: string;
  organizationId: string;
  createdAt: string;
  updatedAt?: string;
}

export type WebhookEvent = 'card.created' | 'card.updated';

export const VALID_WEBHOOK_EVENTS = ['card.created', 'card.updated'] as const;
