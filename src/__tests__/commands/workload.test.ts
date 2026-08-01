/**
 * `buildWorkloads` / `extractEffort` — issue #76.
 *
 * The rollup used to live inline in the commander action, which left it
 * unreachable without a wire seam it does not need — it is pure aggregation over
 * an already-fetched snapshot. #76 lifted it into `buildWorkloads`; this file is
 * the reason. The threshold itself is not restated: the deleted test's version of
 * this assertion was `expect(9 > 8).toBe(true)`, which tested JavaScript.
 */
import { buildWorkloads, extractEffort } from '../../commands/workload';
import { AggregateCard } from '../../api/aggregate';

const card = (over: Partial<AggregateCard> & { id: string }): AggregateCard =>
  ({ title: `card ${over.id}`, ...over }) as AggregateCard;

const activeCards = (n: number, uid: string): AggregateCard[] =>
  Array.from({ length: n }, (_, i) => card({ id: `${uid}-${i}`, stage: 'active', assignees: [uid] }));

const MEMBERS = [
  { id: 'u1', name: 'Ada', email: 'ada@example.com' },
  { id: 'u2', name: 'Linus', email: 'linus@example.com' },
];

describe('extractEffort', () => {
  it('reads a number off any field whose name suggests an estimate', () => {
    expect(extractEffort(card({ id: '1', customFields: { Effort: 5 } }))).toBe(5);
    expect(extractEffort(card({ id: '1', customFields: { 'Story Points': '3' } }))).toBe(3);
    expect(extractEffort(card({ id: '1', customFields: { Estimate: 8 } }))).toBe(8);
  });

  it('falls back to 0 rather than undefined — this one feeds a running sum', () => {
    expect(extractEffort(card({ id: '1' }))).toBe(0);
    expect(extractEffort(card({ id: '1', customFields: { Team: 'Platform' } }))).toBe(0);
    expect(extractEffort(card({ id: '1', customFields: { Effort: 'large' } }))).toBe(0);
  });
});

describe('buildWorkloads — overload threshold', () => {
  it('does not flag a member sitting on 8 active cards', () => {
    const { members, alerts } = buildWorkloads(activeCards(8, 'u1'), MEMBERS);

    expect(members[0].activeCards).toBe(8);
    expect(members[0].overloaded).toBe(false);
    expect(alerts).toEqual([]);
  });

  it('flags a member the moment a 9th active card lands', () => {
    const { members, alerts } = buildWorkloads(activeCards(9, 'u1'), MEMBERS);

    expect(members[0].overloaded).toBe(true);
    expect(alerts).toEqual(['Ada has 9 active cards (threshold: 8)']);
  });

  it('counts only active/review/testing towards the threshold', () => {
    const cards = [
      card({ id: '1', stage: 'active', assignees: ['u1'] }),
      card({ id: '2', stage: 'review', assignees: ['u1'] }),
      card({ id: '3', stage: 'testing', assignees: ['u1'] }),
      card({ id: '4', stage: 'backlog', assignees: ['u1'] }),
      card({ id: '5', stage: 'queued', assignees: ['u1'] }),
      card({ id: '6', stage: 'done', assignees: ['u1'] }),
      card({ id: '7', assignees: ['u1'] }),
    ];

    const { members } = buildWorkloads(cards, MEMBERS);

    expect(members[0].activeCards).toBe(3);
    expect(members[0].totalCards).toBe(7);
  });
});

describe('buildWorkloads — per-member rollup', () => {
  it('sums effort across a member\'s cards', () => {
    const cards = [
      card({ id: '1', assignees: ['u1'], customFields: { Effort: 5 } }),
      card({ id: '2', assignees: ['u1'], customFields: { 'Story Points': '2' } }),
      card({ id: '3', assignees: ['u1'] }), // no estimate — contributes 0, not NaN
    ];

    expect(buildWorkloads(cards, MEMBERS).members[0].totalEffort).toBe(7);
  });

  it('counts dependency cards off `blockedBy`, one per card regardless of edge count (#61)', () => {
    const cards = [
      card({ id: '1', assignees: ['u1'], blockedBy: ['a'] }),
      card({ id: '2', assignees: ['u1'], blockedBy: ['a', 'b', 'c'] }),
      card({ id: '3', assignees: ['u1'], blockedBy: [] }),
      card({ id: '4', assignees: ['u1'] }),
    ];

    const { members } = buildWorkloads(cards, MEMBERS);

    expect(members[0].dependencyCards).toBe(2);
    expect(members[0].totalCards).toBe(4);
  });

  it('buckets a card with no assignees under "unassigned"', () => {
    const cards = [
      card({ id: '1', stage: 'active', assignees: ['u1'] }),
      card({ id: '2' }),
      card({ id: '3', assignees: [] }),
    ];

    const { members } = buildWorkloads(cards, MEMBERS);
    const unassigned = members.find(m => m.name === 'unassigned');

    // No member record matches, so the bucket id doubles as its name and the
    // email stays empty rather than becoming the string "undefined".
    expect(unassigned).toMatchObject({ name: 'unassigned', email: '', totalCards: 2 });
  });

  it('counts a card once per assignee when it is shared', () => {
    const cards = [card({ id: '1', stage: 'active', assignees: ['u1', 'u2'] })];

    const { members } = buildWorkloads(cards, MEMBERS);

    expect(members).toHaveLength(2);
    expect(members.map(m => m.totalCards)).toEqual([1, 1]);
  });

  it('names an unknown assignee id after itself rather than dropping the work', () => {
    const { members } = buildWorkloads([card({ id: '1', assignees: ['ghost'] })], MEMBERS);

    expect(members[0]).toMatchObject({ name: 'ghost', email: '', totalCards: 1 });
  });

  it('sorts busiest-first by active cards', () => {
    const cards = [
      ...activeCards(2, 'u1'),
      ...activeCards(5, 'u2'),
      card({ id: 'idle', assignees: ['ghost'] }),
    ];

    const { members } = buildWorkloads(cards, MEMBERS);

    expect(members.map(m => m.name)).toEqual(['Linus', 'Ada', 'ghost']);
  });

  it('carries the per-card detail a caller reads out of --json', () => {
    const cards = [
      card({ id: 'c-9', title: 'ship it', stage: 'review', assignees: ['u1'], boardName: 'Board A' } as any),
    ];

    expect(buildWorkloads(cards, MEMBERS).members[0].cards).toEqual([
      { id: 'c-9', title: 'ship it', stage: 'review', board: 'Board A' },
    ]);
  });

  it('returns nothing for an empty snapshot', () => {
    expect(buildWorkloads([], MEMBERS)).toEqual({ members: [], alerts: [] });
  });
});
