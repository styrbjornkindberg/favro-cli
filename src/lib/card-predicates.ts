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
 * FAVRO SENDS A FULL ISO TIMESTAMP — measured, not inferred (#132). A read-only
 * scan of a live workspace on 2026-08-03 (100 boards, 1262 unarchived cards)
 * returned 204 dated cards, every one of them full ISO (`2023-07-27T07:00:00.000Z`)
 * and **not one** date-only. `GET /cards/<id>` and `GET /cards?widgetCommonId=…`
 * agreed byte-for-byte. An undated card omits the key entirely: zero nulls,
 * 1058 absent. `duedate-wire-shape.test.ts` pins the shape off a real socket.
 *
 * So it is the `new Date(…)` branch below that runs in production, and the
 * date-only branch is defensive: nothing observed has taken it. Keep it anyway —
 * a read shape is not a contract, this measured one org on one day, and a
 * date-only string is still spellable from our own side (`UpdateCardRequest`
 * documents `dueDate` as `YYYY-MM-DD`, though the WRITE shape is separately
 * unmeasured — #132 probed reads only, and deliberately made no writes).
 *
 * That makes the #89 consequence the LIVE one. The pre-#89 `batch smart` copy
 * split on `-` and read `27T07:00:00.000Z` as `NaN`, so its `overdue` filter
 * matched NOTHING against what Favro actually sends. Measured on the same
 * workspace: the old splitter matches **0** cards, this function matches **198**,
 * spread over 16 boards with the heaviest single board at 100. That filter feeds
 * `buildCardFilter`, and so
 * `batch smart <board> --goal "move all overdue cards to Review" --yes` — a bulk
 * write with a skippable confirm. `batch smart` is scoped to ONE board, so a
 * given invocation moves that board's share (up to 100 here), not all 198. Any
 * scheduled invocation was a silent no-op before #89 and writes for real on its
 * next run: a behaviour change for existing automation, not a latent one.
 *
 * The function itself is unchanged and correct on the measured shape; the
 * timestamps encode a *local* day boundary (`T22:00:00.000Z`, `T21:59:59.999Z`,
 * `T07:00:00.000Z` all occur), which is exactly what `new Date(…)` reads back
 * correctly and what truncating to ten characters would break.
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
