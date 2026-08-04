import FavroHttpClient from './http-client';
import { getAllPages } from './paginate';
import { classifyThrownError } from './favro-error';
import { looksLikeName, resolveNameToId } from './name-resolve';
import { detectStage, isDoneStage } from './workflow-stage';

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

/**
 * The narrower of the TWO `Collection` interfaces, and the one on its way out.
 *
 * `collections-api.ts` declares the same name with `boardCount`/`memberCount`
 * on top. Not deliberate, and NOT fixed here: the interface is a symptom of the
 * whole duplicated collections surface below (`resolveCollectionId`,
 * `listCollections`, `getCollection`, … all exist twice), and #123 owns
 * collapsing it — *"one `resolveCollectionId` and one `Collection` interface;
 * the card path resolves names"*. Deleting the type without the methods that
 * return it would be a rename that collides with that work.
 *
 * Harmless meanwhile: this shape is a strict subset, so a value from the wider
 * one satisfies it and no read can be short a field it was promised. The real
 * defect in the pair is behavioural, not structural — one `resolveCollectionId`
 * accepts names and the other does not — and that is #123's to settle.
 */
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
 *
 * Where a card carries a column name under `status`, "is this card finished" is
 * the question `isDoneStage(detectStage(name))` exists to answer, and this
 * counter no longer answers it itself (#157). It used to test
 * `status === 'done' || status === 'completed'` **exactly**, which #98's census
 * of eight judges missed and ADR-0005 recorded as deliberately left behind.
 * Given a column name, the reroute:
 *
 *   - **widens `doneCards` and narrows `openCards` by the same amount.** A
 *     closing column named `Klar`, `Färdig`, `Avslutad`, `Approved`, `Archived`,
 *     `Closed`, `Released`, `Shipped`, `Deployed` or `Done ✅` counted as OPEN
 *     before, because none of those strings is literally `done` or `completed` —
 *     so `standup` and `boards get --include stats` answered differently about
 *     the same column. Measured over 49 names: 25 move open → done, none moves
 *     done → open.
 *   - **narrows `overdueCards`.** Widening "done" narrows overdue, because the
 *     expression below excludes finished work from it. The old expression tested
 *     `!== 'done'` and so did not even exclude `completed` — a past-due card in a
 *     column named `Completed` counted as both done AND overdue. Now it counts as
 *     neither.
 *
 * **`status` IS NOT A WIRE FIELD, and on the only live caller it is absent.**
 * Favro sends no `status` on a card — `cards-api.ts` says so at `normalizeCard`,
 * CONTEXT.md says so under "column-as-status", and the open/closed axis on the
 * wire is `columnId` and nothing else. The field is filled in by
 * `CardsAPI.hydrateNames`, which resolves `columnId` → column name. That is why
 * `isCompleted` (`api/standup.ts`) gets a real name: its input came through
 * `CardsAPI`. `getBoardWithIncludes` does NOT — it hands over
 * `board.cards` straight off the raw `/widgets/{id}` payload, unnormalised and
 * unhydrated. So on that path `c.status` is `undefined`, `detectStage` falls
 * through to `queued`, and every count below reads exactly as it did before the
 * reroute. The widening above is **correct and latent, not printed**: it becomes
 * visible only once something hands this function hydrated cards. Whether
 * `/widgets?include=cards` returns a `cards` array at all is **unmeasured** —
 * per ADR-0003 this records the open edge rather than asserting either answer.
 * The one fixture that says it does is a hand-written test stand.
 */
export function aggregateBoardStats(board: ExtendedBoard, cards?: Array<{ status?: string; dueDate?: string }>): BoardStats {
  if (cards && cards.length > 0) {
    const now = new Date();
    const doneCards = cards.filter(c => isDoneStage(detectStage(c.status))).length;
    const overdueCards = cards.filter(c => {
      if (!c.dueDate) return false;
      return new Date(c.dueDate) < now && !isDoneStage(detectStage(c.status));
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
 *
 * `completed` routes through the one done judge for the same reason
 * `aggregateBoardStats` does (#157) — it carried a byte-identical exact-match
 * copy of the same test. Nothing caches or persists a velocity series: all four
 * weeks are recomputed from `updatedAt` on every invocation, so the reroute
 * changes the whole series at once rather than grafting a wider week onto
 * narrower history. There is no stored series for it to disagree with.
 *
 * Same caveat as `aggregateBoardStats`: `status` is not a wire field, and the
 * only caller that passes cards passes unhydrated ones, so the widening is
 * latent until something hands this function cards with column names on them.
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
      return updated >= weekStart && updated < weekEnd && isDoneStage(detectStage(c.status));
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

    // Stats and velocity are computed client-side if requested.
    //
    // `board.cards` is read off the RAW `/widgets/{id}` payload, so its members
    // never went through `normalizeCard` or `CardsAPI.hydrateNames` and carry no
    // `status` — Favro sends none, the column IS the status, and only hydration
    // fills the name in. Both counters below therefore judge `undefined` on this
    // path, whatever a column is actually called. That `/widgets?include=cards`
    // returns this array at all is unmeasured (ADR-0003); the declared shape on
    // `ExtendedBoard.cards` is a hint, not a measurement. Cast removed: the field
    // is declared, so `as any` was asserting a shape the type already claims.
    if (include?.includes('stats') || include?.includes('velocity')) {
      const cards = Array.isArray(board.cards) ? board.cards : undefined;
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
