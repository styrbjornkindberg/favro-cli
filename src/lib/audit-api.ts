/**
 * Audit API — Change Log & Activity
 * CLA-1802: FAVRO-040: Audit & Change Log Commands
 *
 * Wraps Favro card activity endpoints with pagination support.
 */
import FavroHttpClient from './http-client';
import { PaginatedResponse } from './cards-api';
import CardsAPI, { Card } from './cards-api';

export interface ActivityEntry {
  activityId: string;
  cardId: string;
  cardName?: string;
  type: string;
  description: string;
  author?: string;
  createdAt: string;
}

export interface AuditEntry {
  cardId: string;
  cardName: string;
  changeType: string;
  description: string;
  author?: string;
  timestamp: string;
}

/**
 * Parse a --since string like "1h", "1d", "1w" into a Date cutoff.
 * Returns undefined if input is null/undefined.
 * Throws if format is unrecognised.
 */
export function parseSince(since: string | undefined): Date | undefined {
  if (since === undefined || since === null) return undefined;
  const trimmed = since.trim();
  if (trimmed === '') {
    throw new Error(
      `Invalid --since value "${since}". Use format: 1h, 1d, 1w (hours, days, weeks).`
    );
  }
  const match = trimmed.match(/^(\d+)(h|d|w)$/i);
  if (!match) {
    throw new Error(
      `Invalid --since value "${trimmed}". Use format: 1h, 1d, 1w (hours, days, weeks).`
    );
  }
  const amount = parseInt(match[1], 10);
  if (amount === 0) {
    throw new Error(
      `Invalid --since value "${trimmed}". Amount must be greater than 0.`
    );
  }
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };
  return new Date(Date.now() - amount * multipliers[unit]);
}

/**
 * Format a timestamp in both relative and absolute (ISO 8601) form.
 * E.g.: "2 hours ago (2026-03-25T14:30:00.000Z)"
 */
export function formatTimestamp(isoString: string | null | undefined): string {
  // Explicit guard: null/undefined/empty must not be passed to new Date()
  // (new Date(null) returns epoch 1970-01-01, not an invalid date)
  if (!isoString) return '(unknown time)';
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return isoString;

  const diffMs = Date.now() - date.getTime();
  const relative = formatRelative(diffMs);
  return `${relative} (${date.toISOString()})`;
}

/**
 * Format a millisecond difference as a human-readable relative string.
 */
export function formatRelative(diffMs: number): string {
  const abs = Math.abs(diffMs);
  const future = diffMs < 0;

  if (abs < 60_000) {
    return future ? 'in a few seconds' : 'just now';
  }
  const minutes = Math.floor(abs / 60_000);
  if (minutes < 60) {
    const label = minutes === 1 ? '1 minute' : `${minutes} minutes`;
    return future ? `in ${label}` : `${label} ago`;
  }
  const hours = Math.floor(abs / 3_600_000);
  if (hours < 24) {
    const label = hours === 1 ? '1 hour' : `${hours} hours`;
    return future ? `in ${label}` : `${label} ago`;
  }
  const days = Math.floor(abs / 86_400_000);
  if (days < 7) {
    const label = days === 1 ? '1 day' : `${days} days`;
    return future ? `in ${label}` : `${label} ago`;
  }
  const weeks = Math.floor(days / 7);
  if (weeks < 52) {
    const label = weeks === 1 ? '1 week' : `${weeks} weeks`;
    return future ? `in ${label}` : `${label} ago`;
  }
  const years = Math.floor(weeks / 52);
  const label = years === 1 ? '1 year' : `${years} years`;
  return future ? `in ${label}` : `${label} ago`;
}

export class AuditAPI {
  private cardsApi: CardsAPI;

  constructor(private client: FavroHttpClient) {
    this.cardsApi = new CardsAPI(client);
  }

  /**
   * Get activity entries for a single card with pagination.
   * Falls back to deriving a synthetic entry from the card's metadata if
   * the activity endpoint is not available.
   */
  async getCardActivity(cardId: string, limit: number = 200): Promise<ActivityEntry[]> {
    const entries: ActivityEntry[] = [];
    let page = 0;
    let totalPages = 1;
    let requestId: string | undefined;

    while (entries.length < limit && page < totalPages) {
      const params: Record<string, unknown> = {
        limit: Math.min(limit - entries.length, 100),
      };
      if (requestId) {
        params.requestId = requestId;
        params.page = page;
      }

      try {
        const response = await this.client.get<PaginatedResponse<ActivityEntry>>(
          `/cards/${cardId}/activity`,
          { params }
        );
        const batch = response.entities ?? [];
        entries.push(...batch);

        if (response.requestId) {
          requestId = response.requestId;
          totalPages = response.pages ?? 1;
          // Increment page locally — never trust response.page to avoid infinite loop
          // if API always returns page: 0
          page += 1;
        } else {
          break;
        }
        if (batch.length === 0) break;
      } catch {
        // Activity endpoint not available — return empty
        break;
      }
    }

    return entries.slice(0, limit);
  }

