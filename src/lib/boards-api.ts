import FavroHttpClient from './http-client';
import { getAllPages } from './paginate';
import { classifyThrownError } from './favro-error';
import { looksLikeName, resolveNameToId } from './name-resolve';

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
    const raw = await getAllPages<RawWidget>(this.client, '/widgets', { limit: pageSize });
    return raw.map(normalizeWidget);
  }

  /**
   * Resolve a board name to its `widgetCommonId`. An exact id passes straight
   * through. Refuses an unknown or a duplicated name — never picks one.
   */
  async resolveBoardId(board: string): Promise<string> {
    return resolveNameToId({
      organizationId: this.client.organizationId,
      kind: 'boards',
      fetch: async () => (await this.listBoards(100)).map(b => ({ id: b.boardId, name: b.name })),
      value: board,
      label: 'board',
      listCommand: 'favro boards list',
      useIdWith: 'favro boards get <boardId>',
    });
  }

  /**
   * Resolve a collection name to its `collectionId`.
   * `useIdWith` names the caller's own flag so the refusal points at a command
   * that exists today.
   */
  async resolveCollectionId(collection: string, useIdWith = 'favro collections get <collectionId>'): Promise<string> {
    return resolveNameToId({
      organizationId: this.client.organizationId,
      kind: 'collections',
      fetch: async () => (await this.listCollections(100)).map(c => ({ id: c.collectionId, name: c.name })),
      value: collection,
      label: 'collection',
      listCommand: 'favro collections list',
      useIdWith,
    });
  }

  /**
   * Read one board by id, escalating to a name lookup when the wire classifies
   * the direct read as missing.
   *
   * A one-word board name is not distinguishable from an id by shape, so shape
   * alone cannot decide — only an obvious name (one carrying a space or any
   * other non-id character) skips the round trip. Escalation is read-only, per
   * #36: a mutation never re-fires against a second identifier.
   */
  private async byBoard<T>(board: string, read: (boardId: string) => Promise<T>): Promise<T> {
    if (looksLikeName(board)) return read(await this.resolveBoardId(board));
    try {
      return await read(board);
    } catch (error) {
      if (!classifyThrownError(error)?.escalatableOnRead) throw error;
      return read(await this.resolveBoardId(board));
    }
  }

  /** Get a board by id or by exact name. */
  async getBoard(board: string): Promise<Board> {
    const raw = await this.byBoard(board, id => this.client.get<RawWidget>(`/widgets/${id}`));
    return normalizeWidget(raw);
  }

  /**
   * Get a board (by id or by exact name) with optional extended data.
   * --include: custom-fields, cards, members, stats, velocity
   */
  async getBoardWithIncludes(boardOrName: string, include?: string[]): Promise<ExtendedBoard> {
    const params: Record<string, any> = {};
    if (include && include.length > 0) {
      params.include = include.join(',');
    }
    const raw = await this.byBoard(boardOrName, id => this.client.get<any>(`/widgets/${id}`, { params }));
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
   * List boards in one collection (by id or by exact name), filtered ON THE
   * WIRE — one resolve call plus one `/widgets?collectionId=…`, never the whole
   * org followed by a client-side sweep.
   *
   * The collection is resolved against the real listing rather than passed
   * through: `/widgets` answers 200 with an empty page for a collectionId that
   * does not exist, so an unvalidated argument would read as "no boards" when
   * the truth is "no such collection".
   */
  async listBoardsByCollection(collection: string, include?: string[]): Promise<ExtendedBoard[]> {
    const collectionId = await this.resolveCollectionId(
      collection,
      'favro boards list --collection <collectionId>'
    );
    const params: Record<string, any> = { collectionId };
    if (include && include.length > 0) {
      params.include = include.join(',');
    }

    const raw = await getAllPages<RawWidget>(this.client, '/widgets', { ...params, limit: 50 });
    const allBoards = raw.map(w => ({ ...w, ...normalizeWidget(w) })) as ExtendedBoard[];

    // Augment each board with stats/velocity if requested
    for (const board of allBoards) {
      if (include?.includes('stats')) {
        board.stats = aggregateBoardStats(board);
      }
      if (include?.includes('velocity')) {
        board.velocity = calculateVelocity();
      }
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
    return getAllPages<Collection>(this.client, '/collections', { limit: pageSize });
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
