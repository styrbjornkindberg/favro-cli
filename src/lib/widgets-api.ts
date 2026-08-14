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
 * asymmetry is the whole point. A GET row carries `widgetCommonId` — probe-
 * measured on every row of `GET /cards`
 * (`docs/research/tracker-contract-favro-carriers.md` §1.3, full key set), and
 * documented (not probed) on a `GET /widgets` row
 * (`docs/research/name-id-resolution.md:82`, quoting Favro's "Get all widgets"
 * response fields). The **commit PUT's response** carries it too: measured
 * 2026-08-14 (#161) on the #105 scratch board, one `widgets add` against a live
 * board, whose printed `widgetCommonId` is this echo and nothing else — the field
 * below has no fallback.
 *
 * ONE observation of a success, which is why the field stays optional and the
 * caller still reports UNCONFIRMED on a silence rather than throwing: `moveCard`
 * earned its throw from a probe that measured the failure shapes too
 * (`202 {"message":"Access denied"}`, no board on the body), and nothing here has
 * measured what THIS write answers when it is refused. Inferring that from the
 * sibling arm is the step ADR-0003 refuses.
 *
 * So the field is absent when the response did not carry it, and the caller
 * reports the write UNCONFIRMED rather than substituting the board it asked
 * for. That substitution is what re-opened #82.
 */
export interface CommittedWidget extends Omit<Widget, 'widgetCommonId'> {
  widgetCommonId?: string;
}

/**
 * One board instance of a card — the row `widgets list --card` answers with.
 *
 * `boardId` is the instance's `widgetCommonId`, and it is OPTIONAL because an
 * entity carrying none is a fork (an assignment entity with no board), which
 * `query-parser.ts`'s `isUnblocked` already treats as nothing to act on. Such a
 * row is listed rather than dropped: absent stays distinguishable from empty
 * (`read-shape.ts` rule 3), and a card that exists only as a fork is exactly the
 * answer someone asking "which boards is this on" needs to see.
 */
export interface CardInstance {
  cardId: string;
  cardCommonId?: string;
  /** The instance's `widgetCommonId`. Absent on a fork. */
  boardId?: string;
  columnId?: string;
  name?: string;
  archived?: boolean;
}

export class WidgetsAPI {
  constructor(private client: FavroHttpClient) {}

  /**
   * Every board instance of one card.
   *
   * `GET /cards?cardCommonId=<x>` **without `unique`** — one entity per
   * instance, each carrying its own `cardId` and `widgetCommonId`. That is the
   * route `docs/research/card-identifier-semantics.md` §3.3 named as the fix,
   * and §5 filed as unverified; it is measured now, 2026-08-14 on the #105
   * scratch board: one entity for a one-board card, `pages: 1`.
   *
   * It used to read `GET /widgets?cardCommonId=<x>` and keep the rows with
   * `type === 'card'`, which answered `{"rows":[]}` for every card that has ever
   * been passed to it. Both halves were wrong and each alone was fatal: the same
   * probe measured `/widgets` returning **421 rows — every board in the
   * organisation, `cardCommonId` ignored** (`favro boards list` counts the same
   * 421) — whose types are `backlog` and `board`, and not one `card`.
   *
   * `unique` is not sent. It collapses the multi-instance result to one row,
   * which is the one thing this read must not do.
   *
   * `archived` is not sent either, and unlike `listCards` that is not a default
   * being taken — it is the answer. Measured 2026-08-14: a card archived on the
   * scratch board still comes back here, carrying `archived: true`. An archived
   * instance IS an instance of that card on that board, and the row says which,
   * so filtering it out would be this command answering "no instances" again.
   */
  async listInstancesOfCard(cardCommonId: string): Promise<CardInstance[]> {
    const entities = await getAllPages<CardInstance & { widgetCommonId?: string }>(
      this.client,
      '/cards',
      { cardCommonId },
    );

    return entities.map(({ widgetCommonId, ...card }) => ({
      cardId: card.cardId,
      cardCommonId: card.cardCommonId,
      boardId: widgetCommonId,
      columnId: card.columnId,
      name: card.name,
      archived: card.archived,
    }));
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
