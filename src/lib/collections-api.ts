/**
 * Collections API
 * CLA-1783 FAVRO-021: Implement Collections Endpoints
 *
 * Provides list, get, create, and update operations for Favro collections.
 */
import FavroHttpClient from './http-client';
import { getAllPages } from './paginate';
import { Board } from './boards-api';
import { classifyThrownError } from './favro-error';
import { looksLikeName, resolveNameToId } from './name-resolve';

/**
 * The wider of the two `Collection` interfaces, and the one to keep — see the
 * twin at `boards-api.ts` for why both still exist and who collapses them
 * (#123).
 */
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

export class CollectionsAPI {
  constructor(private client: FavroHttpClient) {}

  /**
   * List all collections with full pagination.
   */
  async listCollections(pageSize = 50): Promise<Collection[]> {
    return getAllPages<Collection>(this.client, '/collections', { limit: pageSize });
  }

  /**
   * Resolve a collection name to its `collectionId`. An exact id passes
   * straight through. Refuses an unknown or a duplicated name — never picks one.
   */
  async resolveCollectionId(collection: string, useIdWith = 'favro collections get <collectionId>'): Promise<string> {
    return resolveNameToId({
      organizationId: this.client.organizationId,
      kind: 'collections',
      fetch: async () => (await this.listCollections(100)).map(c => ({ id: c.collectionId, name: c.name })),
      value: collection,
      label: 'collection',
      listCommand: 'favro collections list',
      useIdWith,
    });
  }

  /**
   * Get a single collection by id or by exact name.
   * Optionally include boards or stats.
   *
   * A one-word collection name is not distinguishable from an id by shape, so
   * the direct read goes first and only a classified not-found (Favro answers
   * 403 "Page not found" here) escalates to the name lookup.
   */
  async getCollection(collection: string, include?: string[]): Promise<Collection> {
    const params: Record<string, any> = {};
    if (include && include.length > 0) {
      params.include = include.join(',');
    }
    const read = (id: string) => this.client.get<Collection>(`/collections/${id}`, { params });

    if (looksLikeName(collection)) return read(await this.resolveCollectionId(collection));
    try {
      return await read(collection);
    } catch (error) {
      if (!classifyThrownError(error)?.escalatableOnRead) throw error;
      return read(await this.resolveCollectionId(collection));
    }
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
