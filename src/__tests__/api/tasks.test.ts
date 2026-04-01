/**
 * Unit tests — TasksAPI update/delete
 */
import TasksAPI from '../../lib/tasks-api';

function makeMockClient() {
  return {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
  };
}

describe('TasksAPI.updateTask', () => {
  it('updates with a boolean (backward compat)', async () => {
    const client = makeMockClient();
    client.put.mockResolvedValue({
      taskId: 'task-1',
      name: 'My Task',
      completed: true,
      cardCommonId: 'card-1',
    });

    const api = new TasksAPI(client as any);
    const task = await api.updateTask('task-1', true);

    expect(client.put).toHaveBeenCalledWith('/tasks/task-1', { completed: true });
    expect(task.completed).toBe(true);
  });

  it('updates with a data object (name + completed)', async () => {
    const client = makeMockClient();
    client.put.mockResolvedValue({
      taskId: 'task-1',
      name: 'Renamed',
      completed: false,
      cardCommonId: 'card-1',
    });

    const api = new TasksAPI(client as any);
    const task = await api.updateTask('task-1', { name: 'Renamed', completed: false });

    expect(client.put).toHaveBeenCalledWith('/tasks/task-1', { name: 'Renamed', completed: false });
    expect(task.name).toBe('Renamed');
  });

  it('updates with position only', async () => {
    const client = makeMockClient();
    client.put.mockResolvedValue({
      taskId: 'task-1',
      name: 'My Task',
      position: 2,
      cardCommonId: 'card-1',
    });

    const api = new TasksAPI(client as any);
    await api.updateTask('task-1', { position: 2 });

    expect(client.put).toHaveBeenCalledWith('/tasks/task-1', { position: 2 });
  });
});

describe('TasksAPI.deleteTask', () => {
  it('deletes a task by ID', async () => {
    const client = makeMockClient();
    client.delete.mockResolvedValue(undefined);

    const api = new TasksAPI(client as any);
    await api.deleteTask('task-1');

    expect(client.delete).toHaveBeenCalledWith('/tasks/task-1');
  });
});
