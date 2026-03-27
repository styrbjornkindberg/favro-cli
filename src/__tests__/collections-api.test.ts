/**
 * Tests for CollectionsAPI
 * CLA-1783 FAVRO-021: Implement Collections Endpoints
 */
import CollectionsAPI, { Collection } from '../lib/collections-api';
import FavroHttpClient from '../lib/http-client';

describe('CollectionsAPI', () => {
  let api: CollectionsAPI;
  let mockClient: jest.Mocked<Pick<FavroHttpClient, 'get' | 'post' | 'patch' | 'delete'>>;

  const sampleCollection: Collection = {
    collectionId: 'coll-1',
    name: 'My Collection',
    description: 'A test collection',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-02-01T00:00:00Z',
  };

  beforeEach(() => {
    mockClient = {
      get: jest.fn(),
      post: jest.fn(),
      patch: jest.fn(),
      delete: jest.fn(),
    };
    api = new CollectionsAPI(mockClient as any);
  });

  // --- listCollections ---

  test('listCollections returns array of collections', async () => {
    mockClient.get.mockResolvedValue({ entities: [sampleCollection] });
    const result = await api.listCollections();
    expect(result).toHaveLength(1);
    expect(result[0].collectionId).toBe('coll-1');
    expect(result[0].name).toBe('My Collection');
  });

  test('listCollections returns empty array when no collections', async () => {
    mockClient.get.mockResolvedValue({ entities: [] });
    const result = await api.listCollections();
    expect(result).toEqual([]);
  });

  test('listCollections returns empty array when entities missing', async () => {
    mockClient.get.mockResolvedValue({});
    const result = await api.listCollections();
    expect(result).toEqual([]);
  });

  test('listCollections returns empty array when response is null', async () => {
    mockClient.get.mockResolvedValue(null);
    const result = await api.listCollections();
    expect(result).toEqual([]);
  });

  test('listCollections uses default page size 50', async () => {
    mockClient.get.mockResolvedValue({ entities: [] });
    await api.listCollections();
    expect(mockClient.get).toHaveBeenCalledWith('/collections', { params: { limit: 50 } });
  });

  test('listCollections uses custom page size', async () => {
    mockClient.get.mockResolvedValue({ entities: [] });
    await api.listCollections(100);
    expect(mockClient.get).toHaveBeenCalledWith('/collections', { params: { limit: 100 } });
  });

  test('listCollections handles pagination', async () => {
    const coll1 = { ...sampleCollection, collectionId: 'c1' };
    const coll2 = { ...sampleCollection, collectionId: 'c2' };
    mockClient.get
      .mockResolvedValueOnce({ entities: [coll1], requestId: 'req-1', pages: 2 })
      .mockResolvedValueOnce({ entities: [coll2], requestId: 'req-1', pages: 2 });
    const result = await api.listCollections();
    expect(result).toHaveLength(2);
    expect(result[0].collectionId).toBe('c1');
    expect(result[1].collectionId).toBe('c2');
  });

  // --- getCollection ---

  test('getCollection returns collection by id', async () => {
    mockClient.get.mockResolvedValue(sampleCollection);
    const result = await api.getCollection('coll-1');
    expect(result.collectionId).toBe('coll-1');
    expect(mockClient.get).toHaveBeenCalledWith('/collections/coll-1', { params: {} });
  });

  test('getCollection passes include param', async () => {
    mockClient.get.mockResolvedValue(sampleCollection);
    await api.getCollection('coll-1', ['boards', 'stats']);
    expect(mockClient.get).toHaveBeenCalledWith('/collections/coll-1', {
      params: { include: 'boards,stats' },
    });
  });

  test('getCollection without include passes empty params', async () => {
    mockClient.get.mockResolvedValue(sampleCollection);
    await api.getCollection('coll-1');
    expect(mockClient.get).toHaveBeenCalledWith('/collections/coll-1', { params: {} });
  });

  test('getCollection propagates error for non-existent collection', async () => {
    const err = Object.assign(new Error('Not Found'), { response: { status: 404 } });
    mockClient.get.mockRejectedValue(err);
    await expect(api.getCollection('bad-id')).rejects.toThrow('Not Found');
  });

  // --- createCollection ---

  test('createCollection sends correct request', async () => {
    const newColl = { ...sampleCollection, collectionId: 'new-coll' };
    mockClient.post.mockResolvedValue(newColl);
    const result = await api.createCollection({ name: 'My Collection', description: 'A test collection' });
    expect(result.collectionId).toBe('new-coll');
    expect(mockClient.post).toHaveBeenCalledWith('/collections', {
      name: 'My Collection',
      description: 'A test collection',
    });
  });

  test('createCollection without description', async () => {
    mockClient.post.mockResolvedValue(sampleCollection);
    await api.createCollection({ name: 'No Desc' });
    expect(mockClient.post).toHaveBeenCalledWith('/collections', { name: 'No Desc' });
  });

  // --- updateCollection ---

  test('updateCollection sends correct request', async () => {
    const updated = { ...sampleCollection, name: 'Updated Name' };
    mockClient.patch.mockResolvedValue(updated);
    const result = await api.updateCollection('coll-1', { name: 'Updated Name' });
    expect(result.name).toBe('Updated Name');
    expect(mockClient.patch).toHaveBeenCalledWith('/collections/coll-1', { name: 'Updated Name' });
  });

  test('updateCollection with description', async () => {
    const updated = { ...sampleCollection, description: 'New desc' };
    mockClient.patch.mockResolvedValue(updated);
    const result = await api.updateCollection('coll-1', { description: 'New desc' });
    expect(result.description).toBe('New desc');
  });

  test('updateCollection propagates 404', async () => {
    const err = Object.assign(new Error('Not Found'), { response: { status: 404 } });
    mockClient.patch.mockRejectedValue(err);
    await expect(api.updateCollection('bad-id', { name: 'x' })).rejects.toThrow('Not Found');
  });
});
