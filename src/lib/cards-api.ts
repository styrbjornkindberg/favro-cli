import FavroHttpClient from './http-client';

export interface CustomField {
  fieldId: string;
  name: string;
  value: unknown;
  type?: string;
}

export interface CardLink {
  linkId: string;
  type: 'depends' | 'blocks' | 'duplicates' | 'relates';
  cardId: string;
  cardName?: string;
}

export interface CardComment {
  commentId: string;
  text: string;
  createdAt: string;
  author?: string;
}

export interface CardRelation {
  type: 'depends' | 'blocks' | 'duplicates' | 'relates';
  cardId: string;
}

export interface Card {
  cardId: string;
  name: string;
  description?: string;
  status?: string;
  assignees?: string[];
  tags?: string[];
  dueDate?: string;
  createdAt: string;
  updatedAt?: string;
  boardId?: string;
  collectionId?: string;
  // Populated via --include flags
  board?: { boardId: string; name: string; [key: string]: unknown };
  collection?: { collectionId: string; name: string; [key: string]: unknown };
  customFields?: CustomField[];
  links?: CardLink[];
  comments?: CardComment[];
  relations?: CardRelation[];
}

export interface CreateCardRequest {
  name: string;
  description?: string;
  status?: string;
  boardId?: string;
  assignees?: string[];
}

export interface UpdateCardRequest {
  name?: string;
  description?: string;
  status?: string;
  assignees?: string[];
  tags?: string[];
}

/**
 * Paginated response from Favro API.
 * The API uses cursor-based pagination via requestId + page cursor.
 */
export interface PaginatedResponse<T> {
  entities: T[];
  requestId?: string;
  page?: number;
  pages?: number;
  limit?: number;
}

export interface GetCardOptions {
  /** List of include keys: board, collection, custom-fields, links, comments, relations */
  include?: string[];
}

export interface LinkCardRequest {
  toCardId: string;
  type: 'depends' | 'blocks' | 'duplicates' | 'relates';
}

export interface MoveCardRequest {
  toBoardId: string;
  position?: 'top' | 'bottom';
}

export class CardsAPI {
  constructor(private client: FavroHttpClient) {}

  /**
   * List cards with automatic cursor-based pagination.
   * Fetches all pages until the limit is reached or no more pages exist.
   *
   * @param boardId  Optional board ID to filter cards
   * @param limit    Maximum total cards to return (default 25)
   * @param filter   Optional filter expression passed to API
   */
  async listCards(boardId?: string, limit: number = 25, filter?: string): Promise<Card[]> {
    // Default 25; use explicit NaN/range check (not ||) to avoid limit=0 falsy bug
    const effectiveLimit = (isNaN(limit) || limit < 1) ? 25 : limit;
    const path = boardId ? `/boards/${boardId}/cards` : '/cards';
    const allCards: Card[] = [];
    let page = 0;
    let totalPages = 1;
    let requestId: string | undefined;

    while (allCards.length < effectiveLimit && page < totalPages) {
      const params: Record<string, unknown> = {
        limit: Math.min(effectiveLimit - allCards.length, 100), // request at most 100 per page
      };

      if (filter) {
        params.filter = filter;
      }

      // On subsequent pages, use requestId to continue pagination
      if (requestId) {
        params.requestId = requestId;
        params.page = page;
      }

      const response = await this.client.get<PaginatedResponse<Card>>(path, { params });

      const entities = response.entities ?? [];
      allCards.push(...entities);

      // Update pagination state from response
      if (response.requestId) {
        requestId = response.requestId;
        totalPages = response.pages ?? 1;
        page = (response.page ?? 0) + 1;
      } else {
        // No pagination info — single-page response
        break;
      }

      // Stop if we got fewer entities than requested (last page)
      if (entities.length === 0) break;
    }

    return allCards.slice(0, effectiveLimit);
  }

  /**
   * Get a single card with optional includes (board, collection, custom-fields, links, comments).
   */
  async getCard(cardId: string, options?: GetCardOptions): Promise<Card> {
    const params: Record<string, unknown> = {};
    const includes = options?.include ?? [];
    if (includes.length > 0) {
      params.include = includes.join(',');
    }
    const getConfig = Object.keys(params).length > 0 ? { params } : undefined;
    const card = await this.client.get<Card>(`/cards/${cardId}`, getConfig);

    // Hydrate board/collection if requested and not already present
    if (includes.includes('board') && card.boardId && !card.board) {
      try {
        const { BoardsAPI } = await import('./boards-api');
        const boardsApi = new BoardsAPI(this.client);
        card.board = await boardsApi.getBoard(card.boardId) as unknown as typeof card.board;
      } catch { /* best effort */ }
    }
    if (includes.includes('collection') && card.collectionId && !card.collection) {
      try {
        const { BoardsAPI } = await import('./boards-api');
        const boardsApi = new BoardsAPI(this.client);
        card.collection = await boardsApi.getCollection(card.collectionId) as unknown as typeof card.collection;
      } catch { /* best effort */ }
    }
    if (includes.includes('custom-fields') && !card.customFields) {
      try {
        const cf = await this.client.get<{ entities: CustomField[] }>(`/cards/${cardId}/custom-fields`);
        card.customFields = cf.entities ?? [];
      } catch { /* best effort */ }
    }
    if (includes.includes('links') && !card.links) {
      try {
        const lnk = await this.client.get<{ entities: CardLink[] }>(`/cards/${cardId}/links`);
        card.links = lnk.entities ?? [];
      } catch { /* best effort */ }
    }
    if ((includes.includes('comments') || includes.includes('relations')) && !card.comments) {
      try {
        const cmt = await this.client.get<{ entities: CardComment[] }>(`/cards/${cardId}/comments`);
        card.comments = cmt.entities ?? [];
      } catch { /* best effort */ }
    }
    return card;
  }

  /**
   * Link two cards together.
   */
  async linkCard(cardId: string, req: LinkCardRequest): Promise<CardLink> {
    return this.client.post<CardLink>(`/cards/${cardId}/links`, {
      toCardId: req.toCardId,
      type: req.type,
    });
  }

  /**
   * Remove a link between two cards.
   */
  async unlinkCard(cardId: string, fromCardId: string): Promise<void> {
    await this.client.delete(`/cards/${cardId}/links/${fromCardId}`);
  }

  /**
   * Move a card to a different board.
   */
  async moveCard(cardId: string, req: MoveCardRequest): Promise<Card> {
    return this.client.patch<Card>(`/cards/${cardId}/move`, {
      boardId: req.toBoardId,
      position: req.position,
    });
  }

  async createCard(data: CreateCardRequest): Promise<Card> {
    return this.client.post<Card>('/cards', data);
  }

  async createCards(cards: CreateCardRequest[]): Promise<Card[]> {
    const response = await this.client.post<{ cards: Card[] }>('/cards/bulk', { cards });
    return response.cards || [];
  }

  async updateCard(cardId: string, data: UpdateCardRequest): Promise<Card> {
    return this.client.patch<Card>(`/cards/${cardId}`, data);
  }

  async deleteCard(cardId: string): Promise<void> {
    await this.client.delete(`/cards/${cardId}`);
  }

  async searchCards(query: string, limit: number = 50): Promise<Card[]> {
    const response = await this.client.get<PaginatedResponse<Card>>('/cards/search', {
      params: { q: query, limit }
    });
    return response.entities ?? [];
  }
}

export default CardsAPI;
