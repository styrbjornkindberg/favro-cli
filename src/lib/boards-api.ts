import FavroHttpClient from './http-client';
import { getAllPages } from './paginate';
import { classifyThrownError } from './favro-error';
import { looksLikeName, resolveCollectionId, resolveNameToId } from './name-resolve';
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

/**
 * A count Favro measured, or `null` when nothing on the wire measures it.
 *
 * `null` is never rendered as `0`. The distinction is the whole point: a board
 * with nothing finished and a board whose finished count cannot be read are not
 * the same answer, and printing `0` for the second is the fail-closed violation
 * this type exists to make unspellable.
 */
export type MeasuredCount = number | null;

/**
 * Render a count for a human: the number, or the word `unknown`. **The one render
 * half of `MeasuredCount`.**
 *
 * It lives here rather than beside each formatter because it was written twice —
 * identically, in `commands/boards-get.ts` and `commands/boards-list.ts` — and only
 * one of the two copies had a test that read the printed cell. The copy nothing
 * asserted could be changed to `?? 0` and the whole suite stayed green, which is
 * the defect this batch removed, reintroduced in the renderer instead of the
 * counter. One function has one place to break.
 */
export const shown = (value: MeasuredCount): string | number => value ?? 'unknown';

export interface BoardStats {
  totalCards: MeasuredCount;
  doneCards: MeasuredCount;
  openCards: MeasuredCount;
  overdueCards: MeasuredCount;
}

export interface VelocityData {
  period: string;
  completed: MeasuredCount;
  /**
   * Cards ADDED in the period. Always `null`: nothing this CLI reads carries a
   * card's creation date on a board-level path, so there has never been a source
   * for it. It used to be the literal `0`, which is why `netChange` — defined as
   * completed minus added — was printed as if `added` were known to be zero.
   */
  added: MeasuredCount;
  netChange: MeasuredCount;
}

export interface ExtendedBoard extends Board {
  members?: BoardMember[];
  customFields?: CustomField[];
  boardColumns?: BoardColumn[];
  cards?: Array<{ status?: string; dueDate?: string; updatedAt?: string }>;
  stats?: BoardStats;
  velocity?: VelocityData[];
  /**
   * Why a `stats`/`velocity` facet came back `null`, when one did. Set by
   * `withBoardIncludes` and by nothing else — the ADR-0002 half of the fix, since a
   * bare `null` in a table is not something a reader can act on.
   *
   * ponytail: set on the NO-CARDS branch only, which is every branch any caller
   * reaches today (`/widgets/{id}` was measured to carry no cards). The ceiling is
   * the dormant cards branch: `added` and `netChange` are `null` there too — there
   * is no source for cards ADDED in a period either way — so a caller that ever
   * hydrates cards gets `Added: unknown` with no note beside it. Upgrade path for
   * that caller: set this from whether any attached facet is actually `null`, not
   * from whether cards were passed, and give `added` its own sentence.
   */
  unmeasured?: string;
}

/**
 * Aggregate board stats from card data, or report each facet unknown.
 *
 * **THERE IS NO CARD SOURCE ON ANY BOARD PATH. Measured 2026-08-12:**
 *
 *     GET /widgets/{id}?include=cards
 *       keys: archived, collectionIds, color, columns, editRole, name,
 *             organizationId, ownerRole, type, widgetCommonId
 *       has cards array: false
 *
 * Not an empty array — the key is absent, and `include=cards` does nothing on
 * that endpoint. `cardCount` is absent from the same response, so it too is read
 * as `null` rather than defaulted; if Favro ever sends one it is used, and until
 * then nothing here asserts either way (ADR-0003).
 *
 * So the no-cards branch below reports every card-derived facet as `null`. It
 * used to return `doneCards: 0`, `openCards: board.cardCount ?? 0` and
 * `overdueCards: 0`, and since that branch is the only one any live caller ever
 * takes, `favro boards get <b> --include stats` printed *0 done and 0 overdue
 * cards for every board*, as measured fact. `openCards` is `null` for the same
 * reason the other two are: a total is not a split, and reporting the total as
 * "open" asserts that nothing on the board is finished.
 *
 * The measured source that DOES exist is per-column: `GET /columns?widgetCommonId=`
 * carries `cardCount` on every column (`columns-api.ts`, and `cardCount` excludes
 * archived cards). It is not read here — see `withBoardIncludes` for why.
 *
 * The cards branch is unchanged and still reachable only from a caller that
 * hydrates column names onto `status` itself. Where a card carries a column name
 * under `status`, "is this card finished" is
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
 * **`status` IS NOT A WIRE FIELD.** Favro sends no `status` on a card —
 * `cards-api.ts` says so at `normalizeCard`, CONTEXT.md says so under
 * "column-as-status", and the open/closed axis on the wire is `columnId` and
 * nothing else. The field is filled in by `CardsAPI.hydrateNames`, which resolves
 * `columnId` → column name. That is why `isCompleted` (`api/standup.ts`) gets a
 * real name: its input came through `CardsAPI`. No board path does, and as of the
 * measurement above no board path has cards to hydrate in the first place, so the
 * widening the arms of the #157 test pin is reachable only through a caller that
 * does not exist yet. That is a dormant branch, which is a different thing from
 * the printed zeros it used to sit behind — those are gone.
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

  return {
    // `?? null`, not `?? 0`: absent means unread, and `/widgets/{id}` was
    // measured not to send this field at all.
    totalCards: board.cardCount ?? null,
    doneCards: null,
    openCards: null,
    overdueCards: null,
  };
}

/**
 * Calculate velocity from card completion data, or report each week unknown.
 *
 * **Called with no cards it names the four weeks and reports every figure
 * unknown, and that is the honest whole of it.** Weekly completion counts need
 * one `updatedAt` and one column name per card; the only board-level card source
 * would be `/widgets/{id}?include=cards`, measured 2026-08-12 to return no cards
 * array at all (see `aggregateBoardStats`), and reading cards per board is not on
 * this path. There is therefore no measured source for a series, and this returns
 * `null`s rather than inventing one. It used to return `completed: 0` for all four
 * weeks, which `boards get --include velocity` printed as a table of measured
 * facts, and `boards list --include velocity` printed as a single figure.
 *
 * `added` is `null` in **both** branches, cards or not — see `VelocityData`.
 * `netChange` follows it: completed minus an unknown is unknown, and the old
 * `netChange: completed` quietly asserted `added === 0`.
 *
 * `completed` routes through the one done judge for the same reason
 * `aggregateBoardStats` does (#157) — it carried a byte-identical exact-match
 * copy of the same test. Nothing caches or persists a velocity series: all four
 * weeks are recomputed from `updatedAt` on every invocation, so the reroute
 * changes the whole series at once rather than grafting a wider week onto
 * narrower history. There is no stored series for it to disagree with.
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
      velocity.push({ period, completed: null, added: null, netChange: null });
      continue;
    }

    const completed = cards.filter(c => {
      if (!c.updatedAt) return false;
      const updated = new Date(c.updatedAt);
      return updated >= weekStart && updated < weekEnd && isDoneStage(detectStage(c.status));
    }).length;

    velocity.push({ period, completed, added: null, netChange: null });
  }

  return velocity;
}

/**
 * The sentence a reader gets instead of a fabricated number, and the command that
 * *can* answer the question. ADR-0002: a facet reported unknown still has to leave
 * the reader somewhere to go.
 */
