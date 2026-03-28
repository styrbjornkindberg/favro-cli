import FavroHttpClient from './http-client';

export interface CustomField {
  fieldId: string;
  name: string;
  value: unknown;
  type?: string;
}

export interface CardLink {
  linkId: string;
  type: 'depends-on' | 'blocks' | 'related' | 'duplicates';
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
  type: 'depends-on' | 'blocks' | 'related' | 'duplicates';
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
  /** widgetCommonId — the board (widget) to create the card on */
  widgetCommonId?: string;
  /** @deprecated Use widgetCommonId instead */
  boardId?: string;
  columnId?: string;
  assignees?: string[];
}

export interface UpdateCardRequest {
  name?: string;
  description?: string;
  status?: string;
  assignees?: string[];
  tags?: string[];
  /** Due date in YYYY-MM-DD format. Supported by Favro API updateCard endpoint. */
  dueDate?: string;
  /** Target board ID when moving a card between boards. Supported by Favro API updateCard endpoint. */
  boardId?: string;
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
  type: 'depends-on' | 'blocks' | 'related' | 'duplicates';
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
    // Favro API: GET /cards with widgetCommonId query param (not /boards/:id/cards)
    const path = '/cards';
    const allCards: Card[] = [];
    let page = 0;
    let totalPages = 1;
    let requestId: string | undefined;

    while (allCards.length < effectiveLimit && page < totalPages) {
      const params: Record<string, unknown> = {
        limit: Math.min(effectiveLimit - allCards.length, 100), // request at most 100 per page
      };

      // Favro uses widgetCommonId to scope cards to a board
      if (boardId) {
        params.widgetCommonId = boardId;
      }

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
    // Custom fields are returned inline on card responses from Favro API,
    // not via a separate endpoint.
    if (includes.includes('links') && !card.links) {
      try {
        // Favro: GET /cards/:cardId/dependencies
        const lnk = await this.client.get<{ entities: CardLink[] }>(`/cards/${cardId}/dependencies`);
        card.links = lnk.entities ?? [];
      } catch { /* best effort */ }
    }
    if ((includes.includes('comments') || includes.includes('relations')) && !card.comments) {
      try {
        // Favro: GET /comments?cardCommonId=<cardId>
        const cmt = await this.client.get<{ entities: CardComment[] }>('/comments', {
          params: { cardCommonId: cardId }
        });
        card.comments = cmt.entities ?? [];
      } catch { /* best effort */ }
    }
    return card;
  }

  /**
   * Get all links for a card.
   */
  async getCardLinks(cardId: string): Promise<CardLink[]> {
    // Favro: GET /cards/:cardId/dependencies
    const res = await this.client.get<{ entities: CardLink[] }>(`/cards/${cardId}/dependencies`);
    return res.entities ?? [];
  }

  /**
   * Link two cards together.
   */
  async linkCard(cardId: string, req: LinkCardRequest): Promise<CardLink> {
    // Favro: POST /cards/:cardId/dependencies
    return this.client.post<CardLink>(`/cards/${cardId}/dependencies`, {
      toCardId: req.toCardId,
      type: req.type,
    });
  }

  /**
   * Remove a link between two cards.
   */
  async unlinkCard(cardId: string, fromCardId: string): Promise<void> {
    await this.client.delete(`/cards/${cardId}/dependencies/${fromCardId}`);
  }

  /**
   * Move a card to a different board.
   */
  async moveCard(cardId: string, req: MoveCardRequest): Promise<Card> {
    // Favro uses PUT /cards/:cardId with widgetCommonId to move cards
    return this.client.put<Card>(`/cards/${cardId}`, {
      widgetCommonId: req.toBoardId,
      position: req.position,
    });
  }

  async createCard(data: CreateCardRequest): Promise<Card> {
    // Map boardId → widgetCommonId for callers using the old field name
    const payload: Record<string, unknown> = { ...data };
    if (payload.boardId && !payload.widgetCommonId) {
      payload.widgetCommonId = payload.boardId;
      delete payload.boardId;
    }
    return this.client.post<Card>('/cards', payload);
  }

  async createCards(cards: CreateCardRequest[]): Promise<Card[]> {
    const response = await this.client.post<{ cards: Card[] }>('/cards/bulk', { cards });
    return response.cards || [];
  }

  async updateCard(cardId: string, data: UpdateCardRequest): Promise<Card> {
    // Favro uses PUT for card updates, not PATCH
    return this.client.put<Card>(`/cards/${cardId}`, data);
  }

  async deleteCard(cardId: string): Promise<void> {
    await this.client.delete(`/cards/${cardId}`);
  }

  async searchCards(query: string, limit: number = 50): Promise<Card[]> {
    // Favro has no /cards/search endpoint; use /cards with unique param for lookup
    // or use todoList param for filtering. For general search, list all and filter client-side.
    const response = await this.client.get<PaginatedResponse<Card>>('/cards', {
      params: { unique: true, limit }
    });
    const all = response.entities ?? [];
    const lc = query.toLowerCase();
    return all.filter(c => (c.name ?? '').toLowerCase().includes(lc)).slice(0, limit);
  }
}

export default CardsAPI;
