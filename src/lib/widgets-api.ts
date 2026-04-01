import FavroHttpClient from './http-client';

export interface Widget {
  widgetCommonId: string;
  cardId?: string; // Sometimes widgets omit this or return exactly cardCommonId depending on endpoint
  name: string;
  type: string;
  boardId?: string;
  columnId?: string;
  collectionIds?: string[];
}

export interface PaginatedResponse<T> {
  entities: T[];
  requestId?: string;
  pages?: number;
}

export class WidgetsAPI {
  constructor(private client: FavroHttpClient) {}

  /**
   * List widgets for a specific card.
   * This reveals all the individual board instances (widgets) that span from a single cardCommonId.
   */
  async listWidgetsForCard(cardCommonId: string): Promise<Widget[]> {
    const allWidgets: Widget[] = [];
    let requestId: string | undefined;
    let page = 0;

    while (true) {
      const params: Record<string, any> = { cardCommonId };
      if (requestId) {
        params.requestId = requestId;
        params.page = page;
      }

      const response = await this.client.get<PaginatedResponse<Widget>>('/widgets', { params });
      
      if (response && response.entities) {
        allWidgets.push(...response.entities);
      }

      requestId = response.requestId;
      if (!requestId || !response.pages || page >= response.pages - 1 || !response.entities || response.entities.length === 0) {
        break;
      }
      page++;
    }

    // Filter to ensure we only return card widgets (not boards/lists)
    return allWidgets.filter(w => w.type === 'card');
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
