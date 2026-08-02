/**
 * `scoreBoard` / `computeHealth` — issue #76.
 *
 * No wire seam: both are pure in-process arithmetic over an already-fetched
 * snapshot, and their output IS what the caller reads (`breakdown` is a public
 * `--json` field). The seam is therefore the exported function, called with card
 * fixtures and asserted against literal numbers.
 *
 * The formula is deliberately NOT restated here. The test file that #71 deleted
 * kept its own copy of `flow * 0.40 + …` and asserted against that, so it
 * survived #61's `blocked` → `dependencies` rename without a murmur. Every
 * expectation below is a hand-computed constant; if the weights or the
 * thresholds move, these fail.
 *
 * Both `scoreBoard` paths that read the clock (`daysSince`, the overdue check)
 * are pinned with a fixed system time — nothing here may depend on wall clock.
 *
 * Rounding direction is asserted, not assumed: every rounding site has a fixture
 * whose fraction sits off .5, so swapping any `Math.round` for `floor`/`ceil` —
 * or `daysSince`'s `Math.floor` — changes an asserted integer.
 */
import { scoreBoard, computeHealth, rollUp, BoardHealth } from '../../commands/health';
import { AggregateCard } from '../../api/aggregate';

const NOW = '2026-06-15T12:00:00.000Z';
const RECENT = '2026-06-10T00:00:00.000Z'; // 5 days old — not stale
const OLD = '2026-05-01T00:00:00.000Z';    // 45 days old — stale (>14)
const FUTURE = '2026-07-01T00:00:00.000Z';
const PAST = '2026-06-01T00:00:00.000Z';

