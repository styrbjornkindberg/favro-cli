/**
 * A card living on TWO boards of one collection, counted against a real server
 * (#167 item 3).
 *
 * `AggregateAPI`'s collection sweep used to read `GET /cards` with
 * `unique: true`, which collapses a card's N board instances to one arbitrary
 * row; the per-board filter then attributed that row to exactly one board and
 * every OTHER board the card sits on came back short by one, in `totalCards` and
 * in `stageDistribution` alike.
 *
 * Real `node:http`, and this is the one seam that can express the defect: the
 * stand-in below HONOURS `unique` — collapsing to the first entity per
 * `cardCommonId` — so restoring `unique: true` in `aggregate.ts` reddens the
 * counts here. A queued mock hands back the same canned rows whatever the query
 * string said, so under one it would pass either way.
 *
 * The polarity is paired on purpose. A fixture whose every card lives on one
 * board cannot exercise the collapse at all; the previous investigation ran
 * exactly that and could conclude nothing from the green. So the shared card
 * must count on BOTH boards, and the solo card must count ONCE and not twice —
 * an over-counting fix reddens the second half.
 */
import http from 'http';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import { apiNamespace, Ctx } from '../lib/run';
import { overviewHandler } from '../commands/overview';
import { workloadHandler } from '../commands/workload';
import { teamHandler } from '../commands/team';
import { nextHandler } from '../commands/next';
import { tempConfigDir } from '../test-support/config-dir';

const ORG = 'org-1';
const USER = 'user-1';

const COLL = 'coll-1';
const ONE = 'board-one';
const TWO = 'board-two';

// `next` resolves the caller through `resolveUserId()`, which reads this file.
tempConfigDir('favro-aggregate-multi-board-test-', { userId: USER });

/** Every server this file started, so a failed assertion cannot leak one. */
const running: http.Server[] = [];

interface Wire {
  /**
   * Add a row matching no board — an entity with no `widgetCommonId`, the shape
   * a FORK has (`CONTEXT.md`, `widgets-api.ts`) — served FIRST, so a `unique`
   * read collapses onto it.
   *
   * The live collection sweep does NOT serve this row: measured 2026-08-14 on
   * the #105 scratch collection, `GET /cards?collectionId=X` came back with
   * eleven rows and not one lacking a `widgetCommonId`, on a collection holding
   * a card whose card-scoped query does return a fork. So this is a stand-in for
   * an unattributable row rather than a claim about the wire, and what it pins
   * is what the code does with one.
   */
  fork?: boolean;
  /**
   * Put a blocker card on board one and point BOTH instances of the shared card
   * at it, which is what the wire does: a blocking edge is card-level, so every
   * instance of a blocked card inlines the same one.
   */
  blocker?: boolean;
  /**
   * Assign every card to one member and give each a card-level `Effort` of 5 —
   * the per-member rollups' polarity fixture.
   *
   * It also moves the SHARED card into the active column on BOTH boards, so
   * `activeCards` / `wipCount` do not depend on which instance the rollup meets
   * first. That ordering is a real ceiling (see `workload.ts`) and pinning it
   * here would freeze an arbitrary choice as a contract.
   */
  assigned?: boolean;
}

/**
 * A Favro stand-in for one collection holding two boards and two cards:
 *
 *   - `Shared` sits on BOTH boards — two entities, one `cardCommonId`, each
 *     with its own `cardId`, `widgetCommonId` and column. This is the card the
 *     collapse used to lose.
 *   - `Solo` sits on board one only, and is the other half of the polarity.
 */
