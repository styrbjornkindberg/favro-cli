/**
 * Collections API
 * CLA-1783 FAVRO-021: Implement Collections Endpoints
 *
 * Provides list, get, create, and update operations for Favro collections.
 */
import FavroHttpClient from './http-client';
import { Board } from './boards-api';

export interface Collection {
  collectionId: string;
  name: string;
  description?: string;
  boards?: Board[];
  boardCount?: number;
  memberCount?: number;
  createdAt: string;
  updatedAt: string;
}

interface PaginatedResponse<T> {
  entities: T[];
  requestId?: string;
  pages?: number;
}

export class CollectionsAPI {
  constructor(private client: FavroHttpClient) {}

  /**
   * List all collections with full pagination.
   */
  async listCollections(pageSize = 50): Promise<Collection[]> {
    const all: Collection[] = [];
    let requestId: string | undefined;
    let page = 1;

    while (true) {
      const params: Record<string, any> = { limit: pageSize };
      if (requestId) {
        params.requestId = requestId;
        params.page = page;
      }

      const response = await this.client.get<PaginatedResponse<Collection>>('/collections', { params });
      const collections = (response?.entities) ?? [];
      all.push(...collections);

      requestId = response?.requestId;
      if (!requestId || !response?.pages || page >= response.pages || collections.length === 0) break;
      page++;
    }

    return all;
  }

  /**
   * Get a single collection by ID.
   * Optionally include boards or stats.
   */
  async getCollection(collectionId: string, include?: string[]): Promise<Collection> {
    const params: Record<string, any> = {};
    if (include && include.length > 0) {
      params.include = include.join(',');
    }
    return this.client.get<Collection>(`/collections/${collectionId}`, { params });
  }

  /**
   * Create a new collection.
   */
  async createCollection(data: { name: string; description?: string }): Promise<Collection> {
    return this.client.post<Collection>('/collections', data);
  }

  /**
   * Update an existing collection.
   */
  async updateCollection(collectionId: string, data: { name?: string; description?: string }): Promise<Collection> {
    return this.client.patch<Collection>(`/collections/${collectionId}`, data);
  }

  async deleteCollection(collectionId: string): Promise<void> {
    await this.client.delete(`/collections/${collectionId}`);
  }
}

export default CollectionsAPI;