  /**
   * Get all audit entries for a board by fetching cards and their activity.
   * Filters by `since` cutoff when provided.
   *
   * @param boardId  Board ID
   * @param since    Optional cutoff date — only return entries after this date
   * @param limit    Max total entries to return
   */
  async getBoardAuditLog(
    boardId: string,
    since?: Date,
    limit: number = 500
  ): Promise<AuditEntry[]> {
    // Fetch all cards on the board
    const cards = await this.cardsApi.listCards(boardId, 1000);

    // Filter cards to those updated since the cutoff
    const relevant = since
      ? cards.filter(c => {
          const ts = c.updatedAt || c.createdAt;
          if (!ts) return false;
          return new Date(ts) >= since;
        })
      : cards;

    // Build audit entries from card metadata
    const entries: AuditEntry[] = [];

    for (const card of relevant) {
      if (entries.length >= limit) break;

      // Try fetching activity for this card
      const activity = await this.getCardActivity(card.cardId, 50);

      if (activity.length > 0) {
        for (const act of activity) {
          const ts = act.createdAt;
          if (since && new Date(ts) < since) continue;
          entries.push({
            cardId: card.cardId,
            cardName: card.name,
            changeType: act.type,
            description: act.description,
            author: act.author,
            timestamp: ts,
          });
          if (entries.length >= limit) break;
        }
      } else {
        // Fallback: synthesize from card metadata
        const updatedEntry = this.cardToAuditEntry(card, 'updated', card.updatedAt || card.createdAt);
        if (updatedEntry) {
          if (!since || new Date(updatedEntry.timestamp) >= since) {
            entries.push(updatedEntry);
          }
        }
        if (card.createdAt !== card.updatedAt) {
          const createdEntry = this.cardToAuditEntry(card, 'created', card.createdAt);
          if (createdEntry && (!since || new Date(createdEntry.timestamp) >= since)) {
            entries.push(createdEntry);
          }
        }
      }
    }

    // Sort by timestamp descending (newest first)
    entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return entries.slice(0, limit);
  }

  /**
   * Find cards by name (case-insensitive substring match) and return their audit history.
   *
   * @param cardTitle  Search term to match against card names
   * @param boardId    Optional board ID to restrict search
   * @param limit      Max entries to return
   */
  async getCardHistory(
    cardTitle: string,
    boardId?: string,
    limit: number = 200
  ): Promise<{ card: Card; entries: AuditEntry[] }[]> {
    const cards = await this.cardsApi.listCards(boardId, 1000);
    const titleLc = cardTitle.toLowerCase();
    const matched = cards.filter(c => c.name?.toLowerCase().includes(titleLc));

    const results: { card: Card; entries: AuditEntry[] }[] = [];

    for (const card of matched) {
      const activity = await this.getCardActivity(card.cardId, limit);
      let entries: AuditEntry[];

      if (activity.length > 0) {
        entries = activity.map(act => ({
          cardId: card.cardId,
          cardName: card.name,
          changeType: act.type,
          description: act.description,
          author: act.author,
          timestamp: act.createdAt,
        }));
      } else {
        // Fallback: derive from card metadata
        entries = [];
        const createdEntry = this.cardToAuditEntry(card, 'created', card.createdAt);
        if (createdEntry) entries.push(createdEntry);
        if (card.updatedAt && card.updatedAt !== card.createdAt) {
          const updatedEntry = this.cardToAuditEntry(card, 'updated', card.updatedAt);
          if (updatedEntry) entries.push(updatedEntry);
        }
      }

      entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      results.push({ card, entries: entries.slice(0, limit) });
    }

    return results;
  }

  private cardToAuditEntry(card: Card, type: string, timestamp: string | undefined): AuditEntry | null {
    if (!timestamp) return null;
    return {
      cardId: card.cardId,
      cardName: card.name,
      changeType: type,
      description: type === 'created' ? `Card "${card.name}" was created` : `Card "${card.name}" was updated`,
      timestamp,
    };
  }
}

export default AuditAPI;
