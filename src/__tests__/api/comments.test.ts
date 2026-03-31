/**
 * Unit tests — CommentsApiClient
 * CLA-1792 FAVRO-030: Integration Test Suite (coverage gap fix)
 */
import { CommentsApiClient } from '../../api/comments';

function makeMockClient(responses: any[]): any {
  let callIndex = 0;
  return {
    get: jest.fn().mockImplementation(() => {
      const r = responses[callIndex] || responses[responses.length - 1];
      callIndex++;
      return Promise.resolve(r);
    }),
    post: jest.fn().mockResolvedValue({
      commentId: 'c-new',
      cardId: 'card-1',
      text: 'new comment',
      createdAt: '2024-01-01T00:00:00Z',
    }),
  };
}

describe('CommentsApiClient.listComments', () => {

  it('returns empty array when no comments', async () => {
    const client = makeMockClient([{ entities: [], requestId: undefined }]);
    const api = new CommentsApiClient(client as any);
    const comments = await api.listComments('card-1');
    expect(comments).toEqual([]);
    expect(client.get).toHaveBeenCalledWith('/comments', expect.anything());
  });

  it('returns normalized comments from single page', async () => {
    const client = makeMockClient([{
      entities: [
        { commentId: 'c-1', cardId: 'card-1', text: 'Hello', createdAt: '2024-01-01T00:00:00Z' },
        { commentId: 'c-2', cardId: 'card-1', text: 'World', createdAt: '2024-01-02T00:00:00Z' },
      ],
      requestId: undefined,
    }]);
    const api = new CommentsApiClient(client as any);
    const comments = await api.listComments('card-1');
    expect(comments).toHaveLength(2);
    expect(comments[0].commentId).toBe('c-1');
    expect(comments[0].text).toBe('Hello');
    expect(comments[0].cardId).toBe('card-1');
  });

  it('normalizes alternate field names (id, comment, user)', async () => {
    const client = makeMockClient([{
      entities: [
        { id: 'c-alt', comment: 'Alt text', user: 'alice', createdAt: '2024-01-01T00:00:00Z' },
      ],
    }]);
    const api = new CommentsApiClient(client as any);
    const comments = await api.listComments('card-x');
    expect(comments[0].commentId).toBe('c-alt');
    expect(comments[0].text).toBe('Alt text');
    expect(comments[0].author).toBe('alice');
    expect(comments[0].cardId).toBe('card-x'); // falls back to passed cardId
  });

  it('paginates across multiple pages', async () => {
    const client = {
      get: jest.fn()
        // First mock is consumed by resolveCardCommonId
        .mockResolvedValueOnce({
          entities: [{ commentId: 'c-0', text: 'Zero', createdAt: '2024-01-01T00:00:00Z' }],
        })
        .mockResolvedValueOnce({
          entities: [{ commentId: 'c-1', text: 'First', createdAt: '2024-01-01T00:00:00Z' }],
          requestId: 'req-1',
          pages: 2,
        })
        .mockResolvedValueOnce({
          entities: [{ commentId: 'c-2', text: 'Second', createdAt: '2024-01-02T00:00:00Z' }],
          requestId: 'req-1',
          pages: 2,
        })
        .mockResolvedValueOnce({
          entities: [],
        }),
    };
    const api = new CommentsApiClient(client as any);
    const comments = await api.listComments('card-1');
    expect(comments.length).toBeGreaterThanOrEqual(2);
  });

  it('respects the limit parameter', async () => {
    const client = makeMockClient([{
      entities: [
        { commentId: 'c-1', text: 'A', createdAt: '2024-01-01T00:00:00Z' },
        { commentId: 'c-2', text: 'B', createdAt: '2024-01-02T00:00:00Z' },
        { commentId: 'c-3', text: 'C', createdAt: '2024-01-03T00:00:00Z' },
      ],
    }]);
    const api = new CommentsApiClient(client as any);
    const comments = await api.listComments('card-1', 2);
    expect(comments.length).toBeLessThanOrEqual(2);
  });
});

describe('CommentsApiClient.addComment', () => {

  it('adds a comment and returns normalized result', async () => {
    const mockPost = jest.fn().mockResolvedValue({
      commentId: 'c-new',
      text: 'Test comment',
      createdAt: '2024-01-01T00:00:00Z',
    });
    const client = { post: mockPost };
    const api = new CommentsApiClient(client as any);
    const result = await api.addComment('card-1', 'Test comment');
    expect(mockPost).toHaveBeenCalledWith('/comments', { cardCommonId: 'card-1', comment: 'Test comment' });
    expect(result.text).toBe('Test comment');
    expect(result.cardId).toBe('card-1');
  });

  it('trims whitespace from comment text', async () => {
    const mockPost = jest.fn().mockResolvedValue({
      commentId: 'c-new',
      text: 'Trimmed',
      createdAt: '2024-01-01T00:00:00Z',
    });
    const client = { post: mockPost };
    const api = new CommentsApiClient(client as any);
    await api.addComment('card-1', '  Trimmed  ');
    expect(mockPost).toHaveBeenCalledWith('/comments', { cardCommonId: 'card-1', comment: 'Trimmed' });
  });

  it('throws when comment text is empty', async () => {
    const client = { post: jest.fn() };
    const api = new CommentsApiClient(client as any);
    await expect(api.addComment('card-1', '')).rejects.toThrow(/empty/);
    await expect(api.addComment('card-1', '   ')).rejects.toThrow(/empty/);
  });
});
