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
  WorkflowStage,
  BoardContextSnapshot,
} from './context';

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
  generatedAt: string;
}

export interface AggregateScope {
  collectionIds?: string[];
  boardIds?: string[];
}

// ─── Stage detection (re-exported from context.ts logic) ──────────────────────

function detectStage(name: string): WorkflowStage {
  const n = name.toLowerCase();
  if (/done|klar|färdig|complete|closed|released|shipped|deploy|live|finished|avslut/i.test(n)) return 'done';
  if (/archived?|arkiver/i.test(n)) return 'archived';
  if (/approv|godkän|accept|verified|sign.?off/i.test(n)) return 'approved';
  if (/progress|develop|pågå|aktiv|doing|working|implement|bygg|coding|current/i.test(n)) return 'active';
  if (/test|qa|kvalit|verif/i.test(n)) return 'testing';
  if (/review|gransk|feedback|pending/i.test(n)) return 'review';
  if (/select|vald|ready|next|sprint|priorit|planned|schedul|redo/i.test(n)) return 'queued';
  if (/backlog|inbox|new|ny|todo|to.do|icke|idea|wish|önskelista|triage|incoming/i.test(n)) return 'backlog';
  return 'queued';
}

function buildWorkflow(columns: Array<{ id: string; name: string }>): WorkflowStep[] {
  return columns.map((col, i) => ({
    columnId: col.id,
    columnName: col.name,
    position: i + 1,
    stage: detectStage(col.name),
    nextColumn: i < columns.length - 1 ? columns[i + 1].name : undefined,
  }));
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
    title: card.name,
    status: card.status,
    assignees: card.assignees,
    owner: card.assignees?.[0],
    tags: card.tags,
    due: card.dueDate,
    columnId: card.columnId,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    boardId,
    boardName,
    collectionId,
    collectionName,
    blockedBy: [],
    blocking: [],
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
          limit: cardLimit,
          unique: true,
        });
      } else {
        // Fetch per-board when we only have boardIds
        const perBoard = await Promise.all(
          boards.map(b => this.cardsApi.listCards({ boardId: b.boardId, limit: cardLimit })),
        );
        cards = perBoard.flat();
      }

      // Fetch columns for each board (needed for workflow enrichment)
      const boardColumnsMap = new Map<string, Column[]>();
      await mapConcurrent(boards, 3, async (board) => {
        const cols = await this.columnsApi.listColumns(board.boardId).catch(() => []);
        boardColumnsMap.set(board.boardId, cols);
      });

      // Fetch members for the collection
      const members = await this.membersApi.getMembers(
        collId !== '__boards__' ? { collectionId: collId } : undefined,
      ).catch(() => []);
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
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Convenience: get snapshot for a single collection by name or ID.
   */
  async getCollectionSnapshot(collectionRef: string, cardLimit?: number): Promise<AggregateSnapshot> {
    // Try direct ID first
    try {
      const coll = await this.collectionsApi.getCollection(collectionRef);
      if (coll) return this.getMultiBoardSnapshot({ collectionIds: [coll.collectionId] }, cardLimit);
    } catch { /* fall through */ }

    // Name search
    const all = await this.collectionsApi.listCollections();
    const lower = collectionRef.toLowerCase();
    const match = all.find(c => c.name.toLowerCase() === lower)
      ?? all.find(c => c.name.toLowerCase().includes(lower));
    if (!match) throw new Error(`Collection not found: "${collectionRef}"`);
    return this.getMultiBoardSnapshot({ collectionIds: [match.collectionId] }, cardLimit);
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
