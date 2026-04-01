/**
 * Unit tests — TagsAPI update/delete
 */
import TagsAPI from '../../lib/tags-api';

function makeMockClient() {
  return {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
  };
}

describe('TagsAPI.updateTag', () => {
  it('updates a tag by ID', async () => {
    const client = makeMockClient();
    client.put.mockResolvedValue({
      tagId: 'tag-1',
      name: 'Renamed',
      color: 'blue',
    });

    const api = new TagsAPI(client as any);
    const tag = await api.updateTag('tag-1', { name: 'Renamed', color: 'blue' });

    expect(client.put).toHaveBeenCalledWith('/tags/tag-1', { name: 'Renamed', color: 'blue' });
    expect(tag.tagId).toBe('tag-1');
    expect(tag.name).toBe('Renamed');
    expect(tag.color).toBe('blue');
  });

  it('can update only name', async () => {
    const client = makeMockClient();
    client.put.mockResolvedValue({ tagId: 'tag-1', name: 'New Name' });

    const api = new TagsAPI(client as any);
    await api.updateTag('tag-1', { name: 'New Name' });

    expect(client.put).toHaveBeenCalledWith('/tags/tag-1', { name: 'New Name' });
  });

  it('can update only color', async () => {
    const client = makeMockClient();
    client.put.mockResolvedValue({ tagId: 'tag-1', name: 'Bug', color: 'red' });

    const api = new TagsAPI(client as any);
    await api.updateTag('tag-1', { color: 'red' });

    expect(client.put).toHaveBeenCalledWith('/tags/tag-1', { color: 'red' });
  });
});

describe('TagsAPI.deleteTag', () => {
  it('deletes a tag by ID', async () => {
    const client = makeMockClient();
    client.delete.mockResolvedValue(undefined);

    const api = new TagsAPI(client as any);
    await api.deleteTag('tag-1');

    expect(client.delete).toHaveBeenCalledWith('/tags/tag-1');
  });
});
