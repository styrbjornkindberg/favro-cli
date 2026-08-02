/**
 * Board Context Snapshot API
 * CLA-1796 / FAVRO-034: Board Context Snapshot Command
 *
 * Fetches complete board state in a single parallel request for AI workflows.
 * Performance target: < 1s for 500-card boards via Promise.all().
 */
import FavroHttpClient from '../lib/http-client';
import BoardsAPI, { Board, BoardMember, BoardColumn, CustomField as BoardCustomField } from '../lib/boards-api';
import CardsAPI, { Card } from '../lib/cards-api';
import { FavroApiClient } from './members';
import { CustomFieldsAPI, CustomFieldDefinition } from '../lib/custom-fields-api';
import { ColumnsAPI } from '../lib/columns-api';
import { detectStage, WorkflowStage } from '../lib/workflow-stage';
import { blockingEdges } from '../lib/blocking';

export { WorkflowStage };

// ─── Output Types ─────────────────────────────────────────────────────────────

export interface ContextCard {
  id: string;
  title: string;
  status?: string;
  owner?: string;
  assignees?: string[];
  tags?: string[];
  due?: string;
  customFields?: Record<string, unknown>;
  blockedBy?: string[];
  blocking?: string[];
  parentId?: string;
  childIds?: string[];
  swimlaneId?: string;
  columnId?: string;
  column?: string;
  stage?: WorkflowStage;
  nextColumn?: string;
  createdAt?: string;
}

export interface ContextStats {
  total: number;
  by_status: Record<string, number>;
  by_owner: Record<string, number>;
}

export interface BoardContextSnapshot {
  board: {
    id: string;
    name: string;
    description?: string;
    type?: string;
    collection?: string;
    members: string[];
  };
  columns: Array<{ id: string; name: string; cardCount?: number }>;
  workflow: WorkflowStep[];
  customFields: Array<{
    id: string;
    name: string;
    type: string;
    values?: string[];
    required?: boolean;
  }>;
  members: Array<{
    id: string;
    name: string;
    email: string;
    role?: string;
  }>;
  cards: ContextCard[];
  stats: ContextStats;
  generatedAt: string;
}

export interface WorkflowStep {
  columnId: string;
  columnName: string;
  position: number;
  stage: WorkflowStage;
  nextColumn?: string;
}

