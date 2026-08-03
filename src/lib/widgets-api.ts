import FavroHttpClient from './http-client';
import BoardsAPI from './boards-api';
import { getAllPages } from './paginate';

export interface Widget {
  widgetCommonId: string;
  cardId?: string; // Sometimes widgets omit this or return exactly cardCommonId depending on endpoint
  name: string;
  type: string;
  boardId?: string;
  columnId?: string;
  collectionIds?: string[];
  /** Board widgets inline their columns; `GET /columns` 400s without widgetCommonId */
  columns?: Array<{ columnId: string; name: string; position?: number; color?: string }>;
}

/**
 * What `addWidgetToBoard` can honestly report back.
 *
 * `widgetCommonId` is **optional here and required on `Widget`**, and that
 * asymmetry is the whole point. A GET row always carries `widgetCommonId` —
 * measured on every row of `GET /cards`
 * (`docs/research/tracker-contract-favro-carriers.md` §1.3, full key set) and on
 * every `GET /widgets` row (`docs/research/name-id-resolution.md:82`). Whether
 * the **commit PUT's response** echoes it back is **unmeasured**, and a
 * read-side row is not a write-side echo — the distinction
 * `UpdateCardRequest.columnId` records for itself (#101), and the step ADR-0003
 * refuses.
 *
 * So the field is absent when the response did not carry it, and the caller
 * reports the write UNCONFIRMED rather than substituting the board it asked
 * for. That substitution is what re-opened #82.
 */
export interface CommittedWidget extends Omit<Widget, 'widgetCommonId'> {
  widgetCommonId?: string;
}

export class WidgetsAPI {
  constructor(private client: FavroHttpClient) {}

  /**
   * List widgets for a specific card.
   * This reveals all the individual board instances (widgets) that span from a single cardCommonId.
   */
  async listWidgetsForCard(cardCommonId: string): Promise<Widget[]> {
    const allWidgets = await getAllPages<Widget>(this.client, '/widgets', { cardCommonId });

    // Filter to ensure we only return card widgets (not boards/lists)
    return allWidgets.filter(w => w.type === 'card');
  }

  /**
   * List every widget (board) in the organization. Each entry inlines its
   * `columns`, so this is one call for the whole org's columns.
   */
  async listWidgets(): Promise<Widget[]> {
    return getAllPages<Widget>(this.client, '/widgets');
  }

  /**
   * Settle a board reference — a NAME or an id — to the `widgetCommonId` the
   * wire wants. The twin of `CardsAPI.boardIdOf`, here because `widgets add`
   * is a `PUT /cards/:cardId` carrying `widgetCommonId` — card-shaped by every
   * definition #82 uses — that never touches `CardsAPI`, so the guard over
   * there cannot see it. Unresolved, Favro answers 200 and the write lands
   * nowhere, and the caller prints a success (#82).
   */
  private boardIdOf(board: string): Promise<string> {
    return new BoardsAPI(this.client).resolveBoardId(board);
  }

  /**
   * Add a card to a board by committing it via the cards API.
   * Favro's PUT /cards/:cardId with widgetCommonId + dragMode 'commit'
   * adds the card to the target board without removing it from its current board.
   *
   * `board` is a NAME or a `widgetCommonId`; it settles BEFORE the card lookup,
   * so an unresolvable board refuses without reading anything.
   *
   * The returned `widgetCommonId` is the **observed** one and may be absent —
   * see `CommittedWidget`. It is never backfilled from `boardId`: this endpoint
   * IS #82's, whose bug was `✓ Widget added to board` printing for a write that
   * never landed, and answering with the board we asked for cannot distinguish a
   * landed commit from a silent one.
   */
  async addWidgetToBoard(board: string, cardCommonId: string, columnId?: string): Promise<CommittedWidget> {
    const boardId = await this.boardIdOf(board);

    // Step 1: Resolve cardCommonId → cardId by fetching any instance
    const res = await this.client.get<{ entities: Array<{ cardId: string; cardCommonId: string; name: string }> }>(
      '/cards',
      { params: { cardCommonId, unique: true } }
    );

    if (!res.entities || res.entities.length === 0) {
      throw new Error(`No card found with cardCommonId: ${cardCommonId}`);
    }

    const cardId = res.entities[0].cardId;

    // Step 2: Commit the card to the target board
    const data: Record<string, unknown> = {
      widgetCommonId: boardId,
      dragMode: 'commit',
    };
    if (columnId) {
      data.columnId = columnId;
    }

    const updated = await this.client.put<any>(`/cards/${cardId}`, data);

    // Return a Widget-shaped response for CLI compatibility.
    //
    // `widgetCommonId` carries NO fallback — an absent echo stays absent. The
    // two fields below do fall back, and legitimately: they degrade to values
    // READ from the `GET /cards` above, not to an argument. `boardId` is the
    // argument, which is why it is not allowed to stand in for the observation.
    return {
      widgetCommonId: updated.widgetCommonId,
      name: updated.name ?? res.entities[0].name,
      type: 'card',
      cardId: updated.cardId ?? cardId,
      columnId: updated.columnId,
    };
  }
}

export default WidgetsAPI;
