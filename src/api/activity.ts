/**
 * Activity API — Board Activity Log
 * CLA-1789 FAVRO-027: Comments & Activity API
 *
 * Fetches activity/audit log for a board with pagination and --since filter support.
 * Re-uses parseSince and formatTimestamp from the existing audit-api.
 */
import FavroHttpClient from '../lib/http-client';
import { ActivityEntry } from '../types/comments';
import { parseSince, formatTimestamp } from '../lib/audit-api';
import CardsAPI from '../lib/cards-api';

export { ActivityEntry, parseSince, formatTimestamp };

interface PaginatedResponse<T> {
  entities: T[];
  requestId?: string;
  pages?: number;
}

interface RawActivity {
  activityId?: string;
  id?: string;
  cardId?: string;
  type?: string;
  action?: string;
  description?: string;
  message?: string;
  author?: string;
  user?: string;
  createdAt?: string;
  timestamp?: string;
}

function normalizeActivity(raw: RawActivity, boardId?: string): ActivityEntry {
  return {
    activityId: raw.activityId ?? raw.id ?? '',
    boardId: boardId,
    cardId: raw.cardId,
    type: raw.type ?? raw.action ?? 'activity',
    description: raw.description ?? raw.message ?? '',
    author: raw.author ?? raw.user,
    createdAt: raw.createdAt ?? raw.timestamp ?? '',
  };
}

export class ActivityApiClient {
  private cardsApi: CardsAPI;

  constructor(private client: FavroHttpClient) {
    this.cardsApi = new CardsAPI(client);
  }

  /**
   * Get activity log for a board.
   *
   * Favro doesn't expose a direct board-level activity endpoint, so we fetch
   * cards on the board and aggregate their card-level activity.
   *
   * @param boardId  Board ID
   * @param since    Optional cutoff — only return entries after this date
   * @param limit    Max total entries to return (default 200)
   * @param offset   Number of entries to skip from the start (default 0)
   */
  async getBoardActivity(
    boardId: string,
    since?: Date,
    limit: number = 200,
    offset: number = 0
  ): Promise<ActivityEntry[]> {
    // Fetch cards on the board
    const cards = await this.cardsApi.listCards(boardId, 1000);

    // Filter to cards updated since cutoff (early optimisation)
    const relevant = since
      ? cards.filter(c => {
          const ts = c.updatedAt || c.createdAt;
          if (!ts) return false;
          return new Date(ts) >= since;
        })
      : cards;

    const all: ActivityEntry[] = [];

    for (const card of relevant) {
      if (all.length >= offset + limit) break;

      const cardActivity = await this.getCardActivity(card.cardId, 50);

      if (cardActivity.length > 0) {
        for (const entry of cardActivity) {
          if (since && new Date(entry.createdAt) < since) continue;
          // Attach card name from card metadata
          if (!entry.cardName) {
            (entry as any).cardName = card.name;
          }
          all.push(entry);
        }
      } else {
        // Fallback: synthesize from card metadata
        const updatedAt = card.updatedAt || card.createdAt;
        if (updatedAt && (!since || new Date(updatedAt) >= since)) {
          all.push({
            activityId: `${card.cardId}-updated`,
            boardId,
            cardId: card.cardId,
            cardName: card.name,
            type: 'updated',
            description: `Card "${card.name}" was updated`,
            createdAt: updatedAt,
          });
        }
        if (card.createdAt && card.createdAt !== card.updatedAt &&
            (!since || new Date(card.createdAt) >= since)) {
          all.push({
            activityId: `${card.cardId}-created`,
            boardId,
            cardId: card.cardId,
            cardName: card.name,
            type: 'created',
            description: `Card "${card.name}" was created`,
            createdAt: card.createdAt,
          });
        }
      }
    }

    // Sort by timestamp descending (newest first)
    all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return all.slice(offset, offset + limit);
  }

  /**
   * Get activity entries for a single card with pagination.
   */
  async getCardActivity(cardId: string, limit: number = 100): Promise<ActivityEntry[]> {
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
        const response = await this.client.get<PaginatedResponse<RawActivity>>(
          // Favro: /cards/:cardId/activities (plural)
          `/cards/${cardId}/activities`,
          { params }
        );
        const batch = (response.entities ?? []).map(raw => normalizeActivity(raw));
        entries.push(...batch);

        if (response.requestId) {
          requestId = response.requestId;
          totalPages = response.pages ?? 1;
          page += 1;
        } else {
          break;
        }
        if (batch.length === 0) break;
      } catch {
        // Activity endpoint not available — return what we have
        break;
      }
    }

    return entries.slice(0, limit);
  }
}

export default ActivityApiClient;
