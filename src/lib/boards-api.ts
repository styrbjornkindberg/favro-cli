import FavroHttpClient from './http-client';

export interface Board {
  boardId: string;
  name: string;
  description?: string;
  collectionId?: string;
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

export class BoardsAPI {
  constructor(private client: FavroHttpClient) {}

  async listBoards(limit: number = 50): Promise<Board[]> {
    const response = await this.client.get<{ entities: Board[] }>('/boards', { params: { limit } });
    return response.entities || [];
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

  async listCollections(limit: number = 50): Promise<Collection[]> {
    const response = await this.client.get<{ entities: Collection[] }>('/collections', { params: { limit } });
    return response.entities || [];
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
