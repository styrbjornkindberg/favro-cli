/**
 * Multi-scope Aggregation Layer
 * v2.0: Cross-board data fetching for persona commands.
 *
 * Uses Favro API's collectionId-based card queries to avoid iterating boards.
 * Concurrent collection fetches capped at 3 to respect rate limits.
 */
import FavroHttpClient from '../lib/http-client';
import CardsAPI, { Card } from '../lib/cards-api';
import BoardsAPI, { Board } from '../lib/boards-api';
import { CollectionsAPI, Collection } from '../lib/collections-api';
import { ColumnsAPI, Column } from '../lib/columns-api';
import { FavroApiClient } from './members';
import { Member } from '../types/members';
import {
  ContextCard,
  WorkflowStep,
  BoardContextSnapshot,
  buildWorkflow,
} from './context';
import { WorkflowStage } from '../lib/workflow-stage';
import { blockingEdges } from '../lib/blocking';
import { COLUMNS_HOLE, holeCollector, Unreachable } from '../lib/read-shape';

// Re-export for convenience
export { ContextCard, WorkflowStage, WorkflowStep };

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AggregateBoard {
  id: string;
  name: string;
  collectionId?: string;
  collectionName?: string;
  columns: Array<{ id: string; name: string }>;
  workflow: WorkflowStep[];
  cards: AggregateCard[];
}

export interface AggregateCard extends ContextCard {
  /**
   * `cardCommonId`. `id` is the `cardId`, and the two are different keyspaces —
   * an inlined `dependencies` edge names only the `cardCommonId`, so this is the
   * field a blocker lookup has to match on (#47).
   */
  commonId?: string;
  boardId?: string;
  boardName?: string;
  collectionId?: string;
  collectionName?: string;
}

export interface AggregateCollection {
  id: string;
  name: string;
  boards: AggregateBoard[];
}

export interface AggregateStats {
  total: number;
  by_collection: Record<string, number>;
  by_board: Record<string, number>;
  by_status: Record<string, number>;
  by_owner: Record<string, number>;
}

export interface AggregateSnapshot {
  collections: AggregateCollection[];
  allCards: AggregateCard[];
  members: Array<{ id: string; name: string; email: string; role?: string }>;
  stats: AggregateStats;
  /**
   * Parts of this snapshot that could not be read (#148). Present only when
   * there are any, so an absent marker means the whole fan-out landed — the
   * same rule `ContextSnapshot.unreachable` follows (`read-shape.ts` rule 3).
   *
   * `id` is `columns:<boardId>` or `members:<collectionId>` — the facet plus
   * the thing it was read for, because unlike `getSnapshot` this fan-out runs
   * the same two calls once per board and once per collection, so a bare facet
   * name would not say WHICH board went dark. Use `excludeUnreadableBoards`
   * from `read-shape.ts` rather than re-parsing the prefix at a call site.
   */
  unreachable?: Unreachable[];
  generatedAt: string;
}

export interface AggregateScope {
  collectionIds?: string[];
  boardIds?: string[];
}

function normalizeToAggregateCard(
  card: Card,
  boardId: string,
  boardName: string,
  collectionId: string | undefined,
  collectionName: string | undefined,
  workflowByColumnId: Map<string, WorkflowStep>,
): AggregateCard {
  const ac: AggregateCard = {
    id: card.cardId,
    commonId: card.cardCommonId,
    title: card.name,
    status: card.status,
    assignees: card.assignees,
    owner: card.assignees?.[0],
    tags: card.tags,
    due: card.dueDate,
    columnId: card.columnId,
    createdAt: card.createdAt,
    boardId,
    boardName,
    collectionId,
    collectionName,
    // Was hardcoded `[]` / `[]` (#47) — a third dead blocking consumer, and the
    // reason every persona command that counts blocked cards counted zero.
    // `GET /cards` inlines the edges, so the real answer was already in hand.
    ...blockingEdges(card),
  };

  if (card.customFields && card.customFields.length > 0) {
    ac.customFields = {};
    for (const cf of card.customFields) {
      ac.customFields[cf.name ?? cf.fieldId] = cf.value;
    }
  }

  if (card.columnId) {
    const step = workflowByColumnId.get(card.columnId);
    if (step) {
      ac.column = step.columnName;
      ac.stage = step.stage;
      ac.nextColumn = step.nextColumn;
    }
  }

  return ac;
}

