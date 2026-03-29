import FavroHttpClient from './http-client';

export interface Column {
  columnId: string;
  name: string;
  position: number;
  color?: string;
  boardId: string;
}

export interface PaginatedResponse<T> {
  entities: T[];
  requestId?: string;
  pages?: number;
}

export class ColumnsAPI {
  constructor(private client: FavroHttpClient) {}

  /**
   * List all columns for a specific board.
   */
  async listColumns(boardId: string): Promise<Column[]> {
    const allColumns: Column[] = [];
    let requestId: string | undefined;
    let page = 0;

    while (true) {
      const params: Record<string, any> = { widgetCommonId: boardId };
      if (requestId) {
        params.requestId = requestId;
        params.page = page;
      }

      const response = await this.client.get<PaginatedResponse<Column>>('/columns', { params });
      
      if (response && response.entities) {
        allColumns.push(...response.entities);
      }

      requestId = response.requestId;
      if (!requestId || !response.pages || page >= response.pages - 1 || !response.entities || response.entities.length === 0) {
        break;
      }
      page++;
    }

    return allColumns.sort((a, b) => a.position - b.position);
  }

  /**
   * Get a specific column.
   */
  async getColumn(columnId: string): Promise<Column> {
    return this.client.get<Column>(`/columns/${columnId}`);
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
