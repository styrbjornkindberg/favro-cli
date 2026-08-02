import FavroHttpClient from './http-client';
import { getAllPages } from './paginate';
import CardReferenceResolver from './card-reference';

export interface TaskList {
  taskListId: string;
  name: string;
  cardCommonId: string;
  position?: number;
}

export class TaskListsAPI {
  constructor(private client: FavroHttpClient) {}

  async listTaskLists(cardRef: string): Promise<TaskList[]> {
    // Accepts CLA-1804, a cardId or a cardCommonId (#40).
    const cardCommonId = await new CardReferenceResolver(this.client).toCardCommonId(cardRef);
    return getAllPages<TaskList>(this.client, '/tasklists', { cardCommonId });
  }

  async getTaskList(taskListId: string): Promise<TaskList> {
    return this.client.get<TaskList>(`/tasklists/${taskListId}`);
  }

  async createTaskList(cardRef: string, name: string, position?: number): Promise<TaskList> {
    // Accepts CLA-1804, a cardId or a cardCommonId (#40).
    const cardCommonId = await new CardReferenceResolver(this.client).toCardCommonId(cardRef);
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
