/**
 * Activity API — Board Activity Log
 * CLA-1789: FAVRO-027: Comments & Activity API
 *
 * Provides paginated board activity logs with optional time filtering.
 */
import FavroHttpClient from './http-client';
import { PaginatedResponse } from './cards-api';
import { parseSince } from './audit-api';

export { parseSince };

export interface ActivityEntry {
  activityId: string;
  boardId?: string;
  cardId?: string;
  cardName?: string;
  type: string;
  description: string;
  author?: string;
  authorEmail?: string;
  createdAt: string;
}

export interface ListActivityOptions {
  /** Filter entries after this time. Accepts strings like "2h", "1d", "1w". */
  since?: string;
  /** Maximum entries to return. Default 50, max 500. */
  limit?: number;
  /** Output format: "json" or "table". Default "table". */
  format?: string;
}

/**
 * Format a timestamp as relative or absolute.
 *
 * @param isoString  ISO 8601 timestamp string (or null/undefined)
 * @param format     "relative" (default) or "absolute"
 */
export function formatActivityTimestamp(
  isoString: string | null | undefined,
  format: 'relative' | 'absolute' = 'relative'
): string {
  // Explicit falsy guard BEFORE new Date()
  // new Date(null) returns epoch, new Date(undefined) returns Invalid Date
  if (!isoString) return '(unknown time)';

  const date = new Date(isoString);
  if (isNaN(date.getTime())) return isoString;

  if (format === 'absolute') {
    return date.toISOString();
  }

  // Relative format
  const diffMs = Date.now() - date.getTime();
  return formatRelative(diffMs);
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
    const label = days === 1 ? 'yesterday' : `${days} days ago`;
    return future ? (days === 1 ? 'tomorrow' : `in ${days} days`) : label;
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

export class ActivityAPI {
  constructor(private client: FavroHttpClient) {}

  /**
   * List activity entries for a board with pagination and optional --since filter.
   *
   * @param boardId  Board ID
   * @param options  Filter/limit options
   */
  async list(boardId: string, options: ListActivityOptions = {}): Promise<ActivityEntry[]> {
    const limitRaw = options.limit !== undefined ? Number(options.limit) : NaN;
    const limit = isNaN(limitRaw) || limitRaw < 1 ? 50 : Math.min(limitRaw, 500);

    let sinceCutoff: Date | undefined;
    if (options.since) {
      sinceCutoff = parseSince(options.since);
    }

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

      const response = await this.client.get<PaginatedResponse<ActivityEntry>>(
        `/boards/${boardId}/activity`,
        { params }
      );

      const batch = response.entities ?? [];

      // Filter by since cutoff
      for (const entry of batch) {
        if (sinceCutoff) {
          // Explicit falsy guard before new Date()
          if (!entry.createdAt) continue;
          const entryDate = new Date(entry.createdAt);
          if (isNaN(entryDate.getTime())) continue;
          if (entryDate < sinceCutoff) continue;
        }
        entries.push(entry);
        if (entries.length >= limit) break;
      }

      if (response.requestId) {
        requestId = response.requestId;
        totalPages = response.pages ?? 1;
        // Increment page locally — NEVER use response.page (may always return 0)
        page += 1;
      } else {
        break;
      }
      if (batch.length === 0) break;
    }

    return entries;
  }
}

export default ActivityAPI;
