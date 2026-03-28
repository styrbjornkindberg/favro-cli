/**
 * Members API — FavroApiClient methods
 * CLA-1788 FAVRO-026: Members & Permissions API
 */
import FavroHttpClient from '../lib/http-client';
import { Member, PermissionLevel } from '../types/members';

export { Member, PermissionLevel };

/**
 * Validate email format (RFC 5322 simplified).
 */
export function isValidEmail(email: string): boolean {
  if (!email || !email.trim()) return false;
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email.trim());
}

interface PaginatedResponse<T> {
  entities: T[];
  requestId?: string;
  pages?: number;
}

interface RawMember {
  memberId?: string;
  id?: string;
  userId?: string;
  email: string;
  name?: string;
  role?: string;
  organizationRole?: string;
  permissionLevel?: PermissionLevel;
}

function normalizeMember(raw: RawMember): Member {
  return {
    id: raw.userId ?? raw.memberId ?? raw.id ?? '',
    name: raw.name ?? '',
    email: raw.email,
    role: raw.organizationRole ?? raw.role ?? raw.permissionLevel ?? 'member',
  };
}

export class FavroApiClient {
  constructor(private client: FavroHttpClient) {}

  /**
   * Get members, optionally filtered by boardId or collectionId.
   */
  async getMembers(opts?: { boardId?: string; collectionId?: string }): Promise<Member[]> {
    const allMembers: Member[] = [];
    let requestId: string | undefined;
    let page = 1;

    while (true) {
      const params: Record<string, any> = { limit: 50 };
      if (opts?.boardId) params.boardId = opts.boardId;
      if (opts?.collectionId) params.collectionId = opts.collectionId;
      if (requestId) {
        params.requestId = requestId;
        params.page = page;
      }

      // Favro API uses /users not /members
      const response = await this.client.get<PaginatedResponse<RawMember>>('/users', { params });
      const members = (response.entities ?? []).map(normalizeMember);
      allMembers.push(...members);

      requestId = response.requestId;
      if (!requestId || !response.pages || page >= response.pages || members.length === 0) break;
      page++;
    }

    return allMembers;
  }

  /**
   * Add a member by email to a board or collection.
   * isBoardTarget: true = board, false = collection
   */
  async addMember(email: string, targetId: string, isBoardTarget: boolean): Promise<Member> {
    if (!isValidEmail(email)) {
      throw new Error(`Invalid email format: "${email}"`);
    }

    const payload: Record<string, any> = {
      email: email.trim(),
      targetId,
      targetType: isBoardTarget ? 'board' : 'collection',
    };

    const raw = await this.client.post<RawMember>('/members', payload);
    return normalizeMember(raw);
  }

  /**
   * Remove a member from a board or collection.
   */
  async removeMember(memberId: string, targetId: string, isBoardTarget: boolean): Promise<void> {
    await this.client.delete(`/members/${memberId}`, {
      params: {
        targetId,
        targetType: isBoardTarget ? 'board' : 'collection',
      },
    });
  }

  /**
   * Get permission level for a member on a specific board.
   */
  async getMemberPermissions(memberId: string, boardId: string): Promise<PermissionLevel> {
    const result = await this.client.get<{ role?: PermissionLevel; permissionLevel?: PermissionLevel }>(
      `/members/${memberId}`,
      { params: { boardId } }
    );
    const level = result.role ?? result.permissionLevel;
    if (!level || !['viewer', 'editor', 'admin'].includes(level)) {
      throw new Error(`Invalid or missing permission level for member ${memberId} on board ${boardId}`);
    }
    return level;
  }
}

export default FavroApiClient;
