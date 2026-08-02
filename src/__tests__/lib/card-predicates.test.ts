/**
 * Unit tests — the card predicates `risks` and `batch smart` each held a copy
 * of (#89).
 *
 * The two copies of `isOverdue` had drifted, and the drift is the point: one
 * parsed `card.dueDate` with `new Date(...)`, the other split `YYYY-MM-DD` into
 * a *local* midnight. Neither covered both wire shapes — the splitter produced
 * `NaN` for a full ISO timestamp (so nothing was ever overdue), and the plain
 * parse read a date-only string as UTC midnight (so a card due today reads as
 * overdue west of Greenwich). The surviving one handles both, which is what
 * these tests pin.
 */
import { Card } from '../../lib/cards-api';
import { isOverdue, isBlocked } from '../../lib/card-predicates';

function card(overrides: Partial<Card> = {}): Card {
  return { cardId: 'c1', name: 'Card', ...overrides } as Card;
}

/** `YYYY-MM-DD` for a local date `offsetDays` from today. */
function localDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

describe('isOverdue', () => {
  it('returns false when the card has no due date', () => {
    expect(isOverdue(card())).toBe(false);
  });

  it('reads a date-only due date against LOCAL midnight', () => {
    expect(isOverdue(card({ dueDate: localDate(-1) }))).toBe(true);
    expect(isOverdue(card({ dueDate: localDate(1) }))).toBe(false);
  });

  it('does not call today overdue', () => {
    expect(isOverdue(card({ dueDate: localDate(0) }))).toBe(false);
  });

  it('reads a full ISO timestamp too — the shape the splitter used to NaN on', () => {
    const past = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
    expect(isOverdue(card({ dueDate: past }))).toBe(true);
    expect(isOverdue(card({ dueDate: future }))).toBe(false);
  });

  it('returns false for an unparseable due date rather than guessing', () => {
    expect(isOverdue(card({ dueDate: 'sometime next week' }))).toBe(false);
  });
});

describe('isBlocked', () => {
  it('is true when any tag contains "blocked"', () => {
    expect(isBlocked(card({ tags: ['blocked', 'urgent'] }))).toBe(true);
    expect(isBlocked(card({ tags: ['Blocked-on-legal'] }))).toBe(true);
  });

  it('is true when the status contains "blocked"', () => {
    expect(isBlocked(card({ status: 'Blocked' }))).toBe(true);
  });

  it('is false with neither', () => {
    expect(isBlocked(card({ tags: ['urgent'], status: 'In Progress' }))).toBe(false);
    expect(isBlocked(card())).toBe(false);
  });
});
