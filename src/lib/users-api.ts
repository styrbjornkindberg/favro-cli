import FavroHttpClient from './http-client';

export interface User {
  userId: string;
  name: string;
  email: string;
  organizationRole?: string;
}

export interface UserGroup {
  userGroupId: string;
  name: string;
  userIds?: string[];
}

export interface PaginatedResponse<T> {
  entities: T[];
  requestId?: string;
  pages?: number;
}

export class UsersAPI {
  constructor(private client: FavroHttpClient) {}

  /**
   * List all users in the organization.
   */
  async listUsers(): Promise<User[]> {
    const allUsers: User[] = [];
    let requestId: string | undefined;
    let page = 0;

    while (true) {
      const params: Record<string, any> = {};
      if (requestId) {
        params.requestId = requestId;
        params.page = page;
      }

      const response = await this.client.get<PaginatedResponse<User>>('/users', { params });
      
      if (response && response.entities) {
        allUsers.push(...response.entities);
      }

      requestId = response.requestId;
      if (!requestId || !response.pages || page >= response.pages - 1 || !response.entities || response.entities.length === 0) {
        break;
      }
      page++;
    }

    return allUsers;
  }

  /**
   * List all user groups.
   */
  async listGroups(): Promise<UserGroup[]> {
    const allGroups: UserGroup[] = [];
    let requestId: string | undefined;
    let page = 0;

    while (true) {
      const params: Record<string, any> = {};
      if (requestId) {
        params.requestId = requestId;
        params.page = page;
      }

      const response = await this.client.get<PaginatedResponse<UserGroup>>('/usergroups', { params });
      
      if (response && response.entities) {
        allGroups.push(...response.entities);
      }

      requestId = response.requestId;
      if (!requestId || !response.pages || page >= response.pages - 1 || !response.entities || response.entities.length === 0) {
        break;
      }
      page++;
    }

    return allGroups;
  }
}

export default UsersAPI;