const card = (over: Partial<AggregateCard> & { id: string }): AggregateCard =>
  ({ title: `card ${over.id}`, ...over }) as AggregateCard;

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date(NOW));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('scoreBoard — the four sub-scores', () => {
  it('scores each dimension independently off one board of four cards', () => {
    // 1 of 4 flowing, 2 of 4 fresh, 1 of 4 carrying an edge, 0 of 4 overdue.
    const cards = [
      card({ id: '1', stage: 'active', createdAt: RECENT, due: FUTURE }),
      card({ id: '2', stage: 'queued', createdAt: RECENT, due: FUTURE }),
      card({ id: '3', stage: 'queued', createdAt: OLD, due: FUTURE }),
      card({ id: '4', stage: 'queued', createdAt: OLD, due: FUTURE, blockedBy: ['X'] }),
    ];

    expect(scoreBoard(cards)).toEqual({ flow: 25, stale: 50, dependencies: 75, overdue: 100 });
  });

  it('counts a card as a dependency from `blockedBy`, not from any blocked flag (#61)', () => {
    const base = { stage: 'queued' as const, createdAt: RECENT };

    // Three non-done cards, two carrying an edge → 1 of 3 clean → 33.
    expect(
      scoreBoard([
        card({ id: '1', ...base, blockedBy: ['A'] }),
        card({ id: '2', ...base, blockedBy: ['A', 'B'] }),
        card({ id: '3', ...base }),
      ]).dependencies,
    ).toBe(33);

    // An empty array is not an edge.
    expect(
      scoreBoard([card({ id: '1', ...base, blockedBy: [] })]).dependencies,
    ).toBe(100);
  });

  it('excludes done cards from the flow/stale/dependency denominator', () => {
    // The done card is stale, blocked and overdue; none of it may count.
    const cards = [
      card({ id: 'done', stage: 'done', createdAt: OLD, due: PAST, blockedBy: ['X'] }),
      card({ id: 'live', stage: 'active', createdAt: RECENT, due: FUTURE }),
    ];

    expect(scoreBoard(cards)).toEqual({ flow: 100, stale: 100, dependencies: 100, overdue: 100 });
  });

  it('returns a clean sheet for an empty board rather than dividing by zero', () => {
    expect(scoreBoard([])).toEqual({ flow: 100, stale: 100, dependencies: 100, overdue: 100 });
  });

  it('returns a clean sheet when every card is done — the guards, not real 100s', () => {
    const cards = [
      card({ id: '1', stage: 'done', createdAt: OLD, due: PAST, blockedBy: ['X'] }),
      card({ id: '2', stage: 'approved', createdAt: OLD, due: PAST, blockedBy: ['X'] }),
      card({ id: '3', stage: 'archived', createdAt: OLD, due: PAST, blockedBy: ['X'] }),
    ];

    expect(scoreBoard(cards)).toEqual({ flow: 100, stale: 100, dependencies: 100, overdue: 100 });
    expect(computeHealth('all shipped', cards).totalCards).toBe(3);
  });

  it('scores overdue 100 when no live card carries a due date at all', () => {
    // withDue is empty, so "nothing overdue" is a guard rather than a measurement.
    expect(
      scoreBoard([
        card({ id: '1', stage: 'queued', createdAt: OLD }),
        card({ id: '2', stage: 'queued', createdAt: OLD }),
      ]),
    ).toEqual({ flow: 0, stale: 0, dependencies: 100, overdue: 100 });
  });

  it('still counts a missing or unparseable createdAt against the stale ratio', () => {
    // Unchanged by #130, and deliberately so. `daysSince` no longer answers
    // `Infinity` — it answers `undefined` — so this used to fall out of the
    // comparison and now falls out of an explicit branch in `scoreBoard`.
    // Whether an unassessable card *should* drag a board score down is open;
    // see the comment at that branch. What matters here is that the answer
    // stopped being an accident of arithmetic.
    expect(scoreBoard([card({ id: '1', stage: 'active' })]).stale).toBe(0);
    expect(scoreBoard([card({ id: '1', stage: 'active', createdAt: 'not a date' })]).stale).toBe(0);
  });

  it('draws the stale line above 14 days, not at it', () => {
    const at14 = '2026-06-01T12:00:00.000Z'; // exactly 14 days before NOW
    const at15 = '2026-05-31T12:00:00.000Z';

    expect(scoreBoard([card({ id: '1', stage: 'active', createdAt: at14 })]).stale).toBe(100);
    expect(scoreBoard([card({ id: '1', stage: 'active', createdAt: at15 })]).stale).toBe(0);
  });

  it('truncates a part-day age rather than rounding it up over the line', () => {
    // 14.5 days before NOW: a floored age is 14 and fresh, a ceilinged one 15 and stale.
    const at14AndAHalf = '2026-06-01T00:00:00.000Z';

    expect(scoreBoard([card({ id: '1', stage: 'active', createdAt: at14AndAHalf })]).stale).toBe(100);
  });

  it('rounds a one-third ratio down on every sub-score', () => {
    // 1 of 3 flowing / fresh / clean / on-time → 33.33 on all four, never 34.
    expect(
      scoreBoard([
        card({ id: '1', stage: 'active', createdAt: RECENT, due: FUTURE }),
        card({ id: '2', stage: 'queued', createdAt: OLD, due: PAST, blockedBy: ['X'] }),
        card({ id: '3', stage: 'queued', createdAt: OLD, due: PAST, blockedBy: ['X'] }),
      ]),
    ).toEqual({ flow: 33, stale: 33, dependencies: 33, overdue: 33 });
  });

  it('rounds a two-thirds ratio up on every sub-score', () => {
    // 2 of 3 flowing / fresh / clean / on-time → 66.67 on all four, never 66.
    expect(
      scoreBoard([
        card({ id: '1', stage: 'active', createdAt: RECENT, due: FUTURE }),
        card({ id: '2', stage: 'active', createdAt: RECENT, due: FUTURE }),
        card({ id: '3', stage: 'queued', createdAt: OLD, due: PAST, blockedBy: ['X'] }),
      ]),
    ).toEqual({ flow: 67, stale: 67, dependencies: 67, overdue: 67 });
  });

  it('counts review and testing as flowing stages', () => {
    // Neither stage is done, so both sit in the flow numerator and denominator.
    expect(
      scoreBoard([
        card({ id: '1', stage: 'review', createdAt: RECENT, due: FUTURE }),
        card({ id: '2', stage: 'testing', createdAt: RECENT, due: FUTURE }),
      ]).flow,
    ).toBe(100);

    // Paired against a non-flowing stage so the 100 above is a measurement, not a guard.
    expect(
      scoreBoard([
        card({ id: '1', stage: 'review', createdAt: RECENT, due: FUTURE }),
        card({ id: '2', stage: 'testing', createdAt: RECENT, due: FUTURE }),
        card({ id: '3', stage: 'queued', createdAt: RECENT, due: FUTURE }),
        card({ id: '4', stage: 'queued', createdAt: RECENT, due: FUTURE }),
      ]).flow,
    ).toBe(50);
  });
});

/**
 * The composite weighting, asserted as integers. Each fixture is chosen so the
 * four sub-scores are distinct, which is what makes a swapped or nudged weight
 * show up as a different total instead of cancelling out.
 */
describe('computeHealth — the weighted composite', () => {
  it('folds four distinct sub-scores into one integer', () => {
    const cards = [
      card({ id: '1', stage: 'active', createdAt: RECENT, due: FUTURE }),
      card({ id: '2', stage: 'queued', createdAt: RECENT, due: FUTURE }),
      card({ id: '3', stage: 'queued', createdAt: OLD, due: FUTURE }),
      card({ id: '4', stage: 'queued', createdAt: OLD, due: FUTURE, blockedBy: ['X'] }),
    ];

    const health = computeHealth('Board A', cards);

    expect(health.breakdown).toEqual({ flow: 25, stale: 50, dependencies: 75, overdue: 100 });
    expect(health.score).toBe(53); // 25/50/75/100 → 52.5, rounded up
    expect(health.name).toBe('Board A');
    expect(health.totalCards).toBe(4);
  });

  it('rounds a composite below the halfway point down', () => {
    // flow 33, everything else a clean 100 → 73.2, which must not become 74.
    const health = computeHealth('b', [
      card({ id: '1', stage: 'active', createdAt: RECENT }),
      card({ id: '2', stage: 'queued', createdAt: RECENT }),
      card({ id: '3', stage: 'queued', createdAt: RECENT }),
    ]);

    expect(health.breakdown).toEqual({ flow: 33, stale: 100, dependencies: 100, overdue: 100 });
    expect(health.score).toBe(73);
  });

  it('scores a perfect board 100 and a fully rotten one 0', () => {
    expect(
      computeHealth('good', [card({ id: '1', stage: 'active', createdAt: RECENT, due: FUTURE })]).score,
    ).toBe(100);
    expect(
      computeHealth('bad', [card({ id: '1', stage: 'queued', createdAt: OLD, due: PAST, blockedBy: ['X'] })]).score,
    ).toBe(0);
  });
});

