/**
 * `scoreCard` / `extractPriority` / `extractEffort` — issue #76.
 *
 * No wire seam: ranking is pure in-process arithmetic over an already-fetched
 * snapshot, and `score` / `reasons` are emitted verbatim in `--json`.
 *
 * The weights are not restated here. The test #71 deleted re-implemented a
 * `scoreCard` that existed nowhere in `src`, so it asserted its own arithmetic
 * against itself. Every number below is a literal, hand-computed from one term
 * at a time so a changed weight names itself in the failure.
 *
 * `scoreCard` reads the clock for due urgency, so the system time is fixed.
 */
import { scoreCard, extractPriority } from '../../commands/next';
// `extractEffort` moved to its one home in `api/context` (#89).
import { extractEffort } from '../../api/context';
import { AggregateCard } from '../../api/aggregate';

const NOW = '2026-06-15T12:00:00.000Z';

const card = (over: Partial<AggregateCard> = {}): AggregateCard =>
  ({ id: 'c1', title: 'a card', ...over }) as AggregateCard;

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date(NOW));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('extractPriority', () => {
  it('reads a priority off any field whose name suggests one', () => {
    expect(extractPriority(card({ customFields: { Priority: 'Critical' } })).score).toBe(4);
    expect(extractPriority(card({ customFields: { Urgency: 'blocker' } })).score).toBe(4);
    expect(extractPriority(card({ customFields: { Severity: 'High' } })).score).toBe(3);
    expect(extractPriority(card({ customFields: { priority: 'Normal' } })).score).toBe(2);
    expect(extractPriority(card({ customFields: { priority: 'medium' } })).score).toBe(2);
    expect(extractPriority(card({ customFields: { priority: 'Low' } })).score).toBe(1);
  });

  it('lower-cases the label it reports back', () => {
    expect(extractPriority(card({ customFields: { Priority: 'Critical' } })).label).toBe('critical');
  });

  it('reports unset for no custom fields, an unrelated field, or an unrecognised value', () => {
    expect(extractPriority(card())).toEqual({ label: 'unset', score: 0 });
    expect(extractPriority(card({ customFields: { Team: 'Platform' } }))).toEqual({ label: 'unset', score: 0 });
    expect(extractPriority(card({ customFields: { Priority: 'someday' } }))).toEqual({ label: 'unset', score: 0 });
  });
});

describe('extractEffort', () => {
  it('reads a number off any field whose name suggests an estimate', () => {
    expect(extractEffort(card({ customFields: { Effort: 5 } }))).toBe(5);
    expect(extractEffort(card({ customFields: { 'Story Points': '3' } }))).toBe(3);
    expect(extractEffort(card({ customFields: { Estimate: 8 } }))).toBe(8);
  });

  it('is undefined — not zero — when there is nothing to read or it is not a number', () => {
    expect(extractEffort(card())).toBeUndefined();
    expect(extractEffort(card({ customFields: { Team: 'Platform' } }))).toBeUndefined();
    expect(extractEffort(card({ customFields: { Effort: 'large' } }))).toBeUndefined();
  });
});

