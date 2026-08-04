/**
 * The `--board X` arm of `stale` and `workload`, against a real server (#149).
 *
 * WHAT #148 LEFT
 * Both commands have four scope arms. Three go through `AggregateSnapshot`,
 * whose failed-columns holes are keyed `columns:<boardId>`; the `--board` arm
 * goes through `ContextSnapshot`, whose hole is the bare facet name `columns`
 * because that snapshot only ever covers one board. `excludeUnreadableBoards`
 * matched only the prefixed form, so on this arm it matched nothing, excluded
 * nothing, and `stale --board X` went on reporting the board's FINISHED cards as
 * stale off a columns read that had failed. The hole was printed (#117's half);
 * not fabricating off it (#148's half) was never done here.
 *
 * WHY THE EXCLUSION IS STAGE-AWARE AND NOT "DROP EVERYTHING"
 * `getSnapshot` falls back to `extendedBoard.boardColumns` when `listColumns`
 * comes back empty, so a columns hole does NOT always cost the cards their
 * stage. The last describe below drives that fallback with the columns endpoint
 * still refusing: the hole is reported and the cards are KEPT, because they were
 * staged off a read that landed. A blanket drop would have reported zero stale
 * cards and zero workload for a board that was in fact fully readable — the same
 * fabricated zero from the other side.
 *
 * Real `node:http`, not queued mocks: a queued mock answers whatever is asked,
 * so it cannot express "the columns call refuses and the widget call does not",
 * which is the only difference these assertions read.
 *
 * Refusals are 403, not 500. The client retries any 5xx four times at
 * 1s/2s/4s/8s, so a 500 costs 15 real seconds per case; `orElse` catches
 * whatever `listColumns` throws, so the status only decides the runtime. The
 * retry ladder is walked once, deliberately, in
 * `aggregate-unreachable-wire.test.ts`.
 */
import http from 'http';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import { apiNamespace, Ctx } from '../lib/run';
import { staleHandler } from '../commands/stale';
import { workloadHandler } from '../commands/workload';

const ORG = 'org-1';
const BOARD = 'board-solo';

/** Every server this file started, so a failed assertion cannot leak one. */
const running: http.Server[] = [];

interface Wire {
  /** Refuse `/columns`. */
  failColumns?: boolean;
  /**
   * Serve `boardColumns` on `/widgets/<id>`, which is `getSnapshot`'s documented
   * fallback source for columns (`boards-api.ts:86`). Off by default so the two
   * paths are tested apart.
   */
  widgetCarriesColumns?: boolean;
}

/**
 * A Favro stand-in for ONE board holding thirteen cards: ten finished 60 days
 * ago and three actively in progress today.
 *
 * Shaped so the bug is visible rather than merely present. With stages resolved,
 * `stale --days 0` lists exactly the three in-progress cards — the ten done ones
 * are skipped by the done-stage guard. With the columns read swallowed, nothing
 * has a stage, that guard never fires, and all thirteen are reported as stale
 * work somebody should chase.
 */
