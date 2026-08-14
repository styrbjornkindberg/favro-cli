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
 * Priority ranking: critical/blocker, urgent > high > medium/normal > low > (unset).
 * A value outside that vocabulary is reported and ranks nowhere (`readPriority`).
 * Effort ranking: lower numbers first (feasibility-first)
 */

import FavroHttpClient from '../lib/http-client';
import ContextAPI, {
  addEffort,
  extractEffort,
  readPriority,
  type ContextCard,
  type BoardContextSnapshot,
} from './context';
import type { Unreachable } from '../lib/read-shape';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SprintCard {
  id: string;
  title: string;
  status?: string;
  assignees?: string[];
  /**
   * Always populated since the `readPriority` merge — the label, `'unset'` or
   * `'unavailable'`, never absent. Optional only because older payloads omitted it.
   */
  priority?: string;
  effort?: number;
  /**
   * 0–4 numeric (higher = more important), or `null` for a priority this ranking
   * could not place. TWO reasons, and a consumer must not read one for the other:
   * either no priority field could be matched by name at all (`unavailable`), or
   * one WAS matched onto a value outside the scored vocabulary (`readPriority`) —
   * a `P1` is `{label: 'p1', score: null}`. NOT the same as a card that was read
   * and holds no priority, which is `0` (#169).
   */
  priorityScore: number | null;
  /**
   * Running total of effort points after this card, or `null` once a counted
   * card's effort could not be read at all (#169). `?? 0` here used to turn an
   * unreadable estimate into a free card.
   */
  cumulative: number | null;
  /**
   * True if adding this card stays within budget, false if it does not, `null`
   * when the running total is unreadable — a card whose cost is unknown cannot
   * be asserted to fit a budget, and cannot be asserted to overflow one either.
   */
  withinBudget: boolean | null;
}

export interface SprintPlanResult {
  board: {
    id: string;
    name: string;
  };
  budget: number;
  /** Effort of the suggested cards, or `null` when one of them was unreadable. */
  totalSuggested: number | null;
  suggestions: SprintCard[];
  overflow: SprintCard[];  // cards MEASURED not to fit — nothing else is excluded
  /**
   * Carried straight off the snapshot (#116). An empty plan from a failed cards
   * read would otherwise read as "no backlog cards found", which is advice.
   */
  unreachable?: Unreachable[];
  generatedAt: string;
}

// ─── Priority Scoring ─────────────────────────────────────────────────────────
//
// Was a local `PRIORITY_SCORES` + `priorityScore` + `extractPriority`, all three
// deleted: the vocabulary, the key match and the four answers now live once in
// `readPriority` (`api/context.ts`), shared with `next` (#169 review). The three
// ways the two copies disagreed are recorded there.

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
 *
 * An unreadable priority (`null`) ranks where an unset one does. This has to stay
 * a TOTAL order — `null` arithmetic is `NaN`, and a comparator returning `NaN`
 * leaves the array in an implementation-defined order — so the honest answer here
 * is a rank, and the disclosure lives in the output (#169).
 */
export function compareSprintCards(a: SprintCard, b: SprintCard): number {
  // Higher priority first
  const scoreA = a.priorityScore ?? 0;
  const scoreB = b.priorityScore ?? 0;
  if (scoreB !== scoreA) {
    return scoreB - scoreA;
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
   * No card cap: `getSnapshot` has none to pass one to. The `cardLimit` this
   * used to take was a pure pass-through into a parameter nothing read (#143
   * close). `--budget` is unaffected and still `parseLimit`'s.
   *
   * @param boardRef   Board name or ID
   * @param budget     Point budget for the sprint (default 40)
   */
  async getSuggestions(boardRef: string, budget: number = 40): Promise<SprintPlanResult> {
    const snapshot: BoardContextSnapshot = await this.contextApi.getSnapshot(boardRef);

    // Filter to backlog cards only
    const backlogCards = snapshot.cards.filter(isBacklogCard);

    // Build sprint cards with priority/effort metadata. Paired with the card they
    // came from: the budget accumulator is `addEffort`, which needs the raw
    // `customFields` to tell an effort of nothing from an effort nobody could read
    // (#169), and `SprintCard` is the JSON shape and does not carry them.
    const paired = backlogCards.map(card => {
      const { label: priority, score } = readPriority(card);
      const effort = extractEffort(card);

      return {
        source: card,
        sprint: {
          id: card.id,
          title: card.title,
          status: card.status,
          assignees: card.assignees ?? [],
          priority,
          effort,
          priorityScore: score,
          cumulative: 0 as number | null,       // filled in below
          withinBudget: false as boolean | null, // filled in below
        },
      };
    });

    // Sort by priority desc, effort asc (feasibility-first)
    paired.sort((a, b) => compareSprintCards(a.sprint, b.sprint));

    // Calculate cumulative effort and budget fit
    let running: number | null = 0;
    const suggestions: SprintCard[] = [];
    const overflow: SprintCard[] = [];

    for (const { source, sprint } of paired) {
      running = addEffort(running, source);
      sprint.cumulative = running;
      // Undisclosed rather than `true`: `?? 0` made every unreadable card free,
      // so `running <= budget` was `0 <= 40` for every card on the measured wire
      // and the whole backlog reported as fitting one sprint (#169).
      sprint.withinBudget = running === null ? null : running <= budget;

      if (sprint.withinBudget === false) {
        overflow.push(sprint);
      } else {
        suggestions.push(sprint);
      }
    }

    return {
      board: {
        id: snapshot.board.id,
        name: snapshot.board.name,
      },
      budget,
      // `?? 0` survives only behind the `running !== null` guard, and that is what
      // makes it honest: a card reaches here with no effort either because it read
      // as nothing, or because it carried no custom fields at all — and `addEffort`
      // has already turned `running` to `null` for the first case.
      totalSuggested: running === null ? null : suggestions.reduce((sum, c) => sum + (c.effort ?? 0), 0),
      suggestions,
      overflow,
      ...(snapshot.unreachable ? { unreachable: snapshot.unreachable } : {}),
      generatedAt: snapshot.generatedAt,
    };
  }
}

export default SprintPlanAPI;