/**
 * `score > 75 ? green : score >= 50 ? yellow : red` — asymmetric on purpose, so
 * both boundaries are pinned from both sides. The fixtures are built to land on
 * the exact integers 75/76/49/50; the comment on each names the sub-scores it
 * produces so the arithmetic is checkable without re-deriving the formula.
 */
describe('computeHealth — traffic-light boundaries', () => {
  it('calls exactly 75 yellow — the green test is strictly greater', () => {
    // flow 100, stale 0, deps 100, overdue 100 → 75
    const health = computeHealth('b', [
      card({ id: '1', stage: 'active', createdAt: OLD, due: FUTURE }),
    ]);

    expect(health.breakdown).toEqual({ flow: 100, stale: 0, dependencies: 100, overdue: 100 });
    expect(health.score).toBe(75);
    expect(health.signal).toBe('yellow');
  });

  it('calls 76 green', () => {
    // flow 100, stale 33, deps 100, overdue 50 → 75.75 → 76
    const health = computeHealth('b', [
      card({ id: '1', stage: 'active', createdAt: RECENT, due: FUTURE }),
      card({ id: '2', stage: 'active', createdAt: OLD, due: PAST }),
      card({ id: '3', stage: 'active', createdAt: OLD }),
    ]);

    expect(health.breakdown).toEqual({ flow: 100, stale: 33, dependencies: 100, overdue: 50 });
    expect(health.score).toBe(76);
    expect(health.signal).toBe('green');
  });

  it('calls exactly 50 yellow — the yellow test is greater-or-equal', () => {
    // flow 0, stale 100, deps 50, overdue 100 → 50
    const health = computeHealth('b', [
      card({ id: '1', stage: 'queued', createdAt: RECENT, due: FUTURE }),
      card({ id: '2', stage: 'queued', createdAt: RECENT, blockedBy: ['X'] }),
    ]);

    expect(health.breakdown).toEqual({ flow: 0, stale: 100, dependencies: 50, overdue: 100 });
    expect(health.score).toBe(50);
    expect(health.signal).toBe('yellow');
  });

  it('calls 49 red', () => {
    // flow 33, stale 33, deps 100, overdue 50 → 48.95 → 49
    const health = computeHealth('b', [
      card({ id: '1', stage: 'active', createdAt: RECENT, due: FUTURE }),
      card({ id: '2', stage: 'queued', createdAt: OLD, due: PAST }),
      card({ id: '3', stage: 'queued', createdAt: OLD }),
    ]);

    expect(health.breakdown).toEqual({ flow: 33, stale: 33, dependencies: 100, overdue: 50 });
    expect(health.score).toBe(49);
    expect(health.signal).toBe('red');
  });
});

/**
 * The rollup was inlined in the commander action until #76, where a reviewer
 * replaced its thresholds and flipped its sort with the whole suite still green.
 * Both now go through `rollUp`, and the signal rule lives in one helper shared
 * with `computeHealth` — so these thresholds and the per-board ones cannot drift.
 */
describe('rollUp — ordering and the overall signal', () => {
  const board = (name: string, score: number): BoardHealth =>
    ({ name, score } as BoardHealth);

  it('orders boards worst health first', () => {
    const { boards } = rollUp([board('mid', 60), board('good', 90), board('bad', 20)]);

    expect(boards.map(b => b.name)).toEqual(['bad', 'mid', 'good']);
  });

  it('averages the board scores unweighted and rounds to an integer', () => {
    expect(rollUp([board('a', 40), board('b', 41), board('c', 41)]).overallScore).toBe(41);
    expect(rollUp([board('a', 40), board('b', 40), board('c', 41)]).overallScore).toBe(40);
  });

  it('scores an empty scope 100 green rather than dividing by zero', () => {
    expect(rollUp([])).toEqual({ boards: [], overallScore: 100, overallSignal: 'green' });
  });

  it('calls an overall 76 green and an overall 75 yellow', () => {
    expect(rollUp([board('a', 76)]).overallSignal).toBe('green');
    expect(rollUp([board('a', 75)]).overallSignal).toBe('yellow');
  });

  it('calls an overall 50 yellow and an overall 49 red', () => {
    expect(rollUp([board('a', 50)]).overallSignal).toBe('yellow');
    expect(rollUp([board('a', 49)]).overallSignal).toBe('red');
  });
});
