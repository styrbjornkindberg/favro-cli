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
import { readCache, readCacheRecord, writeCache, CACHE_TTL_MS } from './name-cache';

export interface ColumnRef {
  columnId: string;
  name: string;
  boardId: string;
}

const norm = (s: string): string => s.trim().toLowerCase();

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
