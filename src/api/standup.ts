/**
 * Standup API
 * CLA-1799 / FAVRO-037: Standup & Sprint Commands
 *
 * Groups board cards by status categories for daily standup overview:
 *   - completed: cards with status matching "done", "completed", "closed", "released"
 *   - in-progress: cards with status matching "in progress", "in-review", "review"
 *   - blocked: cards whose status says so (dependency edges are reported as a
 *     count, not as a blocked state — #61)
 *   - due-soon: cards with dueDate within the next 3 days
 *
 * Uses ContextAPI for a single parallel fetch of all board data.
 */

import FavroHttpClient from '../lib/http-client';
import ContextAPI, { type ContextCard, type BoardContextSnapshot } from './context';
import type { Unreachable } from '../lib/read-shape';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StandupCard {
  id: string;
  title: string;
  status?: string;
  assignees?: string[];
  /**
   * How many unresolved-looking dependency edges the card carries. An edge
   * count, NOT a blocked state — see `isBlocked` (#61).
   */
  dependencies: number;
  group: 'completed' | 'in-progress' | 'blocked' | 'due-soon';
}

export interface StandupResult {
  board: {
    id: string;
    name: string;
  };
  completed: StandupCard[];
  inProgress: StandupCard[];
  blocked: StandupCard[];
  dueSoon: StandupCard[];
  total: number;
  /**
   * Carried straight off the snapshot (#116). Without it `total: 0` from a
   * failed cards read is indistinguishable from a board with no cards, and this
   * command's whole output is those four groups.
   */
  unreachable?: Unreachable[];
  generatedAt: string;
}

// ─── Status Classifiers ───────────────────────────────────────────────────────

const COMPLETED_STATUSES = ['done', 'completed', 'closed', 'released', 'finished', 'resolved'];
const IN_PROGRESS_STATUSES = ['in progress', 'in-progress', 'in review', 'in-review', 'review', 'doing', 'active', 'wip'];
const BLOCKED_STATUSES = ['blocked', 'on hold', 'on-hold'];

/**
 * Returns true if the card is considered "completed" based on its status.
 */
export function isCompleted(card: ContextCard): boolean {
  const status = (card.status ?? '').toLowerCase().trim();
  return COMPLETED_STATUSES.some(s => status === s || status.includes(s));
}

/**
 * Returns true if the card is considered "in progress" based on its status.
 */
export function isInProgress(card: ContextCard): boolean {
  const status = (card.status ?? '').toLowerCase().trim();
  return IN_PROGRESS_STATUSES.some(s => status === s || status.includes(s));
}

/**
 * Returns true if the card is blocked, on the only evidence this snapshot has:
 * its column. `status` IS the column name once `hydrateNames` has run; `column`
 * is the same name resolved off the workflow, and is the fallback for a snapshot
 * where the column-name cache came back empty.
 *
 * A `blockedBy` edge is deliberately NOT consulted (#61). Nothing clears a
 * Favro `isBefore` edge when the blocker finishes, so counting edges reports a
 * card as blocked forever. Proving a blocker done needs the per-blocker sweep in
 * `judgeBlockers`, which this path does not pay for — so the edges are reported
 * as a count (`StandupCard.dependencies`) rather than asserted as a state.
 */
export function isBlocked(card: ContextCard): boolean {
  const status = (card.status ?? card.column ?? '').toLowerCase().trim();
  return BLOCKED_STATUSES.some(s => status === s || status.includes(s));
}

/**
 * Returns true if the card is due within the next `withinDays` days.
 */
export function isDueSoon(card: ContextCard, withinDays: number = 3): boolean {
  if (!card.due) return false;
  const dueDate = new Date(card.due);
  if (isNaN(dueDate.getTime())) return false;
  const now = new Date();
  const diffMs = dueDate.getTime() - now.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  // Due in the future but within `withinDays` days, OR overdue (diffDays < 0)
  return diffDays <= withinDays;
}

/**
 * Normalize a ContextCard to a StandupCard with a group assignment.
 * Priority: blocked > completed > in-progress > due-soon
 * (blocked supersedes other groupings)
 */
export function classifyCard(card: ContextCard, withinDays: number = 3): StandupCard | null {
  const base: Omit<StandupCard, 'group'> = {
    id: card.id,
    title: card.title,
    status: card.status,
    assignees: card.assignees ?? [],
    dependencies: (card.blockedBy ?? []).length,
  };

  if (isBlocked(card)) {
    return { ...base, group: 'blocked' };
  }
  if (isCompleted(card)) {
    return { ...base, group: 'completed' };
  }
  if (isInProgress(card)) {
    return { ...base, group: 'in-progress' };
  }
  if (isDueSoon(card, withinDays)) {
    return { ...base, group: 'due-soon' };
  }

  // Card doesn't fit any standup group (e.g. Backlog) — exclude
  return null;
}

// ─── StandupAPI ───────────────────────────────────────────────────────────────

export class StandupAPI {
  private contextApi: ContextAPI;

  constructor(private client: FavroHttpClient) {
    this.contextApi = new ContextAPI(client);
  }

  /**
   * Get standup data for a board.
   *
   * @param boardRef   Board name or ID
   * @param cardLimit  Max cards to fetch (default 500)
   * @param dueSoonDays  Days ahead to consider "due soon" (default 3)
   */
  async getStandup(
    boardRef: string,
    cardLimit: number = 500,
    dueSoonDays: number = 3,
  ): Promise<StandupResult> {
    const snapshot: BoardContextSnapshot = await this.contextApi.getSnapshot(boardRef, cardLimit);

    const completed: StandupCard[] = [];
    const inProgress: StandupCard[] = [];
    const blocked: StandupCard[] = [];
    const dueSoon: StandupCard[] = [];

    for (const card of snapshot.cards) {
      const classified = classifyCard(card, dueSoonDays);
      if (!classified) continue;

      switch (classified.group) {
        case 'completed':
          completed.push(classified);
          break;
        case 'in-progress':
          inProgress.push(classified);
          break;
        case 'blocked':
          blocked.push(classified);
          break;
        case 'due-soon':
          dueSoon.push(classified);
          break;
      }
    }

    return {
      board: {
        id: snapshot.board.id,
        name: snapshot.board.name,
      },
      completed,
      inProgress,
      blocked,
      dueSoon,
      total: snapshot.cards.length,
      ...(snapshot.unreachable ? { unreachable: snapshot.unreachable } : {}),
      generatedAt: snapshot.generatedAt,
    };
  }
}

export default StandupAPI;
