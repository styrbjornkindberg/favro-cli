/**
 * Shared column module (#39).
 *
 * Owns the persistent column cache and answers all three directions off one
 * fetch: name→id, id→name, id→board membership.
 *
 * Fill strategy: org-wide from a single `GET /widgets` (board widgets inline
 * their columns; `GET /columns` 400s without widgetCommonId). Per-board
 * top-ups use `ColumnsAPI.listColumns`.
 *
 * Every lookup that finds nothing refills before answering "no" — a cache miss
 * is never evidence on its own.
 *
 * Accepted risk (see #39): names are not stable identifiers, so a rename inside
 * the TTL window still mis-matches. The TTL is mitigation, not a fix.
 */
import FavroHttpClient from './http-client';
import ColumnsAPI from './columns-api';
import WidgetsAPI from './widgets-api';
import { foldName } from './fold-name';
import { readCache, readCacheRecord, writeCache, CACHE_TTL_MS } from './name-cache';
import { RefusalError } from './refusal';

export interface ColumnRef {
  columnId: string;
  name: string;
  boardId: string;
}

/**
 * One shared fold, not a private copy: a column name typed by a human and the
 * one Favro sent can be the same name in two normalisation forms (#141).
 */
const norm = foldName;

/**
 * A refusal that names the candidates and the flag that settles them.
 *
 * A board/column disagreement is refused rather than forwarded, because the
 * wire will not refuse it: `GET /cards` accepts a `columnId` alone, lets it
 * **override** `widgetCommonId`, and never validates the pair — so
 * `--board A --status <id-from-B>` answers 200 and populated, about a board
 * nobody asked for.
 *
 * A `RefusalError`: the same call resolves the same way, so retrying it is the
 * loop #81 closed — the dispatch table reads that base class and nothing else.
 */
export class ColumnResolutionError extends RefusalError {
  constructor(
    message: string,
    readonly value: string,
    readonly candidates: ColumnRef[] = [],
  ) {
    super(message);
    this.name = 'ColumnResolutionError';
  }
}

function listColumnsFor(columns: ColumnRef[]): string {
  if (columns.length === 0) return '  (that board has no columns)';
  return columns.map((c) => `  ${c.columnId}  ${c.name}`).join('\n');
}

export class ColumnDirectory {
  private columnsApi: ColumnsAPI;
  private widgetsApi: WidgetsAPI;

  constructor(client: FavroHttpClient, private organizationId?: string) {
    this.columnsApi = new ColumnsAPI(client);
    this.widgetsApi = new WidgetsAPI(client);
  }

  /** Every known column in the org. Cached; fills org-wide on miss. */
  async listAll(): Promise<ColumnRef[]> {
    const cached = await readCache<ColumnRef>(this.organizationId, 'columns');
    return cached ?? this.refill();
  }

  /**
   * Refetch columns and store them.
   * With a `boardId` and a still-fresh cache, tops up just that board (keeping
   * the org-wide timestamp); otherwise refills the whole org in one call.
   */
  async refill(boardId?: string): Promise<ColumnRef[]> {
    const record = boardId ? await readCacheRecord<ColumnRef>(this.organizationId, 'columns') : undefined;

    if (boardId && record && Date.now() - record.fetchedAt < CACHE_TTL_MS) {
      const columns = await this.columnsApi.listColumns(boardId);
      const merged = [
        ...record.entries.filter(c => c.boardId !== boardId),
        ...columns.map(c => ({ columnId: c.columnId, name: c.name, boardId: c.boardId ?? boardId })),
      ];
      await writeCache(this.organizationId, 'columns', merged, record.fetchedAt);
      return merged;
    }

    const widgets = await this.widgetsApi.listWidgets();
    const refs = widgets.flatMap(w =>
      (w.columns ?? []).map(c => ({ columnId: c.columnId, name: c.name, boardId: w.widgetCommonId }))
    );
    await writeCache(this.organizationId, 'columns', refs);
    return refs;
  }

