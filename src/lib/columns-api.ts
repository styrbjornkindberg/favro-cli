import FavroHttpClient from './http-client';
import { getAllPages } from './paginate';

export interface Column {
  columnId: string;
  name: string;
  position: number;
  color?: string;
  boardId: string;
  /**
   * Favro already sends these three on every `GET /columns` response, so a
   * per-column count costs nothing. `cardCount` excludes archived cards.
   */
  cardCount?: number;
  timeSum?: number;
  estimationSum?: number;
}

export class ColumnsAPI {
  constructor(private client: FavroHttpClient) {}

  /**
   * List all columns for a specific board.
   */
  async listColumns(boardId: string): Promise<Column[]> {
    const allColumns = await getAllPages<Column>(this.client, '/columns', { widgetCommonId: boardId });

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
