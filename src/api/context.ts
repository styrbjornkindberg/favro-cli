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
import { customFieldMap } from '../lib/custom-field-map';
import { FavroApiClient } from './members';
import { CustomFieldsAPI, CustomFieldDefinition } from '../lib/custom-fields-api';
import { ColumnsAPI } from '../lib/columns-api';
import { detectStage, WorkflowStage } from '../lib/workflow-stage';
import { blockingEdges } from '../lib/blocking';
import { COLUMNS_FACET, holeCollector, Unreachable } from '../lib/read-shape';

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
  /**
   * Facets this snapshot could not read. Present only when there are any, so an
   * absent marker with `cards: []` means the board is genuinely empty rather
   * than unreadable (`read-shape.ts` rule 3, #116).
   *
   * The KEY is `unreachable` and the entries are `{id, reason}` objects — the
   * one shape `favro help issue-tracker` documents and #86 converged the three
   * producers onto. `id` is the facet name (`cards`, `members`, `columns`,
   * `customFields`, `board`), not a card id: what could not be looked at here
   * is a whole fetch.
   */
  unreachable?: Unreachable[];
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
 *
 * Reconciling the four changed behaviour for two callers, deliberately:
 *
 *   - `favro next` — an empty effort field (`{Effort: null}`) used to reach
 *     `Number(null) === 0` and score the card as a zero-effort *quick win*. It
 *     is now `undefined` and scores no bonus.
 *   - `favro sprint-plan` — this was the copy with the 8-entry literal key list,
 *     so three things move. Iteration order flips from a fixed key priority to
 *     the card's own field order (`{Estimate: 8, Effort: 3}` was 3, is now 8).
 *     Name matching broadens to a substring regex, which picks up `Effort
 *     (hours)` and also `Checkpoints`. And `{Effort: ''}` was `Number('') === 0`
 *     and is now `undefined`, which `compareSprintCards` sorts as `Infinity` —
 *     the card moves from first in its priority band to last and stops
 *     contributing to `cumulative` / `withinBudget`.
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
 *
 * Exported for `api/query.ts`, which filters the RAW cards — the grammar reads
 * Favro's own field names — and normalises only the survivors (#95). A second
 * copy of this mapping is how the two would drift apart.
 */
export function normalizeCard(card: Card): ContextCard {
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

  // Custom fields — build a key→value map. `customFieldMap` owns the key,
  // shared with `aggregate.ts` since #167 item 5: both copies keyed on
  // `name ?? fieldId`, neither of which the wire sends.
  if (card.customFields && card.customFields.length > 0) {
    ctx.customFields = customFieldMap(card.customFields);
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
   * Find a board by id or by exact name.
   *
   * One call into `BoardsAPI.getBoard`, which is the resolver: an id reads
   * directly and escalates to `resolveBoardId` only on a classified not-found,
   * and a name matches trimmed, case-insensitive and EXACT.
   *
   * The substring fallback this used to carry is deleted (#122, ADR-0003). It
   * took the first partial hit with no ambiguity refusal, so `--board "Dev"`
   * returned some other board's cards with no signal at all. Refusing with the
   * candidate list is the cost, and it is the point. The old path also capped
   * at `listBoards(100)` against an org measured at 322 boards; the resolver
   * paginates to completion.
   */
  async resolveBoard(boardRef: string): Promise<Board> {
    return this.boardsApi.getBoard(boardRef);
  }

  /**
   * Get complete board context snapshot.
   * Fetches board metadata, columns, custom fields, members, and cards in parallel.
   *
   * There is no card cap, and there is deliberately no parameter for one. This
   * used to declare `cardLimit: number = 1000` and never read it, so fourteen
   * commands and a skill step computed a number, threaded it here and had it
   * discarded — a `--limit` advertising a fetch cap it never applied (#143
   * close comment).
   * Deleted rather than wired: `listCards` reads the board to completion, and a
   * cap that cut it would silently unbalance `stats` below, which every caller
   * reports as measured.
   *
   * ponytail: unbounded read. The ceiling is #132's — a 422-board workspace
   * measured at 10601 cards pages all of them. The upgrade path is a cap that
   * DISCLOSES, i.e. a `capped` field on this snapshot that every caller renders,
   * not a parameter nothing reads.
   *
   * @param boardRef  Board ID or board name
   */
  async getSnapshot(boardRef: string): Promise<BoardContextSnapshot> {
    // Step 1: Resolve board (required before parallel fetch)
    const board = await this.resolveBoard(boardRef);
    const boardId = board.boardId;

    // Step 2: Fetch all board data in parallel.
    //
    // A facet that fails still falls back, because one dead sub-fetch must not
    // cost the caller the other four — but it is RECORDED now (#116). It used
    // to be swallowed by a bare `.catch(() => [])`, so a failed cards read came
    // back as `cards: []` and `stats.total: 0`, and every consumer of this
    // snapshot — `context`, `standup`, `sprint-plan`, `query` — reported "we
    // could not look" as "there is nothing there".
    //
    // Built off `holeCollector` rather than `boundedSweep`: these are five
    // different calls with five different return types, so there is no `ids`
    // list to sweep and no shared row to collect. Routing them through it would
    // also serialise them, and the parallelism is this snapshot's whole
    // performance budget (< 1s for 500 cards). `holeCollector` lives in
    // `read-shape.ts` because `AggregateAPI` needs the same fan-out (#148).
    const { unreachable, orElse } = holeCollector();

    const [extendedBoard, cards, members, customFieldDefs, rawColumns] = await Promise.all([
      orElse('board', this.boardsApi.getBoardWithIncludes(boardId, ['custom-fields', 'members']), board as any),
      orElse('cards', this.cardsApi.listCards(boardId), [] as Card[]),
      orElse('members', this.membersApi.getMembers({ boardId }), []),
      orElse('customFields', this.customFieldsApi.listFields(boardId), [] as CustomFieldDefinition[]),
      // `COLUMNS_FACET`, not `'columns'`: `excludeUnreadableBoards` matches this
      // exact id to know a single-board snapshot went dark, and a literal spelled
      // in both files is how that match came to be missing for two tickets (#149).
      orElse(COLUMNS_FACET, this.columnsApi.listColumns(boardId), []),
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
      ...(unreachable.length > 0 ? { unreachable } : {}),
      generatedAt: new Date().toISOString(),
    };
  }
}

export default ContextAPI;