  /** name→id. Case-insensitive. Optionally scoped to one board. */
  async findByName(name: string, boardId?: string): Promise<ColumnRef[]> {
    const wanted = norm(name);
    const match = (cols: ColumnRef[]) =>
      cols.filter(c => norm(c.name) === wanted && (!boardId || c.boardId === boardId));
    return this.resolve(match, boardId);
  }

  /** id→name. */
  async nameOf(columnId: string): Promise<string | undefined> {
    const found = await this.resolve(cols => cols.filter(c => c.columnId === columnId));
    return found[0]?.name;
  }

  /** id→board membership. */
  async boardOf(columnId: string): Promise<string | undefined> {
    const found = await this.resolve(cols => cols.filter(c => c.columnId === columnId));
    return found[0]?.boardId;
  }

  /**
   * Settle a `--status` / `--column` argument to a `columnId`.
   *
   * A column has exactly two shapes and both are locally checkable against the
   * cache, so detection is shape-first with **no fallback in either
   * direction** — a name never degrades into an id lookup, and an id never
   * degrades into a name search.
   *
   * Scope: a **name requires a board** (a column name is only unique within
   * one). An **id permits a board or nothing**, and when a board is given the
   * pair is validated rather than forwarded.
   *
   * Both shapes are answered from **one** snapshot: probing them separately
   * made every name lookup refill the whole org, because the id probe missed
   * first and a miss refills.
   */
  async resolveColumnId(value: string, boardId?: string): Promise<string> {
    const wanted = value.trim();
    const byId = (cols: ColumnRef[]) => cols.filter(c => c.columnId === wanted);
    const byName = (cols: ColumnRef[]) =>
      cols.filter(c => c.boardId === boardId && norm(c.name) === norm(wanted));

    const cached = await readCache<ColumnRef>(this.organizationId, 'columns');
    let cols = cached ?? await this.refill();
    // A miss is never the answer on its own — refill once, then decide. Org-wide:
    // a per-board top-up would replace this board's entries with whatever
    // `GET /columns` returns, so an empty answer would erase what we'd report.
    if (cached && byId(cols).length === 0 && byName(cols).length === 0) {
      cols = await this.refill();
    }
    const onBoard = cols.filter(c => c.boardId === boardId);

    const [column] = byId(cols);
    if (column) {
      if (boardId && column.boardId !== boardId) {
        throw new ColumnResolutionError(
          `Column ${wanted} is on board ${column.boardId}, not ${boardId}. ` +
          `The wire would answer about ${column.boardId} without saying so. That board's columns:\n${listColumnsFor(onBoard)}`,
          wanted,
          onBoard,
        );
      }
      return column.columnId;
    }

    if (!boardId) {
      throw new ColumnResolutionError(
        `Column name "${wanted}" needs a board — a column name is only unique within one. Pass --board <board>, or give the columnId instead.`,
        wanted,
      );
    }

    const matches = byName(cols);
    if (matches.length === 1) return matches[0].columnId;
    if (matches.length > 1) {
      throw new ColumnResolutionError(
        `Board ${boardId} has ${matches.length} columns named "${wanted}" — refusing to pick one. Pass the id instead:\n${listColumnsFor(matches)}`,
        wanted,
        matches,
      );
    }

    throw new ColumnResolutionError(
      `No column named "${wanted}" on board ${boardId} — it is missing or not visible to your key. That board's columns:\n${listColumnsFor(onBoard)}`,
      wanted,
      onBoard,
    );
  }

  /** Look in the cache, and refill once before reporting a miss. */
  private async resolve(match: (cols: ColumnRef[]) => ColumnRef[], boardId?: string): Promise<ColumnRef[]> {
    const cached = await readCache<ColumnRef>(this.organizationId, 'columns');
    const hit = cached ? match(cached) : [];
    if (hit.length > 0) return hit;
    // Miss is never the answer on its own — refill, then decide.
    return match(await this.refill(cached ? boardId : undefined));
  }
}

export default ColumnDirectory;
