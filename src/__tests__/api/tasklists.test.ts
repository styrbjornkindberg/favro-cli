/**
 * Unit tests — TaskListsAPI full CRUD
 */
import TaskListsAPI from '../../lib/tasklists-api';

function makeMockClient() {
  return {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
  };
}

describe('TaskListsAPI.listTaskLists', () => {
  it('lists task lists for a card', async () => {
    const client = makeMockClient();
    client.get.mockResolvedValue({
      entities: [
        { taskListId: 'tl-1', name: 'Checklist', cardCommonId: 'card-1', position: 0 },
        { taskListId: 'tl-2', name: 'QA Steps', cardCommonId: 'card-1', position: 1 },
      ],
    });

    const api = new TaskListsAPI(client as any);
    const lists = await api.listTaskLists('card-1');

    expect(client.get).toHaveBeenCalledWith('/tasklists', { params: { cardCommonId: 'card-1' } });
    expect(lists).toHaveLength(2);
    expect(lists[0].name).toBe('Checklist');
  });

  it('returns empty array when no task lists', async () => {
    const client = makeMockClient();
    client.get.mockResolvedValue({ entities: [] });

    const api = new TaskListsAPI(client as any);
    const lists = await api.listTaskLists('card-1');

    expect(lists).toEqual([]);
  });
});

describe('TaskListsAPI.getTaskList', () => {
  it('gets a task list by ID', async () => {
    const client = makeMockClient();
    client.get.mockResolvedValue({
      taskListId: 'tl-1',
      name: 'Checklist',
      cardCommonId: 'card-1',
    });

    const api = new TaskListsAPI(client as any);
    const list = await api.getTaskList('tl-1');

    expect(client.get).toHaveBeenCalledWith('/tasklists/tl-1');
    expect(list.taskListId).toBe('tl-1');
    expect(list.name).toBe('Checklist');
  });
});

describe('TaskListsAPI.createTaskList', () => {
  it('creates a task list on a card', async () => {
    const client = makeMockClient();
    client.post.mockResolvedValue({
      taskListId: 'tl-new',
      name: 'New Checklist',
      cardCommonId: 'card-1',
    });

    const api = new TaskListsAPI(client as any);
    const list = await api.createTaskList('card-1', 'New Checklist');

    expect(client.post).toHaveBeenCalledWith('/tasklists', { cardCommonId: 'card-1', name: 'New Checklist' });
    expect(list.taskListId).toBe('tl-new');
  });

  it('includes position when provided', async () => {
    const client = makeMockClient();
    client.post.mockResolvedValue({
      taskListId: 'tl-new',
      name: 'At Position',
      cardCommonId: 'card-1',
      position: 2,
    });

    const api = new TaskListsAPI(client as any);
    await api.createTaskList('card-1', 'At Position', 2);

    expect(client.post).toHaveBeenCalledWith('/tasklists', {
      cardCommonId: 'card-1',
      name: 'At Position',
      position: 2,
    });
  });
});

describe('TaskListsAPI.updateTaskList', () => {
  it('updates a task list', async () => {
    const client = makeMockClient();
    client.put.mockResolvedValue({
      taskListId: 'tl-1',
      name: 'Renamed',
      cardCommonId: 'card-1',
    });

    const api = new TaskListsAPI(client as any);
    const list = await api.updateTaskList('tl-1', { name: 'Renamed' });

    expect(client.put).toHaveBeenCalledWith('/tasklists/tl-1', { name: 'Renamed' });
    expect(list.name).toBe('Renamed');
  });
});

describe('TaskListsAPI.deleteTaskList', () => {
  it('deletes a task list by ID', async () => {
    const client = makeMockClient();
    client.delete.mockResolvedValue(undefined);

    const api = new TaskListsAPI(client as any);
    await api.deleteTaskList('tl-1');

    expect(client.delete).toHaveBeenCalledWith('/tasklists/tl-1');
  });
});
