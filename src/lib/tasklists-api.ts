import FavroHttpClient from './http-client';

export interface TaskList {
  taskListId: string;
  name: string;
  cardCommonId: string;
  position?: number;
}

interface PaginatedResponse<T> {
  entities: T[];
  requestId?: string;
  pages?: number;
}

export class TaskListsAPI {
  constructor(private client: FavroHttpClient) {}

  async listTaskLists(cardCommonId: string): Promise<TaskList[]> {
    const all: TaskList[] = [];
    let requestId: string | undefined;
    let page = 0;

    while (true) {
      const params: Record<string, any> = { cardCommonId };
      if (requestId) {
        params.requestId = requestId;
        params.page = page;
      }

      const response = await this.client.get<PaginatedResponse<TaskList>>('/tasklists', { params });

      if (response && response.entities) {
        all.push(...response.entities);
      }

      requestId = response.requestId;
      if (!requestId || !response.pages || page >= response.pages - 1 || !response.entities || response.entities.length === 0) {
        break;
      }
      page++;
    }

    return all;
  }

  async getTaskList(taskListId: string): Promise<TaskList> {
    return this.client.get<TaskList>(`/tasklists/${taskListId}`);
  }

  async createTaskList(cardCommonId: string, name: string, position?: number): Promise<TaskList> {
    const payload: Record<string, any> = { cardCommonId, name };
    if (position !== undefined) payload.position = position;
    return this.client.post<TaskList>('/tasklists', payload);
  }

  async updateTaskList(taskListId: string, data: { name?: string; position?: number }): Promise<TaskList> {
    return this.client.put<TaskList>(`/tasklists/${taskListId}`, data);
  }

  async deleteTaskList(taskListId: string): Promise<void> {
    await this.client.delete(`/tasklists/${taskListId}`);
  }
}

export default TaskListsAPI;
