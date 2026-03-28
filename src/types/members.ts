/**
 * Members & Permissions Types
 * CLA-1788 FAVRO-026: Members & Permissions API
 */

export interface Member {
  id: string;
  name: string;
  email: string;
  role: string; // e.g., "admin", "member", "viewer", "editor"
}

export type PermissionLevel = 'viewer' | 'editor' | 'admin';
