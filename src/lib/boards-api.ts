import FavroHttpClient from './http-client';

export interface Board {
  boardId: string;
  name: string;
  description?: string;
  collectionId?: string;
  cardCount?: number;
  columns?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Collection {
  collectionId: string;
  name: string;
  description?: string;
  boards?: Board[];
  createdAt: string;
  updatedAt: string;
}

interface PaginatedResponse<T> {
  entities: T[];
  requestId?: string;
  pages?: number;
}

export class BoardsAPI {
  constructor(private client: FavroHttpClient) {}

  async listBoards(pageSize: number = 50): Promise<Board[]> {
    const allBoards: Board[] = [];
    let requestId: string | undefined;
    let page = 1;

    while (true) {
      const params: Record<string, any> = { limit: pageSize };
      if (requestId) {
        params.requestId = requestId;
        params.page = page;
      }

      const response = await this.client.get<PaginatedResponse<Board>>('/boards', { params });
      const boards = response.entities || [];
      allBoards.push(...boards);

      requestId = response.requestId;
      if (!requestId || !response.pages || page >= response.pages || boards.length === 0) break;
      page++;
    }

    return allBoards;
  }

  async getBoard(boardId: string): Promise<Board> {
    return this.client.get<Board>(`/boards/${boardId}`);
  }

  async createBoard(data: { name: string; description?: string; collectionId?: string }): Promise<Board> {
    return this.client.post<Board>('/boards', data);
  }

  async updateBoard(boardId: string, data: { name?: string; description?: string }): Promise<Board> {
    return this.client.patch<Board>(`/boards/${boardId}`, data);
  }

  async deleteBoard(boardId: string): Promise<void> {
    await this.client.delete(`/boards/${boardId}`);
  }

  async listCollections(pageSize: number = 50): Promise<Collection[]> {
    const allCollections: Collection[] = [];
    let requestId: string | undefined;
    let page = 1;

    while (true) {
      const params: Record<string, any> = { limit: pageSize };
      if (requestId) {
        params.requestId = requestId;
        params.page = page;
      }

      const response = await this.client.get<PaginatedResponse<Collection>>('/collections', { params });
      const collections = response.entities || [];
      allCollections.push(...collections);

      requestId = response.requestId;
      if (!requestId || !response.pages || page >= response.pages || collections.length === 0) break;
      page++;
    }

    return allCollections;
  }

  async getCollection(collectionId: string): Promise<Collection> {
    return this.client.get<Collection>(`/collections/${collectionId}`);
  }

  async createCollection(data: { name: string; description?: string }): Promise<Collection> {
    return this.client.post<Collection>('/collections', data);
  }

  async updateCollection(collectionId: string, data: { name?: string; description?: string }): Promise<Collection> {
    return this.client.patch<Collection>(`/collections/${collectionId}`, data);
  }

  async deleteCollection(collectionId: string): Promise<void> {
    await this.client.delete(`/collections/${collectionId}`);
  }

  async addBoardToCollection(collectionId: string, boardId: string): Promise<Collection> {
    return this.client.post<Collection>(`/collections/${collectionId}/boards/${boardId}`, {});
  }

  async removeBoardFromCollection(collectionId: string, boardId: string): Promise<void> {
    await this.client.delete(`/collections/${collectionId}/boards/${boardId}`);
  }
}

export default BoardsAPI;
