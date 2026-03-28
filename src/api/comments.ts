/**
 * Comments API — FavroApiClient methods
 * CLA-1789 FAVRO-027: Comments & Activity API
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
  text?: string;
  comment?: string; // alternate field name used by some Favro endpoints
  author?: string;
  user?: string;    // alternate author field
  createdAt?: string;
  updatedAt?: string;
}

function normalizeComment(raw: RawComment, cardId: string): Comment {
  return {
    commentId: raw.commentId ?? raw.id ?? '',
    cardId: raw.cardId ?? cardId,
    text: raw.text ?? raw.comment ?? '',
    author: raw.author ?? raw.user,
    createdAt: raw.createdAt ?? '',
    updatedAt: raw.updatedAt,
  };
}

export class CommentsApiClient {
  constructor(private client: FavroHttpClient) {}

  /**
   * List all comments for a card, with automatic pagination.
   */
  async listComments(cardId: string, limit: number = 100): Promise<Comment[]> {
    const allComments: Comment[] = [];
    let requestId: string | undefined;
    let page = 1;

    while (allComments.length < limit) {
      const params: Record<string, unknown> = {
        limit: Math.min(limit - allComments.length, 100),
      };
      if (requestId) {
        params.requestId = requestId;
        params.page = page;
      }

      const response = await this.client.get<PaginatedResponse<RawComment>>(
        `/cards/${cardId}/comments`,
        { params }
      );

      const batch = (response.entities ?? []).map(raw => normalizeComment(raw, cardId));
      allComments.push(...batch);

      requestId = response.requestId;
      if (!requestId || !response.pages || page >= response.pages || batch.length === 0) break;
      page++;
    }

    return allComments.slice(0, limit);
  }

  /**
   * Add a comment to a card.
   */
  async addComment(cardId: string, text: string): Promise<Comment> {
    if (!text || !text.trim()) {
      throw new Error('Comment text cannot be empty.');
    }

    const raw = await this.client.post<RawComment>(
      `/cards/${cardId}/comments`,
      { comment: text.trim() }
    );
    return normalizeComment(raw, cardId);
  }
}

export default CommentsApiClient;
