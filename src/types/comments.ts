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

export interface ActivityEntry {
  activityId: string;
  boardId?: string;
  cardId?: string;
  cardName?: string;
  type: string;
  description: string;
  author?: string;
  createdAt: string;
}