describe('scoreCard — one term at a time', () => {
  it('weights priority 4x', () => {
    expect(scoreCard(card({ customFields: { Priority: 'critical' } })).score).toBe(16);
    expect(scoreCard(card({ customFields: { Priority: 'high' } })).score).toBe(12);
    expect(scoreCard(card({ customFields: { Priority: 'medium' } })).score).toBe(8);
    expect(scoreCard(card({ customFields: { Priority: 'low' } })).score).toBe(4);
  });

  it('gives an overdue card 15 and says how late it is', () => {
    const { score, reasons } = scoreCard(card({ due: '2026-06-10T12:00:00.000Z' }));

    expect(score).toBe(15);
    expect(reasons).toEqual(['overdue by 5 days']);
  });

  it('gives 12 inside three days and 6 inside the week', () => {
    expect(scoreCard(card({ due: '2026-06-17T12:00:00.000Z' })).score).toBe(12);
    expect(scoreCard(card({ due: '2026-06-20T12:00:00.000Z' })).score).toBe(6);
  });

  it('scores nothing for a due date further out than a week', () => {
    const { score, reasons } = scoreCard(card({ due: '2026-07-15T12:00:00.000Z' }));

    expect(score).toBe(0);
    expect(reasons).toEqual(['available in queue']);
  });

  it('draws the urgency bands at 3 and 7 days, not around them', () => {
    // Exactly 3 days out falls to the weekly band; exactly 7 falls out entirely.
    expect(scoreCard(card({ due: '2026-06-18T12:00:00.000Z' })).score).toBe(6);
    expect(scoreCard(card({ due: '2026-06-22T12:00:00.000Z' })).score).toBe(0);
  });

  it('gives 3 for a quick win at effort 2 or below, nothing above', () => {
    expect(scoreCard(card({ customFields: { Effort: 1 } })).score).toBe(3);
    expect(scoreCard(card({ customFields: { Effort: 2 } })).score).toBe(3);
    expect(scoreCard(card({ customFields: { Effort: 3 } })).score).toBe(0);
  });

  it('gives 5 for work already in progress', () => {
    const { score, reasons } = scoreCard(card({ stage: 'active' }));

    expect(score).toBe(5);
    expect(reasons).toEqual(['already in progress']);
  });

  it('falls back to "available in queue" when no term fires', () => {
    expect(scoreCard(card({ stage: 'queued' }))).toEqual({ score: 0, reasons: ['available in queue'] });
  });

  it('sums every term and reports each as its own reason', () => {
    const { score, reasons } = scoreCard(
      card({
        stage: 'active',
        due: '2026-06-16T12:00:00.000Z',
        customFields: { Priority: 'high', Effort: 1 },
      }),
    );

    // 12 priority + 12 due-in-1-day + 3 quick win + 5 active
    expect(score).toBe(32);
    expect(reasons).toEqual([
      'priority: high',
      'due in 1 days',
      'quick win (effort: 1)',
      'already in progress',
    ]);
  });

  it('does not claim effort was unreadable on a card whose effort it read (#169 review)', () => {
    // A MIXED payload: one field the caller handed in by name, one the payload
    // names only by id. `fieldNamesUnavailable` answers about ANY id-shaped key,
    // so the joint sentence used to fire beside `quick win (effort: 1)` — the
    // reason contradicting the reason next to it, and the `effort: 1` on the row.
    // Not reachable where cards come off `GET /cards` (nothing there carries a
    // name), but reachable through any caller that hands names in, which is what
    // `customFieldMap` keeps `name` first for.
    const { reasons } = scoreCard(
      card({ customFields: { Effort: 1, zxMLxD4zx4tSwJr75: ['YLanLiuXKA8JpvEsX'] } }),
    );

    expect(reasons).toEqual(['priority unreadable — not weighted in this ranking', 'quick win (effort: 1)']);

    // The polarity: drop the readable effort and the joint sentence is right again.
    expect(scoreCard(card({ customFields: { zxMLxD4zx4tSwJr75: ['YLanLiuXKA8JpvEsX'] } })).reasons)
      .toEqual(['priority and effort unreadable — ranked on due date and stage only']);
  });
});

/**
 * The absence of a blocking term is a decision, not an oversight: #47 removed it
 * because scoring an edge without knowing whether the blocker is FINISHED is how
 * it was wrong before, and finding out costs a per-blocker read. This test is
 * what stops someone reinstating the penalty as an obvious-looking improvement.
 */
describe('scoreCard — blocking is deliberately not scored (#47)', () => {
  it('scores a heavily blocked card identically to an unblocked one', () => {
    const props = { stage: 'active' as const, customFields: { Priority: 'high' } };

    const unblocked = scoreCard(card(props));
    const blocked = scoreCard(card({ ...props, blockedBy: ['a', 'b', 'c', 'd', 'e'] }));

    expect(blocked).toEqual(unblocked);
    expect(blocked.reasons.join(' ')).not.toMatch(/block/i);
  });
});
