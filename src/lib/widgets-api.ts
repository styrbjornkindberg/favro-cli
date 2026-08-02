import FavroHttpClient from './http-client';
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
   * Add a card to a board by committing it via the cards API.
   * Favro's PUT /cards/:cardId with widgetCommonId + dragMode 'commit'
   * adds the card to the target board without removing it from its current board.
   */
  async addWidgetToBoard(boardId: string, cardCommonId: string, columnId?: string): Promise<Widget> {
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

    // Return a Widget-shaped response for CLI compatibility
    return {
      widgetCommonId: updated.widgetCommonId ?? boardId,
      name: updated.name ?? res.entities[0].name,
      type: 'card',
      cardId: updated.cardId ?? cardId,
      columnId: updated.columnId,
    };
  }
}

export default WidgetsAPI;
