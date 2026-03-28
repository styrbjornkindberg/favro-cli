/**
 * Comments API — Card Comments
 * CLA-1789: FAVRO-027: Comments & Activity API
 *
 * Provides listing and adding comments on Favro cards.
 */
import FavroHttpClient from './http-client';
import { PaginatedResponse } from './cards-api';

export interface Comment {
  commentId: string;
  cardId: string;
  text: string;
  createdAt: string;
  updatedAt?: string;
  author?: string;
  authorEmail?: string;
}

export interface CreateCommentRequest {
  cardId: string;
  comment: string;
}

export class CommentsAPI {
  constructor(private client: FavroHttpClient) {}

  /**
   * List all comments on a card with pagination.
   * Returns comments sorted by createdAt ascending (oldest first).
   */
  async list(cardId: string): Promise<Comment[]> {
    const comments: Comment[] = [];
    let page = 0;
    let totalPages = 1;
    let requestId: string | undefined;

    while (page < totalPages) {
      const params: Record<string, unknown> = {};
      if (requestId) {
        params.requestId = requestId;
        params.page = page;
      }

      const response = await this.client.get<PaginatedResponse<Comment>>(
        `/cards/${cardId}/comments`,
        { params }
      );

      const batch = response.entities ?? [];
      comments.push(...batch);

      if (response.requestId) {
        requestId = response.requestId;
        totalPages = response.pages ?? 1;
        // Increment page locally — never trust response.page to avoid infinite loop
        page += 1;
      } else {
        break;
      }
      if (batch.length === 0) break;
    }

    return comments;
  }

  /**
   * Add a comment to a card.
   * Returns the created comment object.
   */
  async add(cardId: string, text: string): Promise<Comment> {
    const payload: CreateCommentRequest = {
      cardId,
      comment: text,
    };
    return this.client.post<Comment>('/comments', payload);
  }
}

export default CommentsAPI;
