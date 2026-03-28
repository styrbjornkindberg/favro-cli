/**
 * Members API — Favro CLI
 * CLA-1788 FAVRO-026: Members & Permissions API
 *
 * Endpoints:
 *   GET    /members               — list org members (optional boardId or collectionId filter)
 *   POST   /members               — add a member by email
 *   DELETE /members/{memberId}    — remove a member
 *   GET    /members/{memberId}    — get member details (including permission level)
 */
import FavroHttpClient from './http-client';

export type PermissionLevel = 'viewer' | 'editor' | 'admin';

export interface Member {
  memberId: string;
  userId?: string;
  email: string;
  name?: string;
  role?: PermissionLevel;
  permissionLevel?: PermissionLevel;
  boardId?: string;
  collectionId?: string;
  createdAt?: string;
}

export interface AddMemberRequest {
  email: string;
  /** board ID or collection ID to add member to */
  targetId: string;
  role?: PermissionLevel;
}

export interface MemberPermissions {
  memberId: string;
  email?: string;
  name?: string;
  boardId?: string;
  role: PermissionLevel;
  permissionLevel?: PermissionLevel;
}

interface PaginatedResponse<T> {
  entities: T[];
  requestId?: string;
  pages?: number;
}

/**
 * Validate email format.
 * Returns true if valid, false otherwise.
 */
export function isValidEmail(email: string): boolean {
  // RFC 5322 simplified regex
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email.trim());
}

export class MembersAPI {
  constructor(private client: FavroHttpClient) {}

  /**
   * List members with optional board or collection filter.
   * Uses requestId/pages pagination to return all results.
   */
  async listMembers(options: { boardId?: string; collectionId?: string; pageSize?: number } = {}): Promise<Member[]> {
    const allMembers: Member[] = [];
    let requestId: string | undefined;
    let page = 1;
    const limit = (options.pageSize != null && !isNaN(options.pageSize) && options.pageSize >= 1)
      ? options.pageSize
      : 50;

    while (true) {
      const params: Record<string, any> = { limit };
      if (options.boardId) params.boardId = options.boardId;
      if (options.collectionId) params.collectionId = options.collectionId;
      if (requestId) {
        params.requestId = requestId;
        params.page = page;
      }

      const response = await this.client.get<PaginatedResponse<Member>>('/members', { params });
      const members = response.entities ?? [];
      allMembers.push(...members);

      requestId = response.requestId;
      if (!requestId || !response.pages || page >= response.pages || members.length === 0) break;
      page++;
    }

    return allMembers;
  }

  /**
   * Add a member to a board or collection by email.
   * Throws if email is invalid.
   */
  async addMember(request: AddMemberRequest): Promise<Member> {
    if (!isValidEmail(request.email)) {
      throw new Error(`Invalid email format: "${request.email}"`);
    }

    const payload: Record<string, any> = {
      email: request.email.trim(),
      targetId: request.targetId,
    };
    if (request.role) payload.role = request.role;

    return this.client.post<Member>('/members', payload);
  }

  /**
   * Remove a member from a board or collection.
   * fromId is the board or collection ID.
   */
  async removeMember(memberId: string, fromId: string): Promise<void> {
    await this.client.delete(`/members/${memberId}`, { params: { fromId } });
  }

  /**
   * Get permission level for a member on a specific board.
   * Throws if member is not found.
   */
  async getMemberPermissions(memberId: string, boardId: string): Promise<MemberPermissions> {
    const result = await this.client.get<MemberPermissions>(`/members/${memberId}`, {
      params: { boardId },
    });
    return result;
  }
}

export default MembersAPI;
