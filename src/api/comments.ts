/**
 * Comments API — FavroApiClient methods
 * CLA-1789 FAVRO-027: Comments & Activity API
 *
 * Favro comments endpoint: GET /comments?cardCommonId=<cardCommonId>
 * Note: requires cardCommonId (stable ID), not the per-widget cardId.
 * This client accepts cardId and resolves cardCommonId automatically.
 */
import FavroHttpClient from '../lib/http-client';
import { getAllPages } from '../lib/paginate';
import CardReferenceResolver from '../lib/card-reference';
import { Comment } from '../types/comments';

export { Comment };

interface RawComment {
  commentId?: string;
  id?: string;
  cardId?: string;
  cardCommonId?: string;
  userId?: string;
  text?: string;
  comment?: string;   // Favro uses "comment" field name
  created?: string;   // Favro uses "created" not "createdAt"
  createdAt?: string;
  updatedAt?: string;
}

function normalizeComment(raw: RawComment, fallbackCardId: string): Comment {
  return {
    commentId: raw.commentId ?? raw.id ?? '',
    cardId: raw.cardCommonId ?? raw.cardId ?? fallbackCardId,
    text: raw.comment ?? raw.text ?? '',
    // Favro sends a `userId` on a comment and nothing else identifying —
    // `author` / `user` were never on the wire.
    author: raw.userId,
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

    // Favro: GET /comments?cardCommonId=<cardCommonId>
    const raw = await getAllPages<RawComment>(this.client, '/comments', { cardCommonId }, { max: limit });
    return raw.map(r => normalizeComment(r, cardIdOrCommonId));
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
   * Resolve the `cardCommonId` this endpoint requires from any card reference —
   * `CLA-1804`, a `cardId` or a `cardCommonId` (#40).
   *
   * The old probe-first shape could not work: `GET /comments` answers an empty
   * list rather than an error for a `cardId`, so "it returned entities" proved
   * nothing and a wrong shape read as a card with no comments.
   */
  private async resolveCardCommonId(reference: string): Promise<string> {
    return new CardReferenceResolver(this.client).toCardCommonId(reference);
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
