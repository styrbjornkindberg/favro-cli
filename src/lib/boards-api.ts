import FavroHttpClient from './http-client';

export type BoardType = 'board' | 'list' | 'kanban' | 'backlog';

// Raw widget object from the Favro API
interface RawWidget {
  widgetCommonId: string;
  organizationId?: string;
  collectionIds?: string[];
  name: string;
  type?: string;
  color?: string;
  archived?: boolean;
  lanes?: Array<{ laneId: string; name: string }>;
  columns?: Array<{ columnId: string; name: string; color?: string }>;
  createdAt?: string;
  updatedAt?: string;
}

/** Normalize a raw Favro widget object into the CLI Board interface */
function normalizeWidget(w: RawWidget): Board {
  return {
    boardId: w.widgetCommonId,
    name: w.name,
    type: w.type as BoardType | undefined,
    collectionId: (w.collectionIds ?? [])[0],
    // columns is count of columns for display; raw response gives column objects
    columns: Array.isArray(w.columns) ? w.columns.length : undefined,
    createdAt: w.createdAt ?? '',
    updatedAt: w.updatedAt ?? '',
  };
}

export interface Board {
  boardId: string;
  name: string;
  description?: string;
  type?: BoardType;
  collectionId?: string;
  cardCount?: number;
  columns?: number;
  createdAt: string;
  updatedAt: string;
}

export interface BoardMember {
  userId: string;
  name: string;
  email?: string;
  role?: string;
}

export interface CustomField {
  fieldId: string;
  name: string;
  type: string;
  options?: string[];
}

export interface BoardColumn {
  columnId: string;
  name: string;
  cardCount?: number;
}

export interface BoardStats {
  totalCards: number;
  doneCards: number;
  openCards: number;
  overdueCards: number;
}

export interface VelocityData {
  period: string;
  completed: number;
  added: number;
  netChange: number;
}

export interface ExtendedBoard extends Board {
  members?: BoardMember[];
  customFields?: CustomField[];
  boardColumns?: BoardColumn[];
  cards?: Array<{ status?: string; dueDate?: string; updatedAt?: string }>;
  stats?: BoardStats;
  velocity?: VelocityData[];
}

export interface Collection {
  collectionId: string;
  name: string;
  description?: string;
  boards?: Board[];
  createdAt: string;
  updatedAt: string;
}

interface PaginatedResponse<T> {
  entities: T[];
  requestId?: string;
  pages?: number;
}

/**
 * Aggregate board stats from board data.
 * If raw card data is provided, compute from cards; otherwise use board metadata.
 */
export function aggregateBoardStats(board: ExtendedBoard, cards?: Array<{ status?: string; dueDate?: string }>): BoardStats {
  if (cards && cards.length > 0) {
    const now = new Date();
    const doneCards = cards.filter(c =>
      c.status?.toLowerCase() === 'done' || c.status?.toLowerCase() === 'completed'
    ).length;
    const overdueCards = cards.filter(c => {
      if (!c.dueDate) return false;
      return new Date(c.dueDate) < now && c.status?.toLowerCase() !== 'done';
    }).length;
    return {
      totalCards: cards.length,
      doneCards,
      openCards: cards.length - doneCards,
      overdueCards,
    };
  }

  const total = board.cardCount ?? 0;
  return {
    totalCards: total,
    doneCards: 0,
    openCards: total,
    overdueCards: 0,
  };
}

/**
 * Calculate velocity from card completion data.
 * Returns weekly velocity data for the last 4 weeks.
 */
export function calculateVelocity(cards?: Array<{ status?: string; updatedAt?: string }>): VelocityData[] {
  const velocity: VelocityData[] = [];
  const now = new Date();

  for (let week = 3; week >= 0; week--) {
    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() - week * 7);
    const weekStart = new Date(weekEnd);
    weekStart.setDate(weekStart.getDate() - 7);

    const period = `${weekStart.toISOString().slice(0, 10)} to ${weekEnd.toISOString().slice(0, 10)}`;

    if (!cards || cards.length === 0) {
      velocity.push({ period, completed: 0, added: 0, netChange: 0 });
      continue;
    }

    const completed = cards.filter(c => {
      if (!c.updatedAt) return false;
      const updated = new Date(c.updatedAt);
      return (
        updated >= weekStart &&
        updated < weekEnd &&
        (c.status?.toLowerCase() === 'done' || c.status?.toLowerCase() === 'completed')
      );
    }).length;

    velocity.push({ period, completed, added: 0, netChange: completed });
  }

  return velocity;
}

export class BoardsAPI {
  constructor(private client: FavroHttpClient) {}

  async listBoards(pageSize: number = 50): Promise<Board[]> {
    const allBoards: Board[] = [];
    let requestId: string | undefined;
    let page = 1;

    while (true) {
      const params: Record<string, any> = { limit: pageSize };
      if (requestId) {
        params.requestId = requestId;
        params.page = page;
      }

      const response = await this.client.get<PaginatedResponse<RawWidget>>('/widgets', { params });
      const boards = (response.entities || []).map(normalizeWidget);
      allBoards.push(...boards);

      requestId = response.requestId;
      if (!requestId || !response.pages || page >= response.pages || boards.length === 0) break;
      page++;
    }

    return allBoards;
  }

