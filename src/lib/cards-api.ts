import FavroHttpClient from './http-client';

/** Raw card shape returned directly by the Favro REST API */
interface RawCard {
  cardId: string;
  cardCommonId?: string;
  name: string;
  detailedDescription?: string;
  widgetCommonId?: string;
  columnId?: string;
  laneId?: string | null;
  archived?: boolean;
  assignments?: Array<{ userId: string; completed?: boolean }>;
  tags?: string[];
  startDate?: string;
  dueDate?: string;
  sequentialId?: number;
  createdByUserId?: string;
  createdAt?: string;
  updatedAt?: string;
  customFields?: unknown[];
  dependencies?: unknown[];
  status?: string;
  // Allow passthrough of extra fields
  parentCardId?: string;
  [key: string]: unknown;
}

/**
 * Normalize a raw Favro API card response to our internal Card interface.
 * Maps Favro's field names (widgetCommonId, assignments, detailedDescription)
 * to the CLI's expected format (boardId, assignees, description).
 */
function normalizeCard(raw: RawCard): Card {
  return {
    cardId: raw.cardId,
    cardCommonId: raw.cardCommonId,
    name: raw.name,
    description: raw.detailedDescription ?? raw.description as string | undefined,
    status: raw.status,
    // Map assignments[].userId → assignees[]
    assignees: (raw.assignments ?? []).map((a) => a.userId),
    tags: raw.tags ?? [],
    dueDate: raw.dueDate,
    createdAt: raw.createdAt ?? '',
    updatedAt: raw.updatedAt,
    // Map widgetCommonId → boardId for internal consistency
    boardId: raw.widgetCommonId ?? raw.boardId as string | undefined,
    columnId: raw.columnId,
    archived: raw.archived,
    sequentialId: raw.sequentialId,
    parentCardId: raw.parentCardId,
    customFields: raw.customFields as Card['customFields'],
  };
}

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
  /** cardCommonId — stable ID across widgets; used for comments API */
  cardCommonId?: string;
  name: string;
  description?: string;
  status?: string;
  assignees?: string[];
  tags?: string[];
  dueDate?: string;
  createdAt: string;
  updatedAt?: string;
  /** boardId — our alias for widgetCommonId */
  boardId?: string;
  columnId?: string;
  collectionId?: string;
  archived?: boolean;
  sequentialId?: number;
  /** Parent card ID for hierarchical card relationships */
  parentCardId?: string;
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
  /** Parent card ID — makes this card a child of the specified card */
  parentCardId?: string;
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
  /** Target column ID when moving a card between columns on a board. */
  columnId?: string;
  /** Parent card ID — sets or changes the parent card */
  parentCardId?: string;
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

export interface ListCardsOptions {
  boardId?: string;
  collectionId?: string;
  limit?: number;
  filter?: string;
  unique?: boolean;
}

export class CardsAPI {
  constructor(private client: FavroHttpClient) {}

  /**
   * List cards with automatic cursor-based pagination.
   * Fetches all pages until the limit is reached or no more pages exist.
   *
   * Accepts either an options object or legacy positional args:
   *   listCards({ boardId, collectionId, limit, filter, unique })
   *   listCards(boardId?, limit?, filter?)  // backward compat
   */
  async listCards(optsOrBoardId?: string | ListCardsOptions, limit?: number, filter?: string): Promise<Card[]> {
    // Normalize args: support both options object and legacy positional params
    let opts: ListCardsOptions;
    if (typeof optsOrBoardId === 'object' && optsOrBoardId !== null) {
      opts = optsOrBoardId;
    } else {
      opts = { boardId: optsOrBoardId ?? undefined, limit, filter };
    }

    const effectiveLimit = (isNaN(opts.limit!) || !opts.limit || opts.limit < 1) ? 25 : opts.limit;
    const path = '/cards';
    const allCards: Card[] = [];
    let page = 0;
    let totalPages = 1;
    let requestId: string | undefined;

    while (allCards.length < effectiveLimit && page < totalPages) {
      const params: Record<string, unknown> = {
        limit: Math.min(effectiveLimit - allCards.length, 100),
        descriptionFormat: 'markdown',
      };

      // Favro uses widgetCommonId to scope cards to a board
      if (opts.boardId) {
        params.widgetCommonId = opts.boardId;
      }

      // Collection-scoped cross-board queries
      if (opts.collectionId) {
        params.collectionId = opts.collectionId;
      }

      // Deduplicate cards that appear on multiple boards in the same collection
      if (opts.unique) {
        params.unique = true;
      }

      if (opts.filter) {
        params.filter = opts.filter;
      }

      // On subsequent pages, use requestId to continue pagination
      if (requestId) {
        params.requestId = requestId;
        params.page = page;
      }

      const response = await this.client.get<PaginatedResponse<Card>>(path, { params });

      const entities = (response.entities as unknown as RawCard[] ?? []).map(normalizeCard);
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
   * Get the raw detailedDescription for a card in markdown format,
   * preserving formatting for safe round-trips.
   */
  async getRawDescription(cardId: string): Promise<string> {
    const rawCard = await this.client.get<RawCard>(`/cards/${cardId}`, {
      params: { descriptionFormat: 'markdown' },
    });
    return rawCard.detailedDescription ?? '';
  }

  /**
   * Get a single card with optional includes (board, collection, custom-fields, links, comments).
   */
  async getCard(cardId: string, options?: GetCardOptions): Promise<Card> {
    const params: Record<string, unknown> = { descriptionFormat: 'markdown' };
    const includes = options?.include ?? [];
    if (includes.length > 0) {
      params.include = includes.join(',');
    }
    const getConfig = { params };
    const rawCard = await this.client.get<RawCard>(`/cards/${cardId}`, getConfig);
    const card = normalizeCard(rawCard);

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
   * Remove all dependencies from a card.
   */
  async deleteAllDependencies(cardId: string): Promise<void> {
    await this.client.delete(`/cards/${cardId}/dependencies`);
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
    if (payload.description !== undefined) {
      payload.detailedDescription = payload.description;
      delete payload.description;
    }
    return this.client.post<Card>('/cards', payload);
  }

  async createCards(cards: CreateCardRequest[]): Promise<Card[]> {
    const response = await this.client.post<{ cards: Card[] }>('/cards/bulk', { cards });
    return response.cards || [];
  }

  async updateCard(cardId: string, data: UpdateCardRequest): Promise<Card> {
    const payload: Record<string, unknown> = { ...data };
    if (payload.description !== undefined) {
      payload.detailedDescription = payload.description;
      delete payload.description;
    }
    if (payload.boardId !== undefined) {
      payload.widgetCommonId = payload.boardId;
      delete payload.boardId;
    }
    // Favro API uses addAssignmentIds/removeAssignmentIds, not assignees
    if (payload.assignees !== undefined) {
      payload.addAssignmentIds = payload.assignees;
      delete payload.assignees;
    }
    // Favro uses PUT for card updates, not PATCH
    return this.client.put<Card>(`/cards/${cardId}`, payload);
  }

  async deleteCard(cardId: string): Promise<void> {
    await this.client.delete(`/cards/${cardId}`);
  }

  async searchCards(query: string, limit: number = 50): Promise<Card[]> {
    const response = await this.client.get<PaginatedResponse<Card>>('/cards/search', {
      params: { q: query, limit, descriptionFormat: 'markdown' }
    });
    return response.entities ?? [];
  }
}

export default CardsAPI;
