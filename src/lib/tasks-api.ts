import FavroHttpClient from './http-client';

export interface Task {
  taskId: string;
  name: string;
  completed?: boolean;
  position?: number;
  cardCommonId: string;
}

export interface PaginatedResponse<T> {
  entities: T[];
  requestId?: string;
  pages?: number;
}

export class TasksAPI {
  constructor(private client: FavroHttpClient) {}

  /**
   * List all checklist tasks on a specific card.
   */
  async listTasks(cardCommonId: string): Promise<Task[]> {
    const allTasks: Task[] = [];
    let requestId: string | undefined;
    let page = 0;

    while (true) {
      const params: Record<string, any> = { cardCommonId };
      if (requestId) {
        params.requestId = requestId;
        params.page = page;
      }

      const response = await this.client.get<PaginatedResponse<Task>>('/tasks', { params });
      
      if (response && response.entities) {
        allTasks.push(...response.entities);
      }

      requestId = response.requestId;
      if (!requestId || !response.pages || page >= response.pages - 1 || !response.entities || response.entities.length === 0) {
        break;
      }
      page++;
    }

    return allTasks.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  }

  /**
   * Create a new task (checklist item) on a card.
   */
  async createTask(cardCommonId: string, name: string): Promise<Task> {
    const payload = { cardCommonId, name };
    return this.client.post<Task>('/tasks', payload);
  }

  /**
   * Toggle completion status of a task.
   */
  async updateTask(taskId: string, completed: boolean): Promise<Task> {
    const payload = { completed };
    return this.client.put<Task>(`/tasks/${taskId}`, payload);
  }
}

export default TasksAPI;
