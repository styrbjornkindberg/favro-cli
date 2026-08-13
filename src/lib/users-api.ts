import FavroHttpClient from './http-client';
import { getAllPages } from './paginate';
import { cachedList } from './name-cache';
import { foldName } from './fold-name';
import { MISSING_WORDING } from './favro-error';
import { RefusalError } from './refusal';
import { isUserId } from './id-shapes';

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
    // `foldName`, not `toLowerCase`: a display name reaches the wire and a
    // shell in different normalisation forms, and so does the local part of an
    // address (#141). A `userId` is compared raw — it is an opaque id, and
    // folding one would be inventing a match.
    const wanted = foldName(value);

    const matches =
      kind === 'userId'
        ? users.filter((u) => u.userId === value)
        : kind === 'email'
          ? users.filter((u) => foldName(u.email) === wanted)
          : users.filter((u) => foldName(u.name) === wanted);

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
    return getAllPages<User>(this.client, '/users');
  }

  /**
   * List all user groups.
   */
  async listGroups(): Promise<UserGroup[]> {
    return getAllPages<UserGroup>(this.client, '/usergroups');
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

/**
 * Org users, cached.
 *
 * Lives here rather than in `name-cache` because the leaf cache must not import
 * its own consumers — that was one of the two import cycles #122 kills. The
 * cache takes a `fetch` callback; the caller owns the API class.
 */
export function cachedUsers(client: FavroHttpClient, organizationId?: string): Promise<User[]> {
  const api = new UsersAPI(client);
  return cachedList<User>(organizationId, 'users', () => api.listUsers());
}

export default UsersAPI;
