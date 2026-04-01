/**
 * Unit tests — CommentsApiClient.getComment / updateComment
 */
import { CommentsApiClient } from '../../api/comments';

function makeMockClient() {
  return {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
  };
}

describe('CommentsApiClient.getComment', () => {
  it('fetches a single comment by ID', async () => {
    const client = makeMockClient();
    client.get.mockResolvedValue({
      commentId: 'c-1',
      cardCommonId: 'card-abc',
      comment: 'Hello world',
      userId: 'alice',
      created: '2026-01-01T00:00:00Z',
    });

    const api = new CommentsApiClient(client as any);
    const comment = await api.getComment('c-1');

    expect(client.get).toHaveBeenCalledWith('/comments/c-1');
    expect(comment.commentId).toBe('c-1');
    expect(comment.text).toBe('Hello world');
    expect(comment.author).toBe('alice');
    expect(comment.cardId).toBe('card-abc');
  });

  it('normalizes alternate field names', async () => {
    const client = makeMockClient();
    client.get.mockResolvedValue({
      id: 'c-alt',
      text: 'Alt text',
      user: 'bob',
      createdAt: '2026-01-01T00:00:00Z',
    });

    const api = new CommentsApiClient(client as any);
    const comment = await api.getComment('c-alt');

    expect(comment.commentId).toBe('c-alt');
    expect(comment.text).toBe('Alt text');
    expect(comment.author).toBe('bob');
  });
});

describe('CommentsApiClient.updateComment', () => {
  it('updates a comment and returns normalized result', async () => {
    const client = makeMockClient();
    client.put.mockResolvedValue({
      commentId: 'c-1',
      cardCommonId: 'card-abc',
      comment: 'Updated text',
      created: '2026-01-01T00:00:00Z',
    });

    const api = new CommentsApiClient(client as any);
    const result = await api.updateComment('c-1', 'Updated text');

    expect(client.put).toHaveBeenCalledWith('/comments/c-1', { comment: 'Updated text' });
    expect(result.commentId).toBe('c-1');
    expect(result.text).toBe('Updated text');
  });

  it('trims whitespace from comment text', async () => {
    const client = makeMockClient();
    client.put.mockResolvedValue({
      commentId: 'c-1',
      comment: 'Trimmed',
      created: '2026-01-01T00:00:00Z',
    });

    const api = new CommentsApiClient(client as any);
    await api.updateComment('c-1', '  Trimmed  ');

    expect(client.put).toHaveBeenCalledWith('/comments/c-1', { comment: 'Trimmed' });
  });

  it('throws when comment text is empty', async () => {
    const client = makeMockClient();
    const api = new CommentsApiClient(client as any);

    await expect(api.updateComment('c-1', '')).rejects.toThrow(/empty/);
    await expect(api.updateComment('c-1', '   ')).rejects.toThrow(/empty/);
  });
});

describe('CommentsApiClient.deleteComment', () => {
  it('deletes a comment by ID', async () => {
    const client = makeMockClient();
    client.delete.mockResolvedValue(undefined);

    const api = new CommentsApiClient(client as any);
    await api.deleteComment('c-1');

    expect(client.delete).toHaveBeenCalledWith('/comments/c-1');
  });
});
