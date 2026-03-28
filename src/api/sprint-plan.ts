/**
 * Sprint Plan API
 * CLA-1799 / FAVRO-037: Standup & Sprint Commands
 *
 * Suggests backlog cards for sprint planning based on priority×effort heuristic:
 *   - Filters for cards with status="Backlog" only
 *   - Sorts by priority (high→low) then effort (low→high, feasibility-first)
 *   - Respects a point budget (default 40)
 *   - Priority and effort read from custom fields
 *
 * Priority ranking: critical > high > medium > low > (unset)
 * Effort ranking: lower numbers first (feasibility-first)
 */

import FavroHttpClient from '../lib/http-client';
import ContextAPI, { type ContextCard, type BoardContextSnapshot } from './context';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SprintCard {
  id: string;
  title: string;
  status?: string;
  assignees?: string[];
  priority?: string;
  effort?: number;
  priorityScore: number;  // 0–4 numeric (higher = more important)
  cumulative: number;     // running total of effort points after this card
  withinBudget: boolean;  // true if adding this card stays within budget
}

export interface SprintPlanResult {
  board: {
    id: string;
    name: string;
  };
  budget: number;
  totalSuggested: number;
  suggestions: SprintCard[];
  overflow: SprintCard[];  // cards that didn't fit in budget
  generatedAt: string;
}

// ─── Priority Scoring ─────────────────────────────────────────────────────────

const PRIORITY_SCORES: Record<string, number> = {
  critical: 4,
  urgent: 4,
  high: 3,
  medium: 2,
  normal: 2,
  low: 1,
};

/**
 * Convert priority string to a numeric score (higher = more important).
 */
export function priorityScore(priority: string | undefined): number {
  if (!priority) return 0;
  const p = priority.toLowerCase().trim();
  // Exact match first
  if (PRIORITY_SCORES[p] !== undefined) return PRIORITY_SCORES[p];
  // Partial match
  for (const [key, score] of Object.entries(PRIORITY_SCORES)) {
    if (p.includes(key)) return score;
  }
  return 0;
}

/**
 * Extract effort value from a card's custom fields.
 * Looks for fields named "effort", "story points", "points", "estimate".
 * Returns undefined if not found.
 */
export function extractEffort(card: ContextCard): number | undefined {
  const fields = card.customFields ?? {};
  const effortKeys = ['effort', 'Effort', 'story points', 'Story Points', 'points', 'Points', 'estimate', 'Estimate'];
  for (const key of effortKeys) {
    const val = fields[key];
    if (val !== undefined && val !== null) {
      const num = Number(val);
      if (!isNaN(num)) return num;
    }
  }
  return undefined;
}

/**
 * Extract priority value from a card's custom fields.
 * Looks for fields named "priority", "urgency", "severity".
 */
export function extractPriority(card: ContextCard): string | undefined {
  const fields = card.customFields ?? {};
  const priorityKeys = ['priority', 'Priority', 'urgency', 'Urgency', 'severity', 'Severity'];
  for (const key of priorityKeys) {
    const val = fields[key];
    if (val !== undefined && val !== null) return String(val);
  }
  return undefined;
}

// ─── Backlog Filter ───────────────────────────────────────────────────────────

const BACKLOG_STATUSES = ['backlog', 'todo', 'to do', 'to-do', 'ready', 'ready for dev', 'new', 'open'];

/**
 * Returns true if the card is in a backlog-like status.
 */
export function isBacklogCard(card: ContextCard): boolean {
  const status = (card.status ?? '').toLowerCase().trim();
  return BACKLOG_STATUSES.some(s => status === s || status.includes(s));
}

// ─── Sprint Sort ──────────────────────────────────────────────────────────────

/**
 * Compare two sprint cards for sorting:
 * 1. Higher priority first
 * 2. Lower effort first (feasibility-first) when priority is equal
 * 3. Alphabetically by title as tiebreaker
 */
export function compareSprintCards(a: SprintCard, b: SprintCard): number {
  // Higher priority first
  if (b.priorityScore !== a.priorityScore) {
    return b.priorityScore - a.priorityScore;
  }
  // Lower effort first (undefined effort goes last)
  const effortA = a.effort ?? Infinity;
  const effortB = b.effort ?? Infinity;
  if (effortA !== effortB) {
    return effortA - effortB;
  }
  // Alphabetical tiebreaker
  return a.title.localeCompare(b.title);
}

// ─── SprintPlanAPI ────────────────────────────────────────────────────────────

export class SprintPlanAPI {
  private contextApi: ContextAPI;

  constructor(private client: FavroHttpClient) {
    this.contextApi = new ContextAPI(client);
  }

  /**
   * Get sprint plan suggestions for a board.
   *
   * @param boardRef   Board name or ID
   * @param budget     Point budget for the sprint (default 40)
   * @param cardLimit  Max cards to fetch (default 500)
   */
  async getSuggestions(
    boardRef: string,
    budget: number = 40,
    cardLimit: number = 500,
  ): Promise<SprintPlanResult> {
    const snapshot: BoardContextSnapshot = await this.contextApi.getSnapshot(boardRef, cardLimit);

    // Filter to backlog cards only
    const backlogCards = snapshot.cards.filter(isBacklogCard);

    // Build sprint cards with priority/effort metadata
    const sprintCards: SprintCard[] = backlogCards.map(card => {
      const priority = extractPriority(card);
      const effort = extractEffort(card);
      const score = priorityScore(priority);

      return {
        id: card.id,
        title: card.title,
        status: card.status,
        assignees: card.assignees ?? [],
        priority,
        effort,
        priorityScore: score,
        cumulative: 0,     // filled in below
        withinBudget: false, // filled in below
      };
    });

    // Sort by priority desc, effort asc (feasibility-first)
    sprintCards.sort(compareSprintCards);

    // Calculate cumulative effort and budget fit
    let running = 0;
    const suggestions: SprintCard[] = [];
    const overflow: SprintCard[] = [];

    for (const card of sprintCards) {
      const cardEffort = card.effort ?? 0;
      running += cardEffort;
      card.cumulative = running;
      card.withinBudget = running <= budget;

      if (card.withinBudget) {
        suggestions.push(card);
      } else {
        overflow.push(card);
      }
    }

    return {
      board: {
        id: snapshot.board.id,
        name: snapshot.board.name,
      },
      budget,
      totalSuggested: suggestions.reduce((sum, c) => sum + (c.effort ?? 0), 0),
      suggestions,
      overflow,
      generatedAt: snapshot.generatedAt,
    };
  }
}

export default SprintPlanAPI;
