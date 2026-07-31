/**
 * Activity API — card activity log
 * CLA-1789 FAVRO-027: Comments & Activity API
 *
 * Favro exposes exactly one activity endpoint: `GET /cards/:cardId/activities`.
 * `/boards/:id/activity`, `/widgets/:id/activity`, `/activities` and the singular
 * `/cards/:cardId/activity` are all 404-with-an-HTML-page (probed in #15/#18), so
 * there is no board-level feed to aggregate and no per-card sweep is attempted —
 * that would be derived-N fan-out, which this CLI does not do.
 *
 * The feed is notification-scoped per viewer (`source`), so a card the API-key
 * user neither follows nor has news for can read thin. It is history for humans,
 * never a source of truth for a card's state.
 */
import FavroHttpClient from '../lib/http-client';
import { ActivityEntry } from '../types/comments';
import { parseSince, formatTimestamp } from '../lib/audit-api';

export { ActivityEntry, parseSince, formatTimestamp };

interface PaginatedResponse<T> {
  entities: T[];
  requestId?: string;
  pages?: number;
}

export interface CardActivityOptions {
  /** Only return activity at or after this time. */
  since?: Date;
  /** Only return activity at or before this time. */
  until?: Date;
  /** Max entries to return. Applied client-side — Favro ignores a `limit` param. */
  limit?: number;
}

export class ActivityApiClient {
  constructor(private client: FavroHttpClient) {}

  /**
   * Get the activity log for a single card, newest first.
   *
   * `since` / `until` are pushed to Favro as ISO 8601 strings and filter
   * server-side; an unparseable value is a 400, so callers must pass real Dates.
   *
   * @param cardId   Card ID — the board instance whose activity is wanted
   * @param options  Time window and result cap
   */
  async getCardActivity(cardId: string, options: CardActivityOptions = {}): Promise<ActivityEntry[]> {
    const params: Record<string, unknown> = {};
    if (options.since) params.since = options.since.toISOString();
    if (options.until) params.until = options.until.toISOString();

    // ponytail: one call, no pagination loop. Favro ignores `limit`, `page` and
    // `requestId` on this endpoint (probed: limit=2 still returns all 22 rows),
    // so a paging loop would refetch the same page and duplicate every row.
    const response = await this.client.get<PaginatedResponse<ActivityEntry>>(
      `/cards/${cardId}/activities`,
      { params }
    );

    const entries = response.entities ?? [];
    return options.limit !== undefined ? entries.slice(0, options.limit) : entries;
  }
}

export default ActivityApiClient;
