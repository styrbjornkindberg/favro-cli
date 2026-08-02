/**
 * The two card predicates `risks` and `batch smart` each carried a copy of (#89).
 *
 * `isBlocked` was byte-identical in both. `isOverdue` had drifted: `risks` did
 * `new Date(card.dueDate)`, `batch smart` split `YYYY-MM-DD` into a local
 * midnight "for timezone-correct comparison". Each was wrong on the shape the
 * other handled — the splitter yields `NaN` for a full ISO timestamp (so
 * nothing is ever overdue), the plain parse reads a date-only string as UTC
 * midnight (so a card due today reads as overdue west of Greenwich). The
 * surviving copy takes the date-only branch for a date-only string and `Date`
 * otherwise, so each caller keeps the case it had right.
 *
 * WHICH SHAPE FAVRO ACTUALLY SENDS IS UNMEASURED. `dueDate` passes through
 * `normalizeCard` untouched via `...rest` (`cards-api.ts`), every fixture in
 * this repo is date-only, and no wire test pins it. The two branches have
 * different consequences and only one of them can be the real one:
 *
 *   - **If Favro sends date-only.** `batch smart` is unchanged; `risks` stops
 *     over-reporting overdue cards in negative-UTC-offset timezones. Read-only
 *     either way.
 *   - **If Favro sends full ISO timestamps.** `risks` is unchanged, but the
 *     `overdue` filter in `batch smart` (`buildCardFilter`) goes from matching
 *     NOTHING to matching the real set — and that filter feeds
 *     `batch-smart <board> --goal "move all overdue cards to Review" --yes`,
 *     a bulk write with a skippable confirm. A scheduled invocation that was a
 *     silent no-op starts mutating cards on its next run.
 *
 * The function is correct under both; the disclosure is the point. Measuring it
 * needs a live wire and credentials this repo's test suite does not have.
 *
 * Note this is *tag-and-status* blocking — the word in a label or a column
 * name. It is not the `isBefore` edge: see `judgeBlockers` in `blocking.ts` for
 * that, and `isBlocked` in `api/standup.ts` for the `ContextCard` predicate that
 * reads column names only.
 */
import type { Card } from './cards-api';

/** `2026-08-02` and nothing else — no time part, no zone. */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A bare date carries no zone, so it means midnight *here*, not midnight UTC.
 *
 * `new Date(y, m, d)` silently rolls out-of-range parts over — `2026-13-45`
 * becomes Feb 2027 rather than `NaN` — so the parsed date is round-tripped
 * against the digits it came from and a rollover is rejected.
 */
function localMidnight(match: RegExpMatchArray): Date {
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  const rolledOver =
    date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day;
  return rolledOver ? new Date(NaN) : date;
}

/** Is the card's due date strictly before today? An undated card is never overdue. */
export function isOverdue(card: Card): boolean {
  if (!card.dueDate) return false;

  const dateOnly = card.dueDate.match(DATE_ONLY);
  const dueDate = dateOnly ? localMidnight(dateOnly) : new Date(card.dueDate);
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