function startServer(wire: Wire = {}): Promise<FavroHttpClient> {
  const columnsOf = (boardId: string) => [
    { columnId: `${boardId}-todo`, name: 'To Do', position: 0, widgetCommonId: boardId },
    { columnId: `${boardId}-doing`, name: 'In Progress', position: 1, widgetCommonId: boardId },
  ];

  const links = wire.blocker
    ? [{ cardId: 'blocker-on-one', cardCommonId: 'cc-blocker', isBefore: true }]
    : undefined;

  const mine = wire.assigned
    ? { assignments: [{ userId: USER }], customFields: [{ name: 'Effort', value: 5 }] }
    : {};
  const sharedColumn = (boardId: string) =>
    wire.assigned ? `${boardId}-doing` : `${boardId}-${boardId === ONE ? 'todo' : 'doing'}`;

  const allCards = () => {
    const entities: Array<Record<string, unknown>> = [];
    if (wire.fork) {
      entities.push({ cardId: 'shared-fork', cardCommonId: 'cc-shared', name: 'Shared', links });
    }
    entities.push(
      {
        cardId: 'shared-on-one',
        cardCommonId: 'cc-shared',
        name: 'Shared',
        widgetCommonId: ONE,
        columnId: sharedColumn(ONE),
        links,
        ...mine,
      },
      {
        cardId: 'shared-on-two',
        cardCommonId: 'cc-shared',
        name: 'Shared',
        widgetCommonId: TWO,
        columnId: sharedColumn(TWO),
        links,
        ...mine,
      },
      {
        cardId: 'solo-on-one',
        cardCommonId: 'cc-solo',
        name: 'Solo',
        widgetCommonId: ONE,
        columnId: `${ONE}-todo`,
        ...mine,
      },
    );
    if (wire.blocker) {
      entities.push({
        cardId: 'blocker-on-one',
        cardCommonId: 'cc-blocker',
        name: 'Blocker',
        widgetCommonId: ONE,
        columnId: `${ONE}-todo`,
      });
    }
    return entities;
  };

  /**
   * `unique=true`, as documented: "Return unique cards only". One row per
   * `cardCommonId`, and the survivor is the first served — Favro documents no
   * ordering at all, so first-wins is this stand-in's choice, not a claim about
   * the wire. Which row survives is exactly what the fix stops mattering.
   */
  const served = (url: URL) => {
    const entities = allCards();
    if (url.searchParams.get('unique') !== 'true') return entities;
    const seen = new Set<string>();
    return entities.filter((c) => {
      const common = c.cardCommonId as string;
      if (seen.has(common)) return false;
      seen.add(common);
      return true;
    });
  };

  const ok = (res: http.ServerResponse, entities: unknown[]) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ entities, requestId: 'req-1', page: 0, pages: 1 }));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://x');
    const p = url.pathname;

    if (p === `/api/v1/collections/${COLL}`) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ collectionId: COLL, name: 'Delivery', createdAt: '', updatedAt: '' }));
      return;
    }
    if (p === '/api/v1/collections') {
      return ok(res, [{ collectionId: COLL, name: 'Delivery' }]);
    }
    if (p === '/api/v1/widgets') {
      return ok(res, [ONE, TWO].map(id => ({
        widgetCommonId: id,
        name: id,
        collectionIds: [COLL],
        createdAt: '',
        updatedAt: '',
      })));
    }
    if (p === '/api/v1/columns') {
      return ok(res, columnsOf(url.searchParams.get('widgetCommonId') ?? ''));
    }
    if (p === '/api/v1/cards') {
      return ok(res, served(url));
    }
    if (p === '/api/v1/users') {
      return ok(res, [{ userId: USER, name: 'Ada', email: 'ada@example.com' }]);
    }
    return ok(res, []);
  });
  running.push(server);

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(new FavroHttpClient({
        baseURL: `http://127.0.0.1:${port}/api/v1`,
        auth: { organizationId: ORG },
      }));
    });
  });
}

/** A `Ctx` scoped to the one collection, so `overview` takes its aggregate arm. */
function ctxFor(client: FavroHttpClient): Ctx {
  return {
    client,
    config: { scopeCollectionId: COLL, scopeCollectionName: 'Delivery' } as Ctx['config'],
    verbose: false,
    api: apiNamespace(client),
  };
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise((done) => s.close(() => done(null)))));
});

