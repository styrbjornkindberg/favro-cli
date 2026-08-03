/**
 * A failed sub-read of an aggregate snapshot, against a real server (#148).
 *
 * `AggregateAPI.getMultiBoardSnapshot` fans out per board and per collection,
 * and two of those calls used to fall behind a bare `.catch(() => [])`. The
 * columns one is the dangerous half: no columns means no `stage` on any card of
 * that board, and every stage predicate in the codebase reads a missing stage
 * as "not done", "not active", "not flowing" — so `health` scored the board
 * `flow: 0` and printed it RED off a read that never happened.
 *
 * Real `node:http`, not queued mocks, and deliberately: the whole point is that
 * ONE board's `/columns` 500s while the other's succeeds. A queued mock hands
 * back the next canned response whatever was asked for, so it cannot express
 * "this board, not that one" — it would pass against a snapshot that lost the
 * wrong board's columns, or both.
 */
import http from 'http';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import { apiNamespace, Ctx } from '../lib/run';
import { healthHandler } from '../commands/health';
import { workloadHandler } from '../commands/workload';
import { teamHandler } from '../commands/team';
import { staleHandler } from '../commands/stale';

const ORG = 'org-1';
const COLL = 'coll-1';
const GOOD = 'board-good';
const DARK = 'board-dark';

/** Every server this file started, so a failed assertion cannot leak one. */
const running: http.Server[] = [];

interface Wire {
  /** Board ids whose `/columns` read fails. */
  failColumnsFor?: string[];
  /** Fail `/users` as well. */
  failMembers?: boolean;
  /** Serve an empty `/cards` — a real scope that simply holds no cards yet. */
  noCards?: boolean;
  /**
   * Only these boards hold cards; the others are real, readable and empty.
   * Lets a test put the ONLY populated board behind a failed columns read.
   */
  cardsOnlyFor?: string[];
  /**
   * The refusal status. 403 by default and NOT for want of realism: the client
   * retries any 5xx four times with 1s/2s/4s/8s backoff, so every 500 in this
   * file would cost 15 real seconds. The code path under test is identical —
   * `orElse` catches whatever `listColumns` throws — so the status only decides
   * how long the suite takes. The `500s` test below pays the 15s once,
   * deliberately, because a retried 5xx is the failure the ticket describes and
   * something has to walk it end to end. Same reason
   * `blocking-frontier-wire.test.ts` and `tracker-init-wire.test.ts` refuse
   * with 403.
   */
  status?: number;
}

/**
 * A Favro stand-in for one collection holding two boards, thirteen cards each.
 *
 * Both boards have the same three columns and the same card layout, so the
 * ONLY difference the assertions can be reading is which board's `/columns`
 * the server refused.
 */
