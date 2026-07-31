/**
 * Comments & Activity Types
 * CLA-1789 FAVRO-027: Comments & Activity API
 */

export interface Comment {
  commentId: string;
  cardId: string;
  text: string;
  author?: string;
  createdAt: string;
  updatedAt?: string;
}

/**
 * A row from `GET /cards/:cardId/activities` — the only activity endpoint Favro
 * has (issue #18). Field names are Favro's own, and the list is exhaustive:
 * probed live, the wire carries no `activityId`, `description`, `author` or
 * `createdAt`, so nothing here may be invented for display.
 */
export interface ActivityEntry {
  type: string;
  /** Why this row is visible to the requesting user: news | follow | news and follow. */
  source?: string;
  cardId: string;
  cardCommonId?: string;
  cardName?: string;
  widgetCommonId?: string;
  widgetName?: string;
  columnId?: string;
  columnName?: string;
  organizationId?: string;
  /** ISO 8601 timestamp of the activity. */
  time: string;
  byUserId?: string;
}
