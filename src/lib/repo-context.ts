/**
 * Repo Context Loader — reads .favro/context.json from the current working directory.
 * Returns null if not found (graceful fallback for repos without context).
 */
import * as fs from 'fs/promises';
import * as path from 'path';

export interface RepoContext {
  _description?: string;
  _updated?: string;
  scope: {
    collectionId: string;
    collectionName: string;
  };
  boards: Record<string, {
    boardId: string;
    name: string;
    type?: string;
    description?: string;
    workflow?: Array<{
      columnId: string;
      name: string;
      stage: string;
      next: string | null;
    }>;
  }>;
  customFields: Record<string, {
    fieldId: string;
    type: string;
    description?: string;
    options?: Record<string, string>;
  }>;
  team: Record<string, {
    name: string;
    email: string;
    role?: string;
  }>;
  notes: Record<string, string>;
}

/**
 * Read .favro/context.json from cwd or nearest parent.
 * Returns null if not found.
 */
export async function loadRepoContext(startDir?: string): Promise<RepoContext | null> {
  let dir = startDir ?? process.cwd();

  // Walk up to find .favro/context.json (max 10 levels)
  for (let i = 0; i < 10; i++) {
    const contextFile = path.join(dir, '.favro', 'context.json');
    try {
      const raw = await fs.readFile(contextFile, 'utf-8');
      return JSON.parse(raw) as RepoContext;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) break; // Root reached
      dir = parent;
    }
  }
  return null;
}

/**
 * Resolve a board reference against repo context.
 * Accepts: slug key ("kanban"), partial name match ("Kanban"), or boardId.
 */
export function resolveBoard(
  ctx: RepoContext,
  ref: string,
): { boardId: string; name: string; workflow?: RepoContext['boards'][string]['workflow'] } | null {
  // Direct slug key
  if (ctx.boards[ref]) {
    const b = ctx.boards[ref];
    return { boardId: b.boardId, name: b.name, workflow: b.workflow };
  }

  // By boardId
  for (const [, b] of Object.entries(ctx.boards)) {
    if (b.boardId === ref) return { boardId: b.boardId, name: b.name, workflow: b.workflow };
  }

  // Partial name match (case-insensitive)
  const lower = ref.toLowerCase();
  for (const [, b] of Object.entries(ctx.boards)) {
    if (b.name.toLowerCase().includes(lower)) {
      return { boardId: b.boardId, name: b.name, workflow: b.workflow };
    }
  }

  return null;
}
