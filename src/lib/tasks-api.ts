import FavroHttpClient from './http-client';
import { getAllPages } from './paginate';
import CardReferenceResolver from './card-reference';

export interface Task {
  taskId: string;
  name: string;
  completed?: boolean;
  position?: number;
  cardCommonId: string;
}

export class TasksAPI {
  constructor(private client: FavroHttpClient) {}

  /**
   * List all checklist tasks on a specific card.
   */
  async listTasks(cardRef: string): Promise<Task[]> {
    // Accepts CLA-1804, a cardId or a cardCommonId (#40).
    const cardCommonId = await new CardReferenceResolver(this.client).toCardCommonId(cardRef);
    const allTasks = await getAllPages<Task>(this.client, '/tasks', { cardCommonId });

    return allTasks.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  }

  /**
   * Create a new task (checklist item) on a card.
   */
  async createTask(cardRef: string, name: string, taskListId: string): Promise<Task> {
    // Accepts CLA-1804, a cardId or a cardCommonId (#40).
    const cardCommonId = await new CardReferenceResolver(this.client).toCardCommonId(cardRef);
    const payload = { cardCommonId, name, taskListId };
    return this.client.post<Task>('/tasks', payload);
  }

  /**
   * Toggle completion status of a task.
   */
  async updateTask(taskId: string, data: { name?: string; completed?: boolean; position?: number } | boolean): Promise<Task> {
    const payload = typeof data === 'boolean' ? { completed: data } : data;
    return this.client.put<Task>(`/tasks/${taskId}`, payload);
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.client.delete(`/tasks/${taskId}`);
  }
}

export default TasksAPI;
