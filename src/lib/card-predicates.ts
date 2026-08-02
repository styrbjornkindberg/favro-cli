/**
 * The two card predicates `risks` and `batch smart` each carried a copy of (#89).
 *
 * `isBlocked` was byte-identical in both. `isOverdue` had drifted: `risks` did
 * `new Date(card.dueDate)`, `batch smart` split `YYYY-MM-DD` into a local
 * midnight "for timezone-correct comparison". Each was wrong on the shape the
 * other handled — the splitter yields `NaN` for a full ISO timestamp, so a card
 * due last month never read as overdue; the plain parse reads a date-only
 * string as UTC midnight, so a card due today reads as overdue anywhere west of
 * Greenwich. Favro sends both shapes, so the surviving copy takes the date-only
 * branch when the string is date-only and falls back to `Date` otherwise.
 *
 * Note this is *tag-and-status* blocking — the word in a label or a column
 * name. It is not the `isBefore` edge: see `judgeBlockers` in `blocking.ts` for
 * that, and `isBlocked` in `api/standup.ts` for the `ContextCard` predicate that
 * reads column names only.
 */
import type { Card } from './cards-api';

/** `2026-08-02` and nothing else — no time part, no zone. */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Is the card's due date strictly before today? An undated card is never overdue. */
export function isOverdue(card: Card): boolean {
  if (!card.dueDate) return false;

  const dateOnly = card.dueDate.match(DATE_ONLY);
  // A bare date carries no zone, so it means midnight *here*, not midnight UTC.
  const dueDate = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(card.dueDate);
  if (isNaN(dueDate.getTime())) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return dueDate < today;
}

/** Does a tag or the column name say "blocked"? */
export function isBlocked(card: Card): boolean {
  if (card.tags && card.tags.some(t => t.toLowerCase().includes('blocked'))) return true;
  if (card.status && card.status.toLowerCase().includes('blocked')) return true;
  return false;
}
