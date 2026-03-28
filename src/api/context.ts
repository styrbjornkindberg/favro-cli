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
  createdAt?: string;
  updatedAt?: string;
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

// ─── Helper Functions ─────────────────────────────────────────────────────────

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
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };

  // Custom fields — build a key→value map
  if (card.customFields && card.customFields.length > 0) {
    ctx.customFields = {};
    for (const cf of card.customFields) {
      ctx.customFields[cf.name ?? cf.fieldId] = cf.value;
    }
  }

  // Relationship links (depends-on → blockedBy, blocks → blocking)
  if (card.links && card.links.length > 0) {
    ctx.blockedBy = card.links
      .filter(l => l.type === 'depends-on')
      .map(l => l.cardId);
    ctx.blocking = card.links
      .filter(l => l.type === 'blocks')
      .map(l => l.cardId);
  } else {
    ctx.blockedBy = [];
    ctx.blocking = [];
  }

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

  constructor(private client: FavroHttpClient) {
    this.boardsApi = new BoardsAPI(client);
    this.cardsApi = new CardsAPI(client);
    this.membersApi = new FavroApiClient(client);
    this.customFieldsApi = new CustomFieldsAPI(client);
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
    const [extendedBoard, cards, members, customFieldDefs] = await Promise.all([
      this.boardsApi.getBoardWithIncludes(boardId, ['custom-fields', 'members']).catch(() => board as any),
      this.cardsApi.listCards(boardId, cardLimit).catch(() => [] as Card[]),
      this.membersApi.getMembers({ boardId }).catch(() => []),
      this.customFieldsApi.listFields(boardId).catch(() => [] as CustomFieldDefinition[]),
    ]);

    // Extract columns from extended board response
    const columns = (extendedBoard.boardColumns ?? []).map((col: BoardColumn) => ({
      id: col.columnId,
      name: col.name,
      cardCount: col.cardCount,
    }));

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
      customFields,
      members: normalizedMembers,
      cards: normalizedCards,
      stats,
      generatedAt: new Date().toISOString(),
    };
  }
}

export default ContextAPI;
