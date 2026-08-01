import FavroHttpClient from './http-client';
import { cachedUsers } from './name-cache';
import { MISSING_WORDING } from './favro-error';
import { RefusalError } from './refusal';

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

/** `userId` is NEVER hex-24 — 135/135 measured are base62-17. */
const BASE62_17 = /^[0-9A-Za-z]{17}$/;

/** True when the string has the shape of a `userId`. */
export function isUserId(value: string): boolean {
  return BASE62_17.test(value.trim());
}

export type UserKey = 'email' | 'userId' | 'name';

/**
 * Which of the three keys a `users get` / `--assignee` value is.
 *
 * Shape only, no escalate-on-404: every one of 135 measured user names contains
 * a space, so a base62-17 token is never a name.
 */
export function detectUserKey(value: string): UserKey {
  const v = value.trim();
  if (v.includes('@')) return 'email';
  if (isUserId(v)) return 'userId';
  return 'name';
}

export type UserLookupFailure = 'unknown' | 'ambiguous';

/**
 * Structured refusal from `getUser`. `candidates` is populated on 'ambiguous'.
 *
 * A `RefusalError`: an unknown or colliding user resolves the same way next
 * time, so the retry advice must say so (#81).
 */
export class UserLookupError extends RefusalError {
  constructor(
    message: string,
    readonly kind: UserLookupFailure,
    readonly value: string,
    readonly key: UserKey,
    readonly candidates: User[] = []
  ) {
    super(message);
    this.name = 'UserLookupError';
  }
}

export class UsersAPI {
  constructor(private client: FavroHttpClient) {}

  /**
   * Resolve one user by name, email or `userId` — three keys, detected by shape.
   *
   * An unknown `userId` is shape-valid and would otherwise make no call at all,
   * so it refuses here rather than silently answering about nobody. Validating
   * it costs nothing: the name path already holds the list.
   *
   * ponytail: all three keys read the same cached org list. Per-key endpoints
   * would add calls and a second not-found path for no gain.
   */
  async getUser(key: string): Promise<User> {
    const value = key.trim();
    const users = await cachedUsers(this.client, this.client.organizationId);
    const kind = detectUserKey(value);
    const lower = value.toLowerCase();

    const matches =
      kind === 'userId'
        ? users.filter((u) => u.userId === value)
        : kind === 'email'
          ? users.filter((u) => (u.email ?? '').trim().toLowerCase() === lower)
          : users.filter((u) => (u.name ?? '').trim().toLowerCase() === lower);

    if (matches.length === 0) {
      throw new UserLookupError(
        `No user matches ${kind} "${value}" — it is ${MISSING_WORDING}. Run 'favro users list' to see the organization's users.`,
        'unknown',
        value,
        kind
      );
    }

    if (matches.length > 1) {
      const listed = matches.map((u) => `  ${u.userId}  ${u.name}  <${u.email}>`).join('\n');
      throw new UserLookupError(
        `${kind === 'name' ? 'Name' : 'Value'} "${value}" matches ${matches.length} users — refusing to pick one:\n${listed}\n` +
          `Pass the userId (or the email) instead.`,
        'ambiguous',
        value,
        kind,
        matches
      );
    }

    return matches[0];
  }

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

  async getGroup(groupId: string): Promise<UserGroup> {
    return this.client.get<UserGroup>(`/usergroups/${groupId}`);
  }

  async createGroup(name: string, userIds?: string[]): Promise<UserGroup> {
    const payload: Record<string, any> = { name };
    if (userIds && userIds.length > 0) payload.members = userIds;
    return this.client.post<UserGroup>('/usergroups', payload);
  }

  async updateGroup(groupId: string, data: { name?: string; addMembers?: string[]; removeMembers?: string[] }): Promise<UserGroup> {
    return this.client.put<UserGroup>(`/usergroups/${groupId}`, data);
  }

  async deleteGroup(groupId: string): Promise<void> {
    await this.client.delete(`/usergroups/${groupId}`);
  }
}

export default UsersAPI;