function startServer(wire: Wire = {}): Promise<FavroHttpClient> {
  const columnsOf = (boardId: string) => [
    { columnId: `${boardId}-todo`, name: 'To Do', position: 0, widgetCommonId: boardId },
    { columnId: `${boardId}-doing`, name: 'In Progress', position: 1, widgetCommonId: boardId },
    { columnId: `${boardId}-done`, name: 'Done', position: 2, widgetCommonId: boardId },
  ];

  // A board in genuinely good shape, shaped so the bug is visible rather than
  // merely present: ten cards finished long ago and three fresh ones actively
  // in progress. Scored properly that is 100/green — `nonDone` is the three
  // in-progress cards, all flowing, all recent.
  //
  // With the columns read swallowed, NOTHING has a stage: `nonDone` becomes all
  // thirteen, `flowing` becomes 0, and the ten old DONE cards are re-read as
  // ten stale open cards. flow 0, stale 23 → score 41 → **red**. A finished,
  // healthy board reported as failing, off an HTTP call that never landed.
  const card = (boardId: string, i: number, column: string, ageDays: number) => ({
    cardId: `${boardId}-c${i}`,
    cardCommonId: `${boardId}-cc${i}`,
    name: `${boardId} card ${i}`,
    widgetCommonId: boardId,
    columnId: `${boardId}-${column}`,
    assignments: [{ userId: 'user-1' }],
    createdAt: new Date(Date.now() - ageDays * 86400000).toISOString(),
  });
  const cardsOf = (boardId: string) => [
    ...Array.from({ length: 10 }, (_, i) => card(boardId, i, 'done', 60)),
    ...Array.from({ length: 3 }, (_, i) => card(boardId, 10 + i, 'doing', 0)),
  ];

  const ok = (res: http.ServerResponse, entities: unknown[]) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ entities, requestId: 'req-1', page: 0, pages: 1 }));
  };

  const refuse = (res: http.ServerResponse) => {
    res.writeHead(wire.status ?? 403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'the columns read failed' }));
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
      return ok(res, [GOOD, DARK].map(id => ({
        widgetCommonId: id,
        name: id,
        collectionIds: [COLL],
        createdAt: '',
        updatedAt: '',
      })));
    }
    if (p === '/api/v1/columns') {
      const boardId = url.searchParams.get('widgetCommonId') ?? '';
      if (wire.failColumnsFor?.includes(boardId)) return refuse(res);
      return ok(res, columnsOf(boardId));
    }
    if (p === '/api/v1/cards') {
      if (wire.noCards) return ok(res, []);
      return ok(res, (wire.cardsOnlyFor ?? [GOOD, DARK]).flatMap(cardsOf));
    }
    if (p === '/api/v1/users') {
      if (wire.failMembers) return refuse(res);
      return ok(res, [{ userId: 'user-1', name: 'Ada', email: 'ada@example.com' }]);
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

/** A `Ctx` scoped to the one collection, so every handler takes its aggregate arm. */
function ctxFor(client: FavroHttpClient): Ctx {
  return {
    client,
    config: { scopeCollectionId: COLL, scopeCollectionName: 'Delivery' } as Ctx['config'],
    verbose: false,
    api: apiNamespace(client),
  };
}

const originalConfigDir = process.env.FAVRO_CONFIG_DIR;
let tmpDir: string;

beforeEach(async () => {
  // The name cache is a real file — give each test its own, so a run never
  // reads or clobbers the developer's own ~/.favro cache.
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-aggregate-hole-test-'));
  process.env.FAVRO_CONFIG_DIR = tmpDir;
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise((done) => s.close(() => done(null)))));
  if (originalConfigDir === undefined) delete process.env.FAVRO_CONFIG_DIR;
  else process.env.FAVRO_CONFIG_DIR = originalConfigDir;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** No options: `--limit` is gone from these commands, so scope is all there is. */
const NO_OPTS = {};

describe('a 500 on one board\'s columns is recorded, not swallowed (#148)', () => {
  it('the snapshot names the dark board and leaves the good one whole', async () => {
    const client = await startServer({ failColumnsFor: [DARK] });
    const snapshot = await apiNamespace(client).aggregate.getMultiBoardSnapshot({ collectionIds: [COLL] });

    expect(snapshot.unreachable).toEqual([
      { id: `columns:${DARK}`, reason: expect.stringMatching(/./) },
    ]);
    // The good board still resolved its stages — one dead sub-fetch must not
    // cost the caller the boards that answered.
    expect(snapshot.allCards.filter(c => c.boardId === GOOD).every(c => c.stage)).toBe(true);
    expect(snapshot.allCards.filter(c => c.boardId === DARK).every(c => c.stage === undefined)).toBe(true);
  });

  it('a fully-successful read emits NO unreachable key at all', async () => {
    const client = await startServer();
    const snapshot = await apiNamespace(client).aggregate.getMultiBoardSnapshot({ collectionIds: [COLL] });

    // `toBeUndefined` is not enough: absent must be distinguishable from empty,
    // so the KEY itself has to be missing.
    expect('unreachable' in snapshot).toBe(false);
  });

  it('a failed members read is recorded too, under its own id', async () => {
    const client = await startServer({ failMembers: true });
    const snapshot = await apiNamespace(client).aggregate.getMultiBoardSnapshot({ collectionIds: [COLL] });

    expect(snapshot.unreachable?.map(h => h.id)).toEqual([`members:${COLL}`]);
    expect(snapshot.members).toEqual([]);
  });
});

describe('health does not report a red board off a read that failed (#148)', () => {
  it('omits the dark board, names the hole, and refuses exit 0', async () => {
    const client = await startServer({ failColumnsFor: [DARK] });
    const result = await healthHandler(ctxFor(client), NO_OPTS);

    // THE regression, in the ticket's own words: no board is reported red on
    // no information. Before the fix `boards[]` carried
    // `{ name: 'board-dark', score: 41, signal: 'red' }`.
    expect(result.item.boards.some(b => b.signal === 'red')).toBe(false);
    expect(result.item.boards.map(b => b.name)).toEqual([GOOD]);

    // …and the board that WAS readable is scored honestly, not suppressed.
    expect(result.item.boards[0]).toMatchObject({ score: 100, signal: 'green' });
    expect(result.item.unreachable?.map(h => h.id)).toEqual([`columns:${DARK}`]);
    expect(result.exitCode).toBe(1);

    // Human mode says the same thing — the hole `risks --human` used to hide.
    expect(result.human(result.item)).toContain(`columns:${DARK}`);
  });

  /**
   * The acceptance criterion, walked with a real 500 rather than the 403 the
   * rest of the file refuses with. Slow on purpose: the client retries a 5xx
   * four times at 1s/2s/4s/8s, so this exercises the whole retry ladder
   * exhausting itself and STILL landing in `orElse` rather than throwing the
   * command over — which is the shape of the outage the ticket describes.
   */
  it('500s (retries exhausted) — still no red board on no information', async () => {
    const client = await startServer({ failColumnsFor: [DARK], status: 500 });
    const result = await healthHandler(ctxFor(client), NO_OPTS);

    expect(result.item.boards.some(b => b.signal === 'red')).toBe(false);
    expect(result.item.boards.map(b => b.name)).toEqual([GOOD]);
    expect(result.item.unreachable?.map(h => h.id)).toEqual([`columns:${DARK}`]);
    expect(result.exitCode).toBe(1);
  }, 40000);

  it('refuses outright when every board in scope went dark', async () => {
    const client = await startServer({ failColumnsFor: [GOOD, DARK] });

    // An empty `boards[]` rolls up to 100/green, so omission alone would print
    // "we read nothing" as "all clear".
    await expect(healthHandler(ctxFor(client), NO_OPTS))
      .rejects.toThrow(/every board that holds cards went dark/);
  });

  it('refuses with a TRUE reason when the only populated board went dark', async () => {
    // `board-good` is readable and simply empty; `board-dark` holds every card
    // and its columns read failed. The guard still fires — there is nothing
    // scoreable — but the old wording said "no board in scope could be read",
    // which is false: `board-good` was read perfectly. Same class of false
    // statement the members case above already guards against.
    const client = await startServer({ failColumnsFor: [DARK], cardsOnlyFor: [DARK] });

    await expect(healthHandler(ctxFor(client), NO_OPTS))
      .rejects.toThrow(/every board that holds cards went dark/);
  });

  it('does NOT refuse when the scope is simply empty and only members went dark', async () => {
    const client = await startServer({ failMembers: true, noCards: true });

    // The refusal has to key on boards actually dropped, not on `unreachable`
    // being non-empty. A members hole drops no board, so "no board in scope
    // could be read" would be a false statement about a scope that read fine
    // and holds nothing.
    const result = await healthHandler(ctxFor(client), NO_OPTS);
    expect(result.item.boards).toEqual([]);
    expect(result.item.unreachable?.map(h => h.id)).toEqual([`members:${COLL}`]);
    // And no exit code either. `health` never reads `snapshot.members`, so this
    // report covers its scope exactly — the hole is worth PRINTING and worth
    // nothing else. The first cut exited 1 here, which is the same defect as
    // the false refusal reason two tests up: one condition ("something was
    // unreadable") standing in for a narrower one ("something this command
    // needed was unreadable").
    expect('exitCode' in result).toBe(false);
  });

  it('exits 1 for a columns hole that costs a board, and not for a members hole that costs nothing', async () => {
    // The pair, side by side — an exit code that fires on both carries no
    // information, which is what #117 measured on `risks` before it shipped.
    const costly = await startServer({ failColumnsFor: [DARK] });
    expect((await healthHandler(ctxFor(costly), NO_OPTS)).exitCode).toBe(1);

    const free = await startServer({ failMembers: true });
    const harmless = await healthHandler(ctxFor(free), NO_OPTS);
    expect('exitCode' in harmless).toBe(false);
    // Still scored, and scored off complete data — that is why it costs nothing.
    expect(harmless.item.boards.map(b => b.name).sort()).toEqual([DARK, GOOD]);
    expect(harmless.item.unreachable?.map(h => h.id)).toEqual([`members:${COLL}`]);
  });

  it('a clean read scores every board, emits no unreachable key, and exits 0', async () => {
    const client = await startServer();
    const result = await healthHandler(ctxFor(client), NO_OPTS);

    expect(result.item.boards.map(b => b.name).sort()).toEqual([DARK, GOOD]);
    expect('unreachable' in result.item).toBe(false);
    // Not `toBe(0)`: a complete report says nothing about the exit code at all,
    // so the runner leaves `process.exitCode` alone. `health` is not an
    // answer-code command on the clean path and #148 did not make it one.
    expect('exitCode' in result).toBe(false);
  });
});

describe('the other three snapshot consumers state what they do with a hole (#148)', () => {
  it('workload drops the dark board\'s cards and names the hole, without claiming an exit code', async () => {
    const client = await startServer({ failColumnsFor: [DARK] });
    const result = await workloadHandler(ctxFor(client), NO_OPTS);

    // 13 cards on each board; only the readable board's are counted, and the
    // three that are actually in progress are the three reported active.
    expect(result.item.total).toBe(13);
    expect(result.item.members[0].activeCards).toBe(3);
    expect(result.item.unreachable?.map(h => h.id)).toEqual([`columns:${DARK}`]);
    expect(result.human(result.item)).toContain(`columns:${DARK}`);
    // No `exitCode` on the returned `Result` — `workload` states no verdict, so
    // its exit code was never an answer and #148 did not make it one. The
    // absence is enforced by the return TYPE; asserting it here does not
    // compile, which is the stronger pin.
  });

  it('team drops them too, so nobody is reported at a fabricated zero WIP', async () => {
    const client = await startServer({ failColumnsFor: [DARK] });
    const result = await teamHandler(ctxFor(client), NO_OPTS);

    expect(result.item.members[0].totalCards).toBe(13);
    expect(result.item.members[0].wipCount).toBe(3);
    expect(result.item.members[0].doneCount).toBe(10);
    expect(result.item.unreachable?.map(h => h.id)).toEqual([`columns:${DARK}`]);
    expect(result.human(result.item)).toContain(`columns:${DARK}`);
  });

  it('stale does not report the dark board\'s finished cards as stale', async () => {
    const client = await startServer({ failColumnsFor: [DARK] });
    // `--days 0` makes every card old enough, so the only thing keeping a card
    // out of the list is the done-stage guard the missing columns disabled.
    const result = await staleHandler(ctxFor(client), { days: '0' });

    const listed = [...result.item.assignedStale, ...result.item.unassignedStale];
    // The dark board's ten finished cards are the ones that used to leak
    // through: with no stage, the done-stage guard let every one of them past.
    expect(listed.some(c => c.id.startsWith(DARK))).toBe(false);
    expect(listed.map(c => c.id).sort()).toEqual([`${GOOD}-c10`, `${GOOD}-c11`, `${GOOD}-c12`]);
    expect(result.item.unreachable?.map(h => h.id)).toEqual([`columns:${DARK}`]);
    expect(result.human(result.item)).toContain(`columns:${DARK}`);
  });

  it('all three emit no unreachable key on a clean read', async () => {
    const client = await startServer();
    const ctx = ctxFor(client);

    expect('unreachable' in (await workloadHandler(ctx, NO_OPTS)).item).toBe(false);
    expect('unreachable' in (await teamHandler(ctx, NO_OPTS)).item).toBe(false);
    expect('unreachable' in (await staleHandler(ctx, { days: '0' })).item).toBe(false);
  });
});
