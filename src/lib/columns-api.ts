import FavroHttpClient from './http-client';
import { getAllPages } from './paginate';

export interface Column {
  columnId: string;
  name: string;
  position: number;
  color?: string;
  /**
   * MEASURED 2026-08-12 against the throwaway board: `GET /columns?widgetCommonId=<board>`
   * answers with the keys `cardCount, columnId, estimationSum, name, organizationId,
   * position, timeSum, widgetCommonId` — it carries **`widgetCommonId`, and no
   * `boardId` at all**. This field was declared as a required `boardId: string`, so
   * every read of it was `undefined` at runtime while the type promised a string:
   * `columns update` fed `col.boardId ?? ''` to `checkScope`, which refuses an empty
   * board id on purpose, so under a configured scope lock that command refused every
   * column however legitimate — and `--force` deliberately does not rescue that
   * refusal (`safety.ts:190-192`).
   *
   * The single-column `GET /columns/{columnId}` shape is UNMEASURED, so `normalizeColumn`
   * reads both spellings and asserts neither (ADR-0003). `boardId` is the name the rest
   * of the CLI resolves boards by, so reads normalise onto it; it stays optional because
   * a response carrying neither spelling must reach the fail-closed refusal rather than
   * an empty string that reads as a board.
   */
  boardId?: string;
  widgetCommonId?: string;
  /**
   * Favro already sends these three on every `GET /columns` response, so a
   * per-column count costs nothing. `cardCount` excludes archived cards.
   */
  cardCount?: number;
  timeSum?: number;
  estimationSum?: number;
}

/**
 * Fill `boardId` from whichever spelling the response carried. Every read path in
 * this class goes through it, so no caller has to know that the wire says
 * `widgetCommonId` — and a payload with neither spelling keeps `boardId`
 * `undefined`, which is what the scope check needs in order to refuse.
 *
 * Two details that a mutation run proved were unasserted, and are now pinned:
 *
 * **`widgetCommonId` wins when both are present.** It is the spelling the wire was
 * measured to send; `boardId` is this repo's own normalised name, so a payload carrying
 * both would mean either that Favro started sending `boardId` too, or that an
 * already-normalised object is being normalised again. In the first case the measured
 * field is the one to trust, and in the second the two agree and the order cannot matter.
 * Letting the unmeasured spelling win a disagreement is the shape ADR-0003 exists to stop.
 *
 * **An empty string is not a board id**, from either spelling — hence `||` and not `??`.
 * `''` reaching `checkScope` is the exact value that produced the original defect, and it
 * has to arrive as `undefined` so the refusal fires rather than a lock silently checking
 * nothing. `undefined` is the fail-closed value here; `''` only looks like one.
 *
 * ponytail: the two WRITE paths (`createColumn`, `updateColumn`) deliberately return
 * their response unnormalised. No caller reads `boardId` off either — both print
 * `columnId`/`name` or dump the payload verbatim, and normalising there would put a key
 * into a `--json` dump that the wire never sent. If a caller ever needs the board off a
 * write result, wrap those two the same way rather than reaching for `widgetCommonId` at
 * the use site.
 */
function normalizeColumn(raw: Column): Column {
  const boardId = raw.widgetCommonId || raw.boardId || undefined;
  return boardId === undefined ? raw : { ...raw, boardId };
}

export class ColumnsAPI {
  constructor(private client: FavroHttpClient) {}

  /**
   * List all columns for a specific board.
   */
  async listColumns(boardId: string): Promise<Column[]> {
    const allColumns = await getAllPages<Column>(this.client, '/columns', { widgetCommonId: boardId });

    return allColumns.map(normalizeColumn).sort((a, b) => a.position - b.position);
  }

  /**
   * Get a specific column.
   */
  async getColumn(columnId: string): Promise<Column> {
    return normalizeColumn(await this.client.get<Column>(`/columns/${columnId}`));
  }

  /**
   * Create a new column on a board.
   */
  async createColumn(boardId: string, name: string, position?: number): Promise<Column> {
    const payload: any = { widgetCommonId: boardId, name };
    if (position !== undefined) {
      payload.position = position;
    }
    return this.client.post<Column>('/columns', payload);
  }

  /**
   * Update an existing column.
   */
  async updateColumn(columnId: string, data: { name?: string; position?: number }): Promise<Column> {
    return this.client.put<Column>(`/columns/${columnId}`, data);
  }

  /**
   * Delete a column.
   */
  async deleteColumn(columnId: string): Promise<void> {
    await this.client.delete(`/columns/${columnId}`);
  }
}

export default ColumnsAPI;
