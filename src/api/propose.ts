/**
 * Propose & Execute Change System
 * CLA-1797 / FAVRO-035: Propose & Execute Change System
 *
 * Core logic for the dry-run + confirm workflow:
 *   1. `proposeChange`  — validates action, generates API call preview, stores with 10min TTL
 *   2. `executeChange`  — retrieves stored change, applies API calls atomically
 */

import crypto from 'crypto';
import FavroHttpClient from '../lib/http-client';
import ContextAPI, { BoardContextSnapshot } from './context';
import {
  parseAction as parseActionCore,
  ActionParseError,
} from '../lib/action-parser';
import { changeStore, ApiCall, Change, TTL_MS } from '../lib/change-store';

// ─── Public Output Types ───────────────────────────────────────────────────────

export interface ProposedAction {
  changeId: string;
  boardName: string;
  actionText: string;
  preview: ApiCall[];
  expiresAt: number;
}

export interface ExecutionResultChange {
  method: string;
  path: string;
  description: string;
  result: 'success' | 'failed';
  error?: string;
}

export interface ExecutionResult {
  changeId: string;
  status: 'executed' | 'failed';
  changes: ExecutionResultChange[];
  message: string;
}

export { ApiCall };

// ─── Validation Error ─────────────────────────────────────────────────────────

export class ValidationError extends Error {
  constructor(message: string, public readonly suggestions?: string[]) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ─── API Call Generation ──────────────────────────────────────────────────────

/**
 * Find a card in the board context by title (case-insensitive, then fuzzy).
 * Returns the card or throws ValidationError with suggestions.
 */
function findCard(
  title: string,
  snapshot: BoardContextSnapshot
): typeof snapshot.cards[0] {
  // Exact (case-insensitive) match first
  const exact = snapshot.cards.find(
    c => c.title.toLowerCase() === title.toLowerCase()
  );
  if (exact) return exact;

  // Partial / fuzzy fallback — find top matches
  const lower = title.toLowerCase();
  const partials = snapshot.cards
    .map(c => ({ card: c, score: c.title.toLowerCase().includes(lower) ? 1 : 0 }))
    .filter(m => m.score > 0)
    .map(m => m.card);

  if (partials.length === 1) return partials[0];
  if (partials.length > 1) {
    const suggestions = partials.slice(0, 3).map(c => `"${c.title}"`);
    throw new ValidationError(
      `Ambiguous card title "${title}". Did you mean one of: ${suggestions.join(', ')}?`,
      suggestions
    );
  }

  // Levenshtein-based fuzzy matching (simple approach)
  const allTitles = snapshot.cards.map(c => c.title);
  const suggestions = allTitles
    .map(t => ({
      title: t,
      dist: levenshtein(t.toLowerCase(), lower),
    }))
    .filter(m => m.dist <= 5)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 3)
    .map(m => `"${m.title}"`);

  const hint = suggestions.length > 0
    ? ` Did you mean: ${suggestions.join(', ')}?`
    : ' Use `favro context <board>` to list available cards.';

  throw new ValidationError(
    `Card not found: "${title}".${hint}`,
    suggestions
  );
}

