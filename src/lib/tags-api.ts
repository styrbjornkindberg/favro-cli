import FavroHttpClient from './http-client';

export interface Tag {
  tagId: string;
  name: string;
  color?: string;
  organizationId?: string;
}

export interface PaginatedResponse<T> {
  entities: T[];
  requestId?: string;
  pages?: number;
}

export class TagsAPI {
  constructor(private client: FavroHttpClient) {}

  /**
   * List all global workspace tags.
   */
  async listTags(): Promise<Tag[]> {
    const allTags: Tag[] = [];
    let requestId: string | undefined;
    let page = 0;

    while (true) {
      const params: Record<string, any> = {};
      if (requestId) {
        params.requestId = requestId;
        params.page = page;
      }

      const response = await this.client.get<PaginatedResponse<Tag>>('/tags', { params });
      
      if (response && response.entities) {
        allTags.push(...response.entities);
      }

      requestId = response.requestId;
      if (!requestId || !response.pages || page >= response.pages - 1 || !response.entities || response.entities.length === 0) {
        break;
      }
      page++;
    }

    return allTags;
  }

  /**
   * Create a new workspace tag.
   */
  async createTag(name: string, color?: string): Promise<Tag> {
    const payload: any = { name };
    if (color) {
      payload.color = color;
    }
    return this.client.post<Tag>('/tags', payload);
  }
}

export default TagsAPI;