// ─── Concurrency helper ──────────────────────────────────────────────────────

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ─── Aggregate API ───────────────────────────────────────────────────────────

export class AggregateAPI {
  private cardsApi: CardsAPI;
  private boardsApi: BoardsAPI;
  private collectionsApi: CollectionsAPI;
  private columnsApi: ColumnsAPI;
  private membersApi: FavroApiClient;

  constructor(private client: FavroHttpClient) {
    this.cardsApi = new CardsAPI(client);
    this.boardsApi = new BoardsAPI(client);
    this.collectionsApi = new CollectionsAPI(client);
    this.columnsApi = new ColumnsAPI(client);
    this.membersApi = new FavroApiClient(client);
  }

  /**
   * Fetch a multi-board snapshot across collections.
   * Uses collectionId-based card queries for efficiency.
   * Concurrent collection fetches capped at 3 to respect rate limits.
   */
  async getMultiBoardSnapshot(
    scope: AggregateScope,
    cardLimit: number = 1000,
  ): Promise<AggregateSnapshot> {
    // Resolve collections to process
    let collections: Collection[];
    if (scope.collectionIds && scope.collectionIds.length > 0) {
      collections = await Promise.all(
        scope.collectionIds.map(id => this.collectionsApi.getCollection(id)),
      );
    } else if (scope.boardIds && scope.boardIds.length > 0) {
      // If only boardIds given, we still need to find their collections
      // For now, create synthetic collection entries
      collections = [{ collectionId: '__boards__', name: 'Selected Boards', createdAt: '', updatedAt: '' }];
    } else {
      // Fetch all collections
      collections = await this.collectionsApi.listCollections();
    }

    const allCards: AggregateCard[] = [];
    const allMembers = new Map<string, { id: string; name: string; email: string; role?: string }>();
    const aggCollections: AggregateCollection[] = [];

    // Two sub-fetches below fall back rather than fail the whole sweep — one
    // dark board must not cost the caller the other eleven. Both used to do it
    // behind a bare `.catch(() => [])`, so "we could not look" arrived as "there
    // is nothing there" (#148, the same defect #116 fixed in `ContextAPI`).
    // Recorded now, through the one seam.
    const { unreachable, orElse } = holeCollector();

    // Process collections concurrently (max 3)
    await mapConcurrent(collections, 3, async (collection) => {
      const collId = collection.collectionId;
      const collName = collection.name;

      // Fetch boards in this collection
      let boards: Board[];
      if (collId === '__boards__' && scope.boardIds) {
        boards = await Promise.all(
          scope.boardIds.map(id => this.boardsApi.getBoard(id)),
        );
      } else {
        const extBoards = await this.boardsApi.listBoardsByCollection(collId);
        boards = extBoards as unknown as Board[];
      }

      // Fetch cards for the entire collection in one API call
      let cards: Card[];
      if (collId !== '__boards__') {
        cards = await this.cardsApi.listCards({
          collectionId: collId,
          unique: true,
        });
      } else {
        // Fetch per-board when we only have boardIds
        const perBoard = await Promise.all(
          boards.map(b => this.cardsApi.listCards({ boardId: b.boardId })),
        );
        cards = perBoard.flat();
      }

      // Fetch columns for each board (needed for workflow enrichment)
      const boardColumnsMap = new Map<string, Column[]>();
      await mapConcurrent(boards, 3, async (board) => {
        const cols = await orElse(
          `${COLUMNS_HOLE}${board.boardId}`,
          this.columnsApi.listColumns(board.boardId),
          [] as Column[],
        );
        boardColumnsMap.set(board.boardId, cols);
      });

      // Fetch members for the collection
      const members = await orElse(
        `members:${collId}`,
        this.membersApi.getMembers(collId !== '__boards__' ? { collectionId: collId } : undefined),
        [] as Member[],
      );
      for (const m of members) {
        allMembers.set(m.id, { id: m.id, name: m.name, email: m.email, role: m.role });
      }

      // Build board-level aggregate data
      const aggBoards: AggregateBoard[] = [];
      for (const board of boards) {
        const rawCols = boardColumnsMap.get(board.boardId) ?? [];
        const columns = rawCols.map(c => ({ id: c.columnId, name: c.name }));
        const workflow = buildWorkflow(columns);
        const workflowByColumnId = new Map(workflow.map(w => [w.columnId, w]));

        // Filter cards belonging to this board
        const boardCards = cards.filter(c => c.boardId === board.boardId);
        const aggCards = boardCards.map(c =>
          normalizeToAggregateCard(c, board.boardId, board.name, collId !== '__boards__' ? collId : undefined, collId !== '__boards__' ? collName : undefined, workflowByColumnId),
        );

        allCards.push(...aggCards);
        aggBoards.push({
          id: board.boardId,
          name: board.name,
          collectionId: collId !== '__boards__' ? collId : undefined,
          collectionName: collId !== '__boards__' ? collName : undefined,
          columns,
          workflow,
          cards: aggCards,
        });
      }

      aggCollections.push({
        id: collId,
        name: collName,
        boards: aggBoards,
      });
    });

    return {
      collections: aggCollections,
      allCards,
      members: Array.from(allMembers.values()),
      stats: this.buildStats(allCards),
      // Spread in only when non-empty — absent must stay distinguishable from
      // empty, or the key stops meaning anything (`read-shape.ts` rule 3).
      ...(unreachable.length > 0 ? { unreachable } : {}),
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Snapshot for a single collection, by id or by exact name.
   *
   * What was deleted here (#122, ADR-0003) is the substring fallback —
   * `all.find(c => c.name.toLowerCase().includes(lower))`, first hit wins, no
   * ambiguity refusal — and the bare `catch { }` that reached it on ANY error,
   * so a 500 was answered with somebody else's collection.
   *
   * What was NOT deleted is the direct read. `getCollection` is the same
   * escalate-on-classified-not-found shape the board side keeps
   * (`ContextAPI.resolveBoard` → `BoardsAPI.getBoard`): an id costs one
   * `GET /collections/{id}`, and only a classified not-found falls through to
   * `resolveCollectionId`, which paginates the listing to completion and
   * refuses an unknown or a duplicated name with every colliding id listed.
   * Two reasons to keep it, and the honest weight of each:
   *
   * - **Symmetry.** Boards and collections resolve the same way, or the next
   *   reader has to find out why not. This is the load-bearing one.
   * - **A collection that reads by id but is absent from the listing** —
   *   archived, or scoped oddly — keeps working instead of refusing. Nobody
   *   here has measured whether that case exists.
   *
   * Not a reason: saving the listing. `getMultiBoardSnapshot` →
   * `listBoardsByCollection` resolves the collection again downstream, so on a
   * cold cache the sweep happens either way (warm, the second is free). An
   * earlier draft of this claimed the fast path saved nine commands a sweep;
   * the wire test disproved it.
   *
   * Trade taken knowingly: the refusal then names `favro collections get
   * <collectionId>` rather than each caller's own `--collection` flag. That is
   * a command that exists today, which is the requirement; threading a
   * `useIdWith` through `getCollection` to sharpen the wording is not worth a
   * parameter on the read path.
   */
  async getCollectionSnapshot(collectionRef: string, cardLimit?: number): Promise<AggregateSnapshot> {
    const coll = await this.collectionsApi.getCollection(collectionRef);
    return this.getMultiBoardSnapshot({ collectionIds: [coll.collectionId] }, cardLimit);
  }

  private buildStats(cards: AggregateCard[]): AggregateStats {
    const by_status: Record<string, number> = {};
    const by_owner: Record<string, number> = {};
    const by_board: Record<string, number> = {};
    const by_collection: Record<string, number> = {};

    for (const card of cards) {
      const status = card.stage ?? card.status ?? 'unknown';
      by_status[status] = (by_status[status] ?? 0) + 1;

      const owners = card.assignees?.length ? card.assignees : ['unassigned'];
      for (const owner of owners) {
        by_owner[owner] = (by_owner[owner] ?? 0) + 1;
      }

      if (card.boardName) {
        by_board[card.boardName] = (by_board[card.boardName] ?? 0) + 1;
      }

      if (card.collectionName) {
        by_collection[card.collectionName] = (by_collection[card.collectionName] ?? 0) + 1;
      }
    }

    return { total: cards.length, by_collection, by_board, by_status, by_owner };
  }
}

export default AggregateAPI;