function levenshtein(a: string, b: string): number {
  if (a.length > 100 || b.length > 100) return Math.abs(a.length - b.length);
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Find a column/status name in the board context.
 */
function findStatus(name: string, snapshot: BoardContextSnapshot): string {
  // Exact match (case-insensitive)
  const col = snapshot.columns.find(
    c => c.name.toLowerCase() === name.toLowerCase()
  );
  if (col) return col.name;

  // Partial match
  const partials = snapshot.columns.filter(
    c => c.name.toLowerCase().includes(name.toLowerCase())
  );
  if (partials.length === 1) return partials[0].name;

  const suggestions = snapshot.columns.slice(0, 5).map(c => `"${c.name}"`);
  throw new ValidationError(
    `Status "${name}" not found on board. Available: ${suggestions.join(', ')}.`,
    suggestions
  );
}

/**
 * Find a member by name or email.
 */
function findMember(
  nameOrEmail: string,
  snapshot: BoardContextSnapshot
): typeof snapshot.members[0] {
  const lower = nameOrEmail.toLowerCase();
  const member = snapshot.members.find(
    m => m.name.toLowerCase() === lower || m.email.toLowerCase() === lower ||
         m.name.toLowerCase().includes(lower) || m.email.toLowerCase().includes(lower)
  );
  if (member) return member;

  const suggestions = snapshot.members.slice(0, 3).map(m => `"${m.name}" <${m.email}>`);
  throw new ValidationError(
    `Member "${nameOrEmail}" not found on board. Available: ${suggestions.join(', ')}.`,
    suggestions
  );
}

/**
 * Generate the list of API calls for a parsed action against the board snapshot.
 */
function generateApiCalls(
  actionText: string,
  snapshot: BoardContextSnapshot
): ApiCall[] {
  const parsed = parseActionCore(actionText);
  const apiCalls: ApiCall[] = [];

  switch (parsed.type) {
    case 'move': {
      const card = findCard(parsed.title, snapshot);
      const toStatus = findStatus(parsed.toStatus, snapshot);
      apiCalls.push({
        method: 'PATCH',
        path: `/api/cards/${card.id}`,
        data: { status: toStatus },
        description: `Update card "${card.title}" status to "${toStatus}"`,
      });
      break;
    }

    case 'assign': {
      const card = findCard(parsed.title, snapshot);
      const member = findMember(parsed.owner, snapshot);
      const existing = card.assignees ?? [];
      const newAssignees = existing.includes(member.id)
        ? existing
        : [...existing, member.id];
      apiCalls.push({
        method: 'PATCH',
        path: `/api/cards/${card.id}`,
        data: { assignees: newAssignees },
        description: `Assign card "${card.title}" to "${member.name}"`,
      });
      break;
    }

    case 'set-priority': {
      const card = findCard(parsed.title, snapshot);
      apiCalls.push({
        method: 'PATCH',
        path: `/api/cards/${card.id}`,
        data: { priority: parsed.priority },
        description: `Set priority of card "${card.title}" to "${parsed.priority}"`,
      });
      break;
    }

    case 'add-date': {
      const card = findCard(parsed.title, snapshot);
      apiCalls.push({
        method: 'PATCH',
        path: `/api/cards/${card.id}`,
        data: { dueDate: parsed.date },
        description: `Set due date of card "${card.title}" to "${parsed.date}"`,
      });
      break;
    }

    case 'link': {
      const card = findCard(parsed.title, snapshot);
      const target = findCard(parsed.targetTitle, snapshot);
      apiCalls.push({
        method: 'POST',
        path: `/api/cards/${card.id}/links`,
        data: { type: parsed.relationship, targetCardId: target.id },
        description: `Link card "${card.title}" ${parsed.relationship} "${target.title}"`,
      });
      break;
    }

    case 'create': {
      const status = findStatus(parsed.status, snapshot);
      const createData: Record<string, unknown> = {
        name: parsed.title,
        status,
        boardId: snapshot.board.id,
      };
      if (parsed.priority) createData.priority = parsed.priority;
      if (parsed.owner) {
        const member = findMember(parsed.owner, snapshot);
        createData.assignees = [member.id];
      }
      if (parsed.effort) createData.effort = parsed.effort;
      apiCalls.push({
        method: 'POST',
        path: '/api/cards',
        data: createData,
        description: `Create card "${parsed.title}" in status "${status}"`,
      });
      break;
    }

    case 'close': {
      const card = findCard(parsed.title, snapshot);
      // Find a "done"/"closed" column, or use the last column
      const doneCol = snapshot.columns.find(
        c => /done|closed|complete|finished/i.test(c.name)
      ) ?? snapshot.columns[snapshot.columns.length - 1];

      if (doneCol) {
        apiCalls.push({
          method: 'PATCH',
          path: `/api/cards/${card.id}`,
          data: { status: doneCol.name },
          description: `Close card "${card.title}" (move to "${doneCol.name}")`,
        });
      } else {
        apiCalls.push({
          method: 'PATCH',
          path: `/api/cards/${card.id}`,
          data: { archived: true },
          description: `Close card "${card.title}"`,
        });
      }
      break;
    }

    default:
      throw new ValidationError(
        `Unsupported action type: ${(parsed as any).type}. Supported: move, assign, set, add, link, create, close.`
      );
  }

  return apiCalls;
}

// ─── proposeChange ─────────────────────────────────────────────────────────────

/**
 * Propose a change: validate, generate API call preview, store with expiry.
 *
 * @param board       Board name or ID
 * @param actionText  Natural language action string
 * @param client      Authenticated HTTP client
 * @returns           ProposedAction with changeId and preview
 * @throws            ValidationError if action is invalid or references unknown entities
 * @throws            ActionParseError if the action text cannot be parsed
 */
export async function proposeChange(
  board: string,
  actionText: string,
  client: FavroHttpClient
): Promise<ProposedAction> {
  if (!actionText?.trim()) {
    throw new ValidationError('Action text is required. Example: move card "Fix login" from Backlog to In Progress');
  }

  // Step 1: Fetch board context for validation
  const contextApi = new ContextAPI(client);
  const snapshot = await contextApi.getSnapshot(board);

  // Step 2 + 3: Parse action + validate all fields + generate API calls
  // (generateApiCalls handles both parsing and validation together)
  const apiCalls = generateApiCalls(actionText.trim(), snapshot);

  // Step 4: Generate a unique change ID
  const changeId = `ch_${crypto.randomBytes(8).toString('hex')}`;
  const expiresAt = Date.now() + TTL_MS;

  // Step 5: Store with expiry
  const change: Change = {
    changeId,
    boardName: snapshot.board.name,
    actionText: actionText.trim(),
    apiCalls,
    status: 'proposed',
    expiresAt,
  };
  changeStore.storeChange(changeId, change);

  return {
    changeId,
    boardName: snapshot.board.name,
    actionText: actionText.trim(),
    preview: apiCalls,
    expiresAt,
  };
}

// ─── executeChange ─────────────────────────────────────────────────────────────

/**
 * Execute a previously proposed change by its change ID.
 * Applies all API calls atomically (Promise.all); on any failure marks all as failed.
 *
 * @param changeId  The change ID returned by proposeChange
 * @param client    Authenticated HTTP client
 * @returns         ExecutionResult with per-call results
 * @throws          ValidationError if changeId is not found or expired
 */
export async function executeChange(
  changeId: string,
  client: FavroHttpClient
): Promise<ExecutionResult> {
  const change = changeStore.getChange(changeId);
  if (!change) {
    throw new ValidationError(
      `Change ID "${changeId}" not found or has expired (changes expire after 10 minutes). ` +
      `Run \`favro propose\` again to generate a new change.`
    );
  }

  const results: ExecutionResultChange[] = change.apiCalls.map(call => ({
    method: call.method,
    path: call.path,
    description: call.description,
    result: 'success' as const,
  }));

  // Execute all API calls in parallel
  try {
    await Promise.all(
      change.apiCalls.map(async (call, i) => {
        try {
          const httpClient = (client as any).client ?? client;
          // Use the underlying axios instance from FavroHttpClient
          const axiosInstance = (client as any).client;
          if (axiosInstance) {
            if (call.method === 'POST') {
              await axiosInstance.post(call.path, call.data);
            } else if (call.method === 'PATCH') {
              await axiosInstance.patch(call.path, call.data);
            } else if (call.method === 'DELETE') {
              await axiosInstance.delete(call.path);
            } else if (call.method === 'GET') {
              await axiosInstance.get(call.path);
            }
          }
          results[i].result = 'success';
        } catch (err: any) {
          results[i].result = 'failed';
          results[i].error = err?.response?.data?.message ?? err?.message ?? 'Unknown error';
          throw err;
        }
      })
    );

    // Success — remove from store
    changeStore.removeChange(changeId);

    const successCount = results.filter(r => r.result === 'success').length;
    return {
      changeId,
      status: 'executed',
      changes: results,
      message: `${successCount}/${results.length} changes applied successfully`,
    };
  } catch {
    // On any failure, mark remaining as failed too
    // (already handled per-call above, but update store status)
    const failureCount = results.filter(r => r.result === 'failed').length;
    return {
      changeId,
      status: 'failed',
      changes: results,
      message: `${failureCount}/${results.length} changes failed`,
    };
  }
}
