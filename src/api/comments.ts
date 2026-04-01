/**
 * Comments API — FavroApiClient methods
 * CLA-1789 FAVRO-027: Comments & Activity API
 *
 * Favro comments endpoint: GET /comments?cardCommonId=<cardCommonId>
 * Note: requires cardCommonId (stable ID), not the per-widget cardId.
 * This client accepts cardId and resolves cardCommonId automatically.
 */
import FavroHttpClient from '../lib/http-client';
import { Comment } from '../types/comments';

export { Comment };

interface PaginatedResponse<T> {
  entities: T[];
  requestId?: string;
  pages?: number;
}

interface RawComment {
  commentId?: string;
  id?: string;
  cardId?: string;
  cardCommonId?: string;
  userId?: string;
  text?: string;
  comment?: string;   // Favro uses "comment" field name
  author?: string;
  user?: string;
  created?: string;   // Favro uses "created" not "createdAt"
  createdAt?: string;
  updatedAt?: string;
}

function normalizeComment(raw: RawComment, fallbackCardId: string): Comment {
  return {
    commentId: raw.commentId ?? raw.id ?? '',
    cardId: raw.cardCommonId ?? raw.cardId ?? fallbackCardId,
    text: raw.comment ?? raw.text ?? '',
    author: raw.userId ?? raw.author ?? raw.user,
    createdAt: raw.created ?? raw.createdAt ?? '',
    updatedAt: raw.updatedAt,
  };
}

export class CommentsApiClient {
  constructor(private client: FavroHttpClient) {}

  /**
   * List all comments for a card.
   * Accepts either cardId or cardCommonId — will resolve cardCommonId automatically if needed.
   */
  async listComments(cardIdOrCommonId: string, limit: number = 100): Promise<Comment[]> {
    // Resolve cardCommonId: if the passed ID is a 24-char hex cardId, look it up
    const cardCommonId = await this.resolveCardCommonId(cardIdOrCommonId);

    const allComments: Comment[] = [];
    let requestId: string | undefined;
    let page = 1;

    while (allComments.length < limit) {
      const params: Record<string, unknown> = {
        cardCommonId,
        limit: Math.min(limit - allComments.length, 100),
      };
      if (requestId) {
        params.requestId = requestId;
        params.page = page;
      }

      // Favro: GET /comments?cardCommonId=<cardCommonId>
      const response = await this.client.get<PaginatedResponse<RawComment>>(
        '/comments',
        { params }
      );

      const batch = (response.entities ?? []).map(raw => normalizeComment(raw, cardIdOrCommonId));
      allComments.push(...batch);

      requestId = response.requestId;
      if (!requestId || !response.pages || page >= response.pages || batch.length === 0) break;
      page++;
    }

    return allComments.slice(0, limit);
  }

  /**
   * Add a comment to a card.
   * Accepts either cardId or cardCommonId.
   */
  async addComment(cardIdOrCommonId: string, text: string): Promise<Comment> {
    if (!text || !text.trim()) {
      throw new Error('Comment text cannot be empty.');
    }
    const cardCommonId = await this.resolveCardCommonId(cardIdOrCommonId);
    const raw = await this.client.post<RawComment>(
      '/comments',
      { cardCommonId, comment: text.trim() }
    );
    return normalizeComment(raw, cardIdOrCommonId);
  }

  /**
   * Resolve cardCommonId from either a cardId or a cardCommonId.
   * Favro cardIds are 24-char hex; cardCommonIds are also 24-char hex.
   * We can't tell them apart by format, so we try cardCommonId directly first,
   * and fall back to looking up by cardId.
   */
  private async resolveCardCommonId(cardIdOrCommonId: string): Promise<string> {
    // Try using as-is first — Favro will 404 if it's a per-widget cardId
    try {
      const response = await this.client.get<PaginatedResponse<RawComment>>(
        '/comments',
        { params: { cardCommonId: cardIdOrCommonId, limit: 1 } }
      );
      if (response.entities !== undefined) {
        // It worked as-is — it's already a cardCommonId (or returned results)
        return cardIdOrCommonId;
      }
    } catch {
      // Fall through to lookup
    }

    // Look up the card to get its cardCommonId
    try {
      const card = await this.client.get<{ cardCommonId?: string }>(`/cards/${cardIdOrCommonId}`);
      if (card.cardCommonId) return card.cardCommonId;
    } catch {
      // Last resort: use as-is
    }

    return cardIdOrCommonId;
  }

  /**
   * Get a single comment by its commentId.
   * Favro: GET /comments/:commentId
   */
  async getComment(commentId: string): Promise<Comment> {
    const raw = await this.client.get<RawComment>(`/comments/${commentId}`);
    return normalizeComment(raw, raw.cardCommonId ?? raw.cardId ?? '');
  }

  /**
   * Update a comment's text.
   * Favro: PUT /comments/:commentId
   */
  async updateComment(commentId: string, text: string): Promise<Comment> {
    if (!text || !text.trim()) {
      throw new Error('Comment text cannot be empty.');
    }
    const raw = await this.client.put<RawComment>(`/comments/${commentId}`, { comment: text.trim() });
    return normalizeComment(raw, raw.cardCommonId ?? raw.cardId ?? '');
  }

  /**
   * Delete a comment by its commentId.
   * Favro: DELETE /comments/:commentId
   */
  async deleteComment(commentId: string): Promise<void> {
    await this.client.delete(`/comments/${commentId}`);
  }
}

export default CommentsApiClient;
