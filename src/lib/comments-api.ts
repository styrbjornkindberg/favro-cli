/**
 * Comments API — Card Comments
 * CLA-1789: FAVRO-027: Comments & Activity API
 *
 * Provides listing and adding comments on Favro cards.
 * Favro endpoint: GET /comments?cardCommonId=<cardCommonId>
 * Note: Uses cardCommonId (not cardId) — pass card.cardCommonId
 */
import FavroHttpClient from './http-client';
import { PaginatedResponse } from './cards-api';

/** Raw comment shape from Favro REST API */
interface RawComment {
  commentId: string;
  cardCommonId?: string;
  userId?: string;
  comment?: string;       // Favro uses "comment" not "text"
  created?: string;       // Favro uses "created" not "createdAt"
  text?: string;          // fallback
  createdAt?: string;     // fallback
}

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

function normalizeComment(raw: RawComment): Comment {
  return {
    commentId: raw.commentId,
    cardId: raw.cardCommonId ?? '',
    text: raw.comment ?? raw.text ?? '',
    createdAt: raw.created ?? raw.createdAt ?? '',
    author: raw.userId,
  };
}

export class CommentsAPI {
  constructor(private client: FavroHttpClient) {}

  /**
   * List all comments on a card with pagination.
   * @param cardCommonId  The card's cardCommonId (NOT cardId).
   *                      Use card.cardCommonId from a listCards/getCard result.
   */
  async list(cardCommonId: string): Promise<Comment[]> {
    const comments: Comment[] = [];
    let page = 0;
    let totalPages = 1;
    let requestId: string | undefined;

    while (page < totalPages) {
      const params: Record<string, unknown> = {
        cardCommonId,
      };
      if (requestId) {
        params.requestId = requestId;
        params.page = page;
      }

      const response = await this.client.get<PaginatedResponse<RawComment>>(
        '/comments',
        { params }
      );

      const batch = (response.entities ?? []).map(normalizeComment);
      comments.push(...batch);

      if (response.requestId) {
        requestId = response.requestId;
        totalPages = response.pages ?? 1;
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
   * @param cardCommonId  The card's cardCommonId (NOT cardId).
   */
  async add(cardCommonId: string, text: string): Promise<Comment> {
    const payload = {
      cardCommonId,
      comment: text,
    };
    const raw = await this.client.post<RawComment>('/comments', payload);
    return normalizeComment(raw);
  }
}

export default CommentsAPI;