export const NO_CARD_SOURCE =
  'done/open/overdue counts and the velocity figures are unknown, not zero — ' +
  'GET /widgets/{id}?include=cards was measured (2026-08-12) to return no cards array at all, ' +
  'and no board path reads cards. For measured per-column card counts run: favro columns list <boardId>';

/**
 * Attach the requested `stats`/`velocity` facets, and the note naming whichever of
 * them nothing measured. **THE ONE PLACE ANY BOARD GETS EITHER FIELD.**
 *
 * There were four call sites before this existed — two in `getBoardWithIncludes`,
 * two in `listBoardsByCollection`, plus a fifth pair inlined in
 * `commands/boards-list.ts` — and three of the five passed no cards at all, so the
 * "fall back to board metadata" branch was not a fallback but the only branch
 * anything reached. Routing all of them through here means a facet cannot be
 * unknown on one command and a printed `0` on another, and a future card source
 * has one function to be wired into rather than five.
 *
 * Returns a new board; it does not mutate the argument.
 *
 * ponytail: this does NOT fetch `/columns` to source `totalCards` from the
 * measured per-column `cardCount`, which would turn one facet from unknown into a
 * real figure. The ceiling is the list path: `boards list --include stats` would
 * need one `/columns` request per board, and 322 boards is the measured worst case
 * (see `commands/boards-list.ts`). Upgrade path if that facet is worth the calls:
 * fetch `/columns` once per board inside `getBoardWithIncludes` only, leave the
 * list path unknown, and say which command does which in `API-REFERENCE.md`.
 */
export function withBoardIncludes(board: ExtendedBoard, include?: string[]): ExtendedBoard {
  const wantsStats = include?.includes('stats') ?? false;
  const wantsVelocity = include?.includes('velocity') ?? false;
  if (!wantsStats && !wantsVelocity) return board;

  const cards = Array.isArray(board.cards) && board.cards.length > 0 ? board.cards : undefined;

  return {
    ...board,
    ...(wantsStats ? { stats: aggregateBoardStats(board, cards) } : {}),
    ...(wantsVelocity ? { velocity: calculateVelocity(cards) } : {}),
    ...(cards ? {} : { unmeasured: NO_CARD_SOURCE }),
  };
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

    // Stats and velocity are computed client-side if requested. `include=cards`
    // is still forwarded on the query string — Favro is free to start honouring
    // it, and `withBoardIncludes` uses the array the moment one arrives — but it
    // was measured (2026-08-12) to come back with no `cards` key, so on today's
    // wire this is the no-cards branch and every card-derived facet is `null`.
    return withBoardIncludes(board, include);
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
    const collectionId = await resolveCollectionId(
      this.client,
      collection,
      'favro boards list --collection <collectionId>'
    );
    const params: Record<string, any> = { collectionId };
    if (include && include.length > 0) {
      params.include = include.join(',');
    }

    const raw = await getAllPages<RawWidget>(this.client, '/widgets', { ...params, limit: 50 });
    const allBoards = raw.map(w => ({ ...w, ...normalizeWidget(w) })) as ExtendedBoard[];

    // Augment each board with stats/velocity if requested. The list read carries
    // no cards on any wire, measured or otherwise, so this is unconditionally the
    // unknown branch — which is exactly why it goes through the shared attach
    // rather than calling the counters with nothing and printing the result.
    return allBoards.map(board => withBoardIncludes(board, include));
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

}

export default BoardsAPI;