  async getBoard(boardId: string): Promise<Board> {
    const raw = await this.client.get<RawWidget>(`/widgets/${boardId}`);
    return normalizeWidget(raw);
  }

  /**
   * Get a board with optional extended data.
   * --include: custom-fields, cards, members, stats, velocity
   */
  async getBoardWithIncludes(boardId: string, include?: string[]): Promise<ExtendedBoard> {
    const params: Record<string, any> = {};
    if (include && include.length > 0) {
      params.include = include.join(',');
    }
    const raw = await this.client.get<any>(`/widgets/${boardId}`, { params });
    const board: ExtendedBoard = { ...raw, ...normalizeWidget(raw) };

    // Stats and velocity are computed client-side if requested
    if (include?.includes('stats') || include?.includes('velocity')) {
      let cards: Array<{ status?: string; dueDate?: string; updatedAt?: string }> | undefined;
      if (Array.isArray((board as any).cards)) {
        cards = (board as any).cards;
      }
      if (include?.includes('stats')) {
        board.stats = aggregateBoardStats(board, cards);
      }
      if (include?.includes('velocity')) {
        board.velocity = calculateVelocity(cards);
      }
    }

    return board;
  }

  /**
   * List boards in a specific collection with optional includes.
   */
  async listBoardsByCollection(collectionId: string, include?: string[]): Promise<ExtendedBoard[]> {
    const params: Record<string, any> = { collectionId };
    if (include && include.length > 0) {
      params.include = include.join(',');
    }

    const allBoards: ExtendedBoard[] = [];
    let requestId: string | undefined;
    let page = 1;

    while (true) {
      const p: Record<string, any> = { ...params, limit: 50 };
      if (requestId) {
        p.requestId = requestId;
        p.page = page;
      }

      const response = await this.client.get<PaginatedResponse<RawWidget>>('/widgets', { params: p });
      const boards = (response.entities || []).map(w => ({ ...w, ...normalizeWidget(w) })) as ExtendedBoard[];

      // Augment each board with stats/velocity if requested
      for (const board of boards) {
        if (include?.includes('stats')) {
          board.stats = aggregateBoardStats(board);
        }
        if (include?.includes('velocity')) {
          board.velocity = calculateVelocity();
        }
        allBoards.push(board);
      }

      requestId = response.requestId;
      if (!requestId || !response.pages || page >= response.pages || boards.length === 0) break;
      page++;
    }

    return allBoards;
  }

  /**
   * Create a board in a collection with optional type.
   */
  async createBoardInCollection(
    collectionId: string,
    data: { name: string; type?: BoardType; description?: string }
  ): Promise<Board> {
    const raw = await this.client.post<RawWidget>('/widgets', { ...data, collectionId });
    return normalizeWidget(raw);
  }

  async createBoard(data: { name: string; description?: string; collectionId?: string }): Promise<Board> {
    const raw = await this.client.post<RawWidget>('/widgets', data);
    return normalizeWidget(raw);
  }

  async updateBoard(boardId: string, data: { name?: string; description?: string }): Promise<Board> {
    // Favro uses PUT for widget updates (not PATCH)
    const raw = await this.client.put<RawWidget>(`/widgets/${boardId}`, data);
    return normalizeWidget(raw);
  }

  async deleteBoard(boardId: string): Promise<void> {
    await this.client.delete(`/widgets/${boardId}`);
  }

  async listCollections(pageSize: number = 50): Promise<Collection[]> {
    const allCollections: Collection[] = [];
    let requestId: string | undefined;
    let page = 1;

    while (true) {
      const params: Record<string, any> = { limit: pageSize };
      if (requestId) {
        params.requestId = requestId;
        params.page = page;
      }

      const response = await this.client.get<PaginatedResponse<Collection>>('/collections', { params });
      const collections = response.entities || [];
      allCollections.push(...collections);

      requestId = response.requestId;
      if (!requestId || !response.pages || page >= response.pages || collections.length === 0) break;
      page++;
    }

    return allCollections;
  }

  async getCollection(collectionId: string): Promise<Collection> {
    return this.client.get<Collection>(`/collections/${collectionId}`);
  }

  async createCollection(data: { name: string; description?: string }): Promise<Collection> {
    return this.client.post<Collection>('/collections', data);
  }

  async updateCollection(collectionId: string, data: { name?: string; description?: string }): Promise<Collection> {
    return this.client.patch<Collection>(`/collections/${collectionId}`, data);
  }

  async deleteCollection(collectionId: string): Promise<void> {
    await this.client.delete(`/collections/${collectionId}`);
  }

  async addBoardToCollection(collectionId: string, boardId: string): Promise<Collection> {
    return this.client.post<Collection>(`/collections/${collectionId}/boards/${boardId}`, {});
  }

  async removeBoardFromCollection(collectionId: string, boardId: string): Promise<void> {
    await this.client.delete(`/collections/${collectionId}/boards/${boardId}`);
  }
}

export default BoardsAPI;
