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
   * Add a card to a board by creating a new widget instance of it.
   */
  async addWidgetToBoard(boardId: string, cardCommonId: string, columnId?: string): Promise<Widget> {
    const payload: any = { type: 'card', name: 'Placeholder' }; // When referencing an existing commonId, Favro maps the native fields over
    // If we specify cardCommonId in the payload, wait, Favro API documentation says:
    // "Create a widget" -> POST /widgets. Required: name, type ('card'), collectionId or boardId.
    // To add an existing card to a board, you pass `cardCommonId` and `boardId`.
    
    // Favro schema for attaching a card:
    const data: any = {
      boardId,
      cardCommonId,
      type: 'card',
      name: 'Card Instance' // Usually overridden by the server using the existing cardCommonId properties
    };
    
    // if column is provided, place it there
    if (columnId) {
      data.columnId = columnId;
    }

    return this.client.post<Widget>('/widgets', data);
  }
}

export default WidgetsAPI;