function startServer(wire: Wire = {}): Promise<FavroHttpClient> {
  const columns = [
    { columnId: 'todo', name: 'To Do', position: 0, widgetCommonId: BOARD },
    { columnId: 'doing', name: 'In Progress', position: 1, widgetCommonId: BOARD },
    { columnId: 'done', name: 'Done', position: 2, widgetCommonId: BOARD },
  ];

  const card = (i: number, columnId: string, ageDays: number) => ({
    cardId: `c${i}`,
    cardCommonId: `cc${i}`,
    name: `card ${i}`,
    widgetCommonId: BOARD,
    columnId,
    assignments: [{ userId: 'user-1' }],
    createdAt: new Date(Date.now() - ageDays * 86400000).toISOString(),
  });
  const cards = [
    ...Array.from({ length: 10 }, (_, i) => card(i, 'done', 60)),
    ...Array.from({ length: 3 }, (_, i) => card(10 + i, 'doing', 60)),
  ];

  const ok = (res: http.ServerResponse, entities: unknown[]) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ entities, requestId: 'req-1', page: 0, pages: 1 }));
  };
  const bare = (res: http.ServerResponse, body: unknown) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const refuse = (res: http.ServerResponse) => {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'the columns read failed' }));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://x');
    const p = url.pathname;

    if (p === `/api/v1/widgets/${BOARD}`) {
      return bare(res, {
        widgetCommonId: BOARD,
        name: 'Solo',
        type: 'backlog',
        collectionIds: ['coll-1'],
        createdAt: '',
        updatedAt: '',
        ...(wire.widgetCarriesColumns
          ? { boardColumns: columns.map(c => ({ columnId: c.columnId, name: c.name, cardCount: 0 })) }
          : {}),
      });
    }
    // `listCards` resolves its board argument through `resolveBoardId`, which
    // reads the listing rather than the id — so this arm has to exist or the
    // CARDS facet fails and the hole under test is no longer the only one.
    if (p === '/api/v1/widgets') {
      return ok(res, [{
        widgetCommonId: BOARD,
        name: 'Solo',
        collectionIds: ['coll-1'],
        createdAt: '',
        updatedAt: '',
      }]);
    }
    if (p === '/api/v1/columns') {
      if (wire.failColumns) return refuse(res);
      return ok(res, columns);
    }
    if (p === '/api/v1/cards') return ok(res, cards);
    if (p === '/api/v1/users') {
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

/** A `Ctx` with NO scoped collection, so `--board` is the arm that is taken. */
function ctxFor(client: FavroHttpClient): Ctx {
  return {
    client,
    config: {} as Ctx['config'],
    verbose: false,
    api: apiNamespace(client),
  };
}

const originalConfigDir = process.env.FAVRO_CONFIG_DIR;
let tmpDir: string;

beforeEach(async () => {
  // The name cache is a real file — give each test its own, so a run never reads
  // or clobbers the developer's own ~/.favro cache.
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-board-arm-hole-test-'));
  process.env.FAVRO_CONFIG_DIR = tmpDir;
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise((done) => s.close(() => done(null)))));
  if (originalConfigDir === undefined) delete process.env.FAVRO_CONFIG_DIR;
  else process.env.FAVRO_CONFIG_DIR = originalConfigDir;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** `--days 0` makes every card old enough, so the done-stage guard is the only filter left. */
const STALE_OPTS = { board: BOARD, days: '0' };
const WORKLOAD_OPTS = { board: BOARD };

describe('the single-board snapshot records its columns hole under the bare facet name', () => {
  it('names it `columns`, with no board id after it', async () => {
    const client = await startServer({ failColumns: true });
    const snapshot = await apiNamespace(client).context.getSnapshot(BOARD);

    // The premise of the whole file. If this id ever gained a `:<boardId>`
    // suffix the prefixed arm would cover it and the arm under test would be
    // dead code — so it is asserted rather than assumed.
    expect(snapshot.unreachable?.map(h => h.id)).toEqual(['columns']);
    expect(snapshot.cards.every(c => c.stage === undefined)).toBe(true);
  });

  it('a clean read emits no unreachable key at all', async () => {
    const client = await startServer();
    const snapshot = await apiNamespace(client).context.getSnapshot(BOARD);

    expect('unreachable' in snapshot).toBe(false);
    expect(snapshot.cards.every(c => c.stage !== undefined)).toBe(true);
  });
});

describe('stale --board X stops reporting finished cards as stale (#149)', () => {
  it('assesses nothing off the failed read, and says so', async () => {
    const client = await startServer({ failColumns: true });
    const result = await staleHandler(ctxFor(client), STALE_OPTS);

    // THE regression, on this arm: before the fix all thirteen came back stale,
    // ten of them finished 60 days ago. `stale --board X` was telling a PM to
    // chase delivered work.
    const listed = [...result.item.assignedStale, ...result.item.unassignedStale];
    expect(listed).toEqual([]);
    expect(result.item.total).toBe(0);

    expect(result.item.unreachable?.map(h => h.id)).toEqual(['columns']);
    const human = result.human(result.item);
    // Both facts, side by side — nothing was assessed AND the read failed.
    // Printing only the first is the lie by omission this command already
    // guards against for `undated`.
    expect(human).toContain('No stale cards found.');
    expect(human).toContain('Not read — not assessed (1)');
    expect(human).toContain('columns —');
  });

  it('a clean read on the same board lists the three open cards and no hole', async () => {
    const client = await startServer();
    const result = await staleHandler(ctxFor(client), STALE_OPTS);

    // The discriminating half: the ten done cards are skipped because their
    // stage was READ, not because everything was dropped.
    const listed = [...result.item.assignedStale, ...result.item.unassignedStale];
    expect(listed.map(c => c.id).sort()).toEqual(['c10', 'c11', 'c12']);
    expect(result.item.total).toBe(3);
    expect('unreachable' in result.item).toBe(false);
    expect(result.human(result.item)).not.toContain('Not read');
  });
});

describe('workload --board X stops reporting a fabricated WIP (#149)', () => {
  it('counts nothing off the failed read, and names the hole in both modes', async () => {
    const client = await startServer({ failColumns: true });
    const result = await workloadHandler(ctxFor(client), WORKLOAD_OPTS);

    // Before the fix: `total: 13`, one member at `activeCards: 0` — three people's
    // worth of in-flight work reported as an idle board, with the overload alert
    // suppressed. Zero is a measurement; that was not one.
    expect(result.item.total).toBe(0);
    expect(result.item.members).toEqual([]);
    expect(result.item.unreachable?.map(h => h.id)).toEqual(['columns']);
    expect(result.human(result.item)).toContain('columns —');
  });

  it('a clean read on the same board counts thirteen cards and three active', async () => {
    const client = await startServer();
    const result = await workloadHandler(ctxFor(client), WORKLOAD_OPTS);

    expect(result.item.total).toBe(13);
    expect(result.item.members[0].totalCards).toBe(13);
    expect(result.item.members[0].activeCards).toBe(3);
    expect('unreachable' in result.item).toBe(false);
  });
});

describe('a columns hole the board-metadata fallback repaired costs no cards', () => {
  /**
   * The arm that keeps the exclusion honest in the other direction.
   *
   * `/columns` still refuses, so the hole is real and is reported. But
   * `getSnapshot` reads `boardColumns` off `/widgets/<id>` when `listColumns`
   * yields nothing, so every card IS staged — off a read that landed. Dropping
   * them on the strength of the hole alone would report zero stale cards and an
   * empty workload for a board that was fully readable.
   *
   * This is why the arm filters on `stage`, not on "a bare `columns` hole
   * exists". Without the distinction both assertions below would read `[]`/`0`.
   */
  it('keeps every card, still reports the hole, and judges them off the real stages', async () => {
    const client = await startServer({ failColumns: true, widgetCarriesColumns: true });
    const ctx = ctxFor(client);

    const snapshot = await apiNamespace(client).context.getSnapshot(BOARD);
    expect(snapshot.unreachable?.map(h => h.id)).toEqual(['columns']);
    expect(snapshot.cards.every(c => c.stage !== undefined)).toBe(true);

    const stale = await staleHandler(ctx, STALE_OPTS);
    expect([...stale.item.assignedStale, ...stale.item.unassignedStale].map(c => c.id).sort())
      .toEqual(['c10', 'c11', 'c12']);
    expect(stale.item.unreachable?.map(h => h.id)).toEqual(['columns']);

    const workload = await workloadHandler(ctx, WORKLOAD_OPTS);
    expect(workload.item.total).toBe(13);
    expect(workload.item.members[0].activeCards).toBe(3);
    expect(workload.item.unreachable?.map(h => h.id)).toEqual(['columns']);
  });
});