describe('a card on two boards is counted on both (#167 item 3)', () => {
  it('the stand-in really collapses on `unique`, so the arms below are not a null test', async () => {
    const client = await startServer();

    const whole = await client.get<{ entities: Array<{ cardId: string }> }>(
      '/cards', { params: { collectionId: COLL } });
    const collapsed = await client.get<{ entities: Array<{ cardId: string }> }>(
      '/cards', { params: { collectionId: COLL, unique: true } });

    expect(whole.entities.map(e => e.cardId))
      .toEqual(['shared-on-one', 'shared-on-two', 'solo-on-one']);
    // One row for `cc-shared`, and the OTHER board's instance is simply gone.
    // That row is what every per-board count below used to be filtered from.
    expect(collapsed.entities.map(e => e.cardId)).toEqual(['shared-on-one', 'solo-on-one']);
  });

  it('overview counts the shared card on both boards and the solo card once', async () => {
    const client = await startServer();
    const result = await overviewHandler(ctxFor(client), {});

    const byName = Object.fromEntries(result.item.boards.map(b => [b.name, b]));
    // THE regression. Under `unique: true` board two came back with `totalCards: 0`
    // and no entry at all, because its only card had been collapsed onto board one.
    expect(byName[ONE].totalCards).toBe(2);
    expect(byName[TWO].totalCards).toBe(1);

    // The other polarity: the solo card is counted ONCE. An over-counting fix —
    // attributing every instance to every board — reddens here rather than above.
    expect(byName[ONE].stageDistribution).toEqual({ backlog: 2 });
    expect(byName[TWO].stageDistribution).toEqual({ active: 1 });

    // The census sums to the same instance set it partitions. `stageDistribution`
    // is rendered as a percentage OF `totalCards` (`formatHuman`), so the two
    // cannot count different things.
    expect(result.item.totalCards).toBe(3);
    expect(result.item.stageDistribution).toEqual({ backlog: 2, active: 1 });
    expect(result.item.boardCount).toBe(2);
  });

  it('each instance is stage-counted where it actually sits, not where one row said', async () => {
    // The shared card is in `To Do` on board one and `In Progress` on board two.
    // A collapse does not merely lose a count — it reports the survivor's column
    // as the card's state everywhere, which is the softer half of the same lie.
    const client = await startServer();
    const snapshot = await apiNamespace(client).aggregate
      .getMultiBoardSnapshot({ collectionIds: [COLL] });

    const shared = snapshot.allCards.filter(c => c.commonId === 'cc-shared');
    expect(shared.map(c => [c.boardName, c.stage])).toEqual([[ONE, 'backlog'], [TWO, 'active']]);
    expect(snapshot.stats.by_board).toEqual({ [ONE]: 2, [TWO]: 1 });
  });

  it('a row matching no board is dropped rather than counted, and costs the card no board', async () => {
    // A fork carries no `widgetCommonId`, so it matches no board's filter. Served
    // FIRST here, which is what a `unique` read collapses onto — measured 10/10
    // on a card-scoped query — and that would take the card off the report
    // entirely, on BOTH boards. Without `unique` it is a row nothing claims.
    // See `Wire.fork`: the collection sweep was measured not to serve one.
    const client = await startServer({ fork: true });
    const result = await overviewHandler(ctxFor(client), {});

    expect(result.item.boards.map(b => [b.name, b.totalCards])).toEqual([[ONE, 2], [TWO, 1]]);
    expect(result.item.totalCards).toBe(3);
    // Not bucketed under `Unknown` either: a row matching no board never reaches
    // `allCards`, and that bucket keys on a missing board NAME.
    expect(result.item.boards.some(b => b.name === 'Unknown')).toBe(false);
  });

  it('a card on two boards is ONE work item in the per-member rollups', async () => {
    // The other side of the partition, and the one the census reasoning does not
    // reach. Ada holds two work items — `Shared` on both boards, `Solo` on one —
    // each estimated at 5. Effort is the unarguable number: one card-level custom
    // field holding one number, so 15 would be reporting half again the work that
    // exists. `activeCards` is the other half of the pair, because it gates
    // `OVERLOAD_THRESHOLD` and an inflated one raises `⚠ OVERLOADED` on somebody
    // who is not.
    const client = await startServer({ assigned: true });
    const ctx = ctxFor(client);

    const workload = await workloadHandler(ctx, {});
    const ada = workload.item.members.find(m => m.name === 'Ada')!;
    expect(ada.totalEffort).toBe(10);
    expect(ada.totalCards).toBe(2);
    expect(ada.activeCards).toBe(1);
    expect(workload.item.alerts).toEqual([]);
    // …while `cards[]` stays per-INSTANCE: it names the board, and the shared
    // card really is two places she can go.
    expect(ada.cards.map(c => [c.id, c.board])).toEqual([
      ['shared-on-one', ONE], ['solo-on-one', ONE], ['shared-on-two', TWO],
    ]);

    const team = await teamHandler(ctx, {});
    const member = team.item.members.find(m => m.name === 'Ada')!;
    expect(member.effortSum).toBe(10);
    expect(member.totalCards).toBe(2);
    expect(member.wipCount).toBe(1);
    expect(member.doneCount).toBe(0);
    // `activeBoards` is the one field the un-collapsed read IMPROVED — before the
    // fix the shared card put her on one board; she is on two.
    expect(member.activeBoards).toEqual([ONE, TWO]);
    // wip + done stay a partition of `totalCards`, which this divides by.
    expect(member.completionRate).toBe(0);
  });

  it('next spends one slot per work item, not one per board', async () => {
    // Both instances carry the same title, due, priority and effort, so they
    // score identically and sort adjacently — two of five slots on one thing an
    // agent reads as its five most important.
    const client = await startServer({ assigned: true });
    const result = await nextHandler(ctxFor(client), { count: '5' });

    expect(result.item.suggestions.map(s => s.title)).toEqual(['Shared', 'Solo']);
    expect(result.item.total).toBe(2);
    // The surviving instance keeps a board, so the pick still says where to go.
    expect(result.item.suggestions[0].board).toBe(ONE);
  });

  it('a blocker of a two-board card blocks ONE card, not two', async () => {
    // The number that must NOT follow the instance count. Both instances of the
    // shared card inline the same edge, so an edge tally would say the blocker
    // blocks two cards; it blocks one card that sits on two boards.
    const client = await startServer({ blocker: true });
    const result = await overviewHandler(ctxFor(client), {});

    expect(result.item.topBlockers).toEqual([
      { id: 'blocker-on-one', title: 'Blocker', board: ONE, blockingCount: 1 },
    ]);
    expect('unreachable' in result.item).toBe(false);
  });
});