// ─── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Build workflow steps from ordered columns.
 * Each step gets a position, auto-detected semantic stage, and a pointer to the next column.
 *
 * The one home (#89) — `api/aggregate.ts` held a byte-identical copy.
 */
export function buildWorkflow(columns: Array<{ id: string; name: string }>): WorkflowStep[] {
  return columns.map((col, i) => ({
    columnId: col.id,
    columnName: col.name,
    position: i + 1,
    stage: detectStage(col.name),
    nextColumn: i < columns.length - 1 ? columns[i + 1].name : undefined,
  }));
}

/**
 * A card's effort, in whatever the board happens to call it.
 *
 * The one home (#89) — this existed in four places with three return types
 * (`next`, `team`, `workload`, `api/sprint-plan`). `undefined` is the reconciled
 * answer for "no effort recorded", because 0 is a legitimate estimate and a
 * caller summing efforts wants to say `?? 0` itself rather than have an absent
 * field silently weigh the same as a zero one.
 *
 * The field is matched by NAME, on the card's own field order — Favro has no
 * effort concept, so this is a guess at a custom field and stays one.
 */
const EFFORT_FIELD = /effort|story.?points?|points?|estimate/i;

export function extractEffort(card: ContextCard): number | undefined {
  for (const [key, val] of Object.entries(card.customFields ?? {})) {
    if (!EFFORT_FIELD.test(key)) continue;
    // An empty effort field is not an effort of 0 — keep looking at the rest.
    if (val === undefined || val === null || val === '') continue;
    const n = Number(val);
    if (!isNaN(n)) return n;
  }
  return undefined;
}

/**
 * Normalize a raw card into the ContextCard format.
 * Extracts all relationships and custom field values.
 */
function normalizeCard(card: Card): ContextCard {
  const ctx: ContextCard = {
    id: card.cardId,
    title: card.name,
    status: card.status,
    assignees: card.assignees,
    owner: card.assignees?.[0],
    tags: card.tags,
    due: card.dueDate,
    columnId: card.columnId,
    createdAt: card.createdAt,
  };

  // Custom fields — build a key→value map
  if (card.customFields && card.customFields.length > 0) {
    ctx.customFields = {};
    for (const cf of card.customFields) {
      ctx.customFields[cf.name ?? cf.fieldId] = cf.value;
    }
  }

  // Blocking edges, from the one place that knows Favro's direction flag.
  Object.assign(ctx, blockingEdges(card));

  return ctx;
}

/**
 * Build stats from normalized cards.
 */
function buildStats(cards: ContextCard[]): ContextStats {
  const by_status: Record<string, number> = {};
  const by_owner: Record<string, number> = {};

  for (const card of cards) {
    const status = card.status ?? 'Unknown';
    by_status[status] = (by_status[status] ?? 0) + 1;

    const owners = card.assignees && card.assignees.length > 0
      ? card.assignees
      : ['unassigned'];
    for (const owner of owners) {
      by_owner[owner] = (by_owner[owner] ?? 0) + 1;
    }
  }

  return {
    total: cards.length,
    by_status,
    by_owner,
  };
}

// ─── Context API ──────────────────────────────────────────────────────────────

export class ContextAPI {
  private boardsApi: BoardsAPI;
  private cardsApi: CardsAPI;
  private membersApi: FavroApiClient;
  private customFieldsApi: CustomFieldsAPI;
  private columnsApi: ColumnsAPI;

  constructor(private client: FavroHttpClient) {
    this.boardsApi = new BoardsAPI(client);
    this.cardsApi = new CardsAPI(client);
    this.membersApi = new FavroApiClient(client);
    this.customFieldsApi = new CustomFieldsAPI(client);
    this.columnsApi = new ColumnsAPI(client);
  }

  /**
   * Find a board by name or ID.
   * If boardRef looks like an ID (no spaces, possibly prefixed with 'boards-'),
   * tries direct lookup first; falls back to listing all boards and fuzzy matching.
   */
  async resolveBoard(boardRef: string): Promise<Board> {
    // Try direct ID lookup first (fast path)
    try {
      const board = await this.boardsApi.getBoard(boardRef);
      if (board && board.boardId) return board;
    } catch {
      // Fall through to name search
    }

    // List all boards and find by name (case-insensitive)
    const boards = await this.boardsApi.listBoards(100);
    const lower = boardRef.toLowerCase();

    // Exact name match first
    const exact = boards.find(b => b.name.toLowerCase() === lower);
    if (exact) return exact;

    // Partial name match
    const partial = boards.find(b => b.name.toLowerCase().includes(lower));
    if (partial) return partial;

    throw new Error(`Board not found: "${boardRef}". Use 'favro boards list' to find board IDs.`);
  }

  /**
   * Get complete board context snapshot.
   * Fetches board metadata, columns, custom fields, members, and cards in parallel.
   *
   * @param boardRef  Board ID or board name
   * @param cardLimit  Maximum cards to fetch (default 1000)
   */
  async getSnapshot(boardRef: string, cardLimit: number = 1000): Promise<BoardContextSnapshot> {
    // Step 1: Resolve board (required before parallel fetch)
    const board = await this.resolveBoard(boardRef);
    const boardId = board.boardId;

    // Step 2: Fetch all board data in parallel
    const [extendedBoard, cards, members, customFieldDefs, rawColumns] = await Promise.all([
      this.boardsApi.getBoardWithIncludes(boardId, ['custom-fields', 'members']).catch(() => board as any),
      this.cardsApi.listCards(boardId).catch(() => [] as Card[]),
      this.membersApi.getMembers({ boardId }).catch(() => []),
      this.customFieldsApi.listFields(boardId).catch(() => [] as CustomFieldDefinition[]),
      this.columnsApi.listColumns(boardId).catch(() => []),
    ]);

    // Extract columns — prefer dedicated columns API, fall back to extended board
    let columns = rawColumns.map(col => ({
      id: col.columnId,
      name: col.name,
      cardCount: undefined as number | undefined,
    }));
    if (columns.length === 0) {
      columns = (extendedBoard.boardColumns ?? []).map((col: BoardColumn) => ({
        id: col.columnId,
        name: col.name,
        cardCount: col.cardCount,
      }));
    }

    // Normalize custom field definitions
    const customFields = customFieldDefs.map((f: CustomFieldDefinition) => ({
      id: f.fieldId,
      name: f.name,
      type: f.type,
      values: f.options?.map(o => o.name),
      required: f.required,
    }));

    // Fallback: use custom fields from extended board if custom fields API returned nothing
    if (customFields.length === 0 && extendedBoard.customFields) {
      const fallback = (extendedBoard.customFields ?? []) as BoardCustomField[];
      for (const f of fallback) {
        customFields.push({
          id: f.fieldId,
          name: f.name,
          type: f.type,
          values: f.options,
          required: undefined,
        });
      }
    }

    // Normalize members
    const normalizedMembers = members.map(m => ({
      id: m.id,
      name: m.name,
      email: m.email,
      role: m.role ?? 'member',
    }));

    // Fallback: use members from extended board
    const memberEmails = normalizedMembers.map(m => m.email);
    if (normalizedMembers.length === 0 && extendedBoard.members) {
      const fallbackMembers = (extendedBoard.members ?? []) as BoardMember[];
      for (const m of fallbackMembers) {
        normalizedMembers.push({
          id: m.userId,
          name: m.name,
          email: m.email ?? '',
          role: m.role ?? 'member',
        });
      }
    }

    // Normalize cards
    const normalizedCards = cards.map(normalizeCard);

    // Enrich cards with workflow context
    const workflow = buildWorkflow(columns);
    const workflowByColumnId = new Map(workflow.map(w => [w.columnId, w]));
    for (const card of normalizedCards) {
      if (card.columnId) {
        const step = workflowByColumnId.get(card.columnId);
        if (step) {
          card.column = step.columnName;
          card.stage = step.stage;
          card.nextColumn = step.nextColumn;
        }
      }
    }

    // Build stats
    const stats = buildStats(normalizedCards);

    return {
      board: {
        id: boardId,
        name: board.name,
        description: board.description,
        type: board.type,
        collection: board.collectionId,
        members: memberEmails.length > 0 ? memberEmails : normalizedMembers.map(m => m.email),
      },
      columns,
      workflow,
      customFields,
      members: normalizedMembers,
      cards: normalizedCards,
      stats,
      generatedAt: new Date().toISOString(),
    };
  }
}

export default ContextAPI;
