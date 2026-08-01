/**
 * `findTopBlockers` — issue #69.
 *
 * No wire seam here on purpose: the defect is entirely in-process ranking over
 * a snapshot that has already been fetched, so there is no 200-vs-silent-200
 * ambiguity for a stand-in to expose. What the caller observes IS this return
 * value — it is emitted verbatim as `topBlockers` / `unreachableBlockers`.
 */
import { findTopBlockers, formatHuman, OverviewResult } from '../../commands/overview';
import { AggregateCard } from '../../api/aggregate';

const card = (over: Partial<AggregateCard> & { id: string }): AggregateCard =>
  ({ title: `card ${over.id}`, ...over }) as AggregateCard;

describe('findTopBlockers', () => {
  it('ranks blockers that are in the fetched set, by edge count', () => {
    const cards = [
      card({ id: 'id-A', commonId: 'A', boardName: 'Board A' }),
      card({ id: 'id-B', commonId: 'B', boardName: 'Board A' }),
      card({ id: 'id-1', commonId: '1', blockedBy: ['A'] }),
      card({ id: 'id-2', commonId: '2', blockedBy: ['A', 'B'] }),
    ];

    const { topBlockers, unreachable } = findTopBlockers(cards);

    expect(topBlockers).toEqual([
      { id: 'id-A', title: 'card id-A', board: 'Board A', blockingCount: 2 },
      { id: 'id-B', title: 'card id-B', board: 'Board A', blockingCount: 1 },
    ]);
    expect(unreachable).toEqual([]);
  });

  it('reports a blocker outside the fetched set instead of dropping it', () => {
    const cards = [
      card({ id: 'id-1', commonId: '1', blockedBy: ['off-board'] }),
      card({ id: 'id-2', commonId: '2', blockedBy: ['off-board'] }),
      card({ id: 'id-3', commonId: '3', blockedBy: ['off-board'] }),
    ];

    const { topBlockers, unreachable } = findTopBlockers(cards);

    // Nothing rankable — and the caller is told that is not the same as none.
    expect(topBlockers).toEqual([]);
    expect(unreachable).toHaveLength(1);
    expect(unreachable[0].id).toBe('off-board');
    expect(unreachable[0].reason).toContain('blocks 3 card(s)');
  });

  it('a cross-board blocker outranking every local one is named, not silently ignored', () => {
    const cards = [
      card({ id: 'id-A', commonId: 'A', boardName: 'Board A' }),
      card({ id: 'id-1', commonId: '1', blockedBy: ['A'] }),
      card({ id: 'id-2', commonId: '2', blockedBy: ['cross'] }),
      card({ id: 'id-3', commonId: '3', blockedBy: ['cross'] }),
      card({ id: 'id-4', commonId: '4', blockedBy: ['cross'] }),
    ];

    const { topBlockers, unreachable } = findTopBlockers(cards);

    expect(topBlockers.map(b => b.id)).toEqual(['id-A']);
    expect(unreachable.map(u => u.id)).toEqual(['cross']);
  });

  it('an empty unreachable list with an empty ranking means there really are no blockers', () => {
    const { topBlockers, unreachable } = findTopBlockers([
      card({ id: 'id-1', commonId: '1' }),
      card({ id: 'id-2', commonId: '2' }),
    ]);

    expect(topBlockers).toEqual([]);
    expect(unreachable).toEqual([]);
  });

  it('caps the ranking at `count`; every unreachable blocker is still reported', () => {
    const cards: AggregateCard[] = [];
    for (let i = 0; i < 3; i += 1) cards.push(card({ id: `id-B${i}`, commonId: `B${i}` }));
    // Six blocked cards: three name a present blocker, three name absent ones.
    for (let i = 0; i < 3; i += 1) cards.push(card({ id: `id-x${i}`, commonId: `x${i}`, blockedBy: [`B${i}`] }));
    for (let i = 0; i < 3; i += 1) cards.push(card({ id: `id-y${i}`, commonId: `y${i}`, blockedBy: [`gone-${i}`] }));

    const { topBlockers, unreachable } = findTopBlockers(cards, 2);

    expect(topBlockers).toHaveLength(2);
    expect(unreachable.map(u => u.id).sort()).toEqual(['gone-0', 'gone-1', 'gone-2']);
  });
});

/**
 * The human render is a different contract from the return value above.
 * `findTopBlockers` must keep every unreachable blocker — dropping one is the
 * #69 defect. What a person reads must stay readable, and across ~20 boards
 * that list runs to hundreds of near-identical ~150-char lines. So: the data
 * stays whole and the render summarises, with the true total on the header line
 * either way.
 */
describe('formatHuman — the unreachable list', () => {
  const overview = (ids: string[]): OverviewResult => ({
    scope: 'all collections',
    boardCount: 20,
    totalCards: 400,
    boards: [],
    stageDistribution: {},
    topBlockers: [],
    ...(ids.length > 0
      ? { unreachableBlockers: ids.map(id => ({ id, reason: 'blocks 1 card(s) in this scope, …' })) }
      : {}),
    dueSummary: { overdue: 0, dueThisWeek: 0, dueNextWeek: 0, noDueDate: 400 },
    generatedAt: '2026-01-01T00:00:00.000Z',
  });

  const bullets = (out: string) => out.split('\n').filter(l => l.trimStart().startsWith('• '));

  it('names them all when there are few enough to read', () => {
    const out = formatHuman(overview(['g-0', 'g-1', 'g-2']));

    expect(bullets(out)).toHaveLength(3);
    expect(out).toContain('3 blocker(s) outside this scope');
    expect(out).not.toContain('more');
  });

  it('summarises the tail rather than printing 147 near-identical lines', () => {
    const out = formatHuman(overview(Array.from({ length: 147 }, (_, i) => `g-${i}`)));

    // The total is never lost — it is on the header line, which is what tells a
    // reader the ranking above is incomplete.
    expect(out).toContain('147 blocker(s) outside this scope');
    expect(bullets(out)).toHaveLength(5);
    expect(out).toContain('… +142 more (use --json for all)');
    // First named, last only counted.
    expect(out).toContain('g-0');
    expect(out).not.toContain('g-146');
  });
});
