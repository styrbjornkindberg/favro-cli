/**
 * Wire-level tests for the `unblocked` frontier — issue #47.
 *
 * A mock cannot see the two facts this rests on: that `GET /cards` **inlines**
 * populated `dependencies` keyed by the far card's `cardCommonId`, and that
 * Favro's card list **includes archived cards unless told otherwise**. Both are
 * properties of the response and the query string, so the assertions here are
 * about what Favro receives and what the caller observes — never about how the
 * verdict was reached.
 *
 * The three things that would be silently wrong without them:
 *   - a blocker already in the fetch costs NO extra call (the one-call frontier);
 *   - the per-blocker read must NOT send `archived`, or an archived blocker comes
 *     back empty and reads as unreachable instead of as done;
 *   - a blocker that cannot be read leaves its card blocked AND lands in
 *     `unreachable`, because "no blockers" and "couldn't check" are different
 *     answers.
 */
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import CardsAPI from '../lib/cards-api';
import { judgeBlockers } from '../lib/blocking';
import { parseQuery, filterCards } from '../lib/query-parser';

const ORG = 'org-1';
const TRACKER_BOARD = 'board-tracker';
const OTHER_BOARD = 'board-other';
const ACTIVE = 'col-active';
const DONE = 'col-done';

interface Received { method: string; url: string }

/** Every server this file started, so a failed assertion cannot leak one. */
const running: http.Server[] = [];

interface Wire {
  /** Cards `GET /cards?widgetCommonId=…` answers with. */
  board: Record<string, unknown>[];
  /** `cardCommonId` → the instances a per-blocker read answers with. */
  byCommonId: Record<string, Record<string, unknown>[]>;
  /** `cardCommonId`s whose per-blocker read fails. */
  broken?: string[];
}

function startServer(wire: Wire): Promise<{ client: FavroHttpClient; received: Received[] }> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    req.on('data', () => { /* no bodies on this path */ });
    req.on('end', () => {
      const url = req.url ?? '';
      received.push({ method: req.method ?? '', url });

      // The board listing every card read now resolves `--board` against
      // (#82): a board reference — name or id — is settled before it can reach
      // `widgetCommonId`, so a Favro stand-in has to know its own boards.
      if (url.startsWith('/api/v1/widgets')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          entities: [
            { widgetCommonId: TRACKER_BOARD, name: 'Tracker', columns: [] },
            { widgetCommonId: OTHER_BOARD, name: 'Other', columns: [] },
          ],
        }));
        return;
      }

      const query = new URL(url, 'http://x').searchParams;
      const commonId = query.get('cardCommonId');

      if (commonId && (wire.broken ?? []).includes(commonId)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Access denied' }));
        return;
      }

      let entities: unknown[] = [];
      if (commonId) entities = wire.byCommonId[commonId] ?? [];
      else if (url.startsWith('/api/v1/cards')) entities = wire.board;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entities }));
    });
  });
  running.push(server);

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        client: new FavroHttpClient({
          baseURL: `http://127.0.0.1:${port}/api/v1`,
          auth: { organizationId: ORG },
        }),
        received,
      });
    });
  });
}

const blockerReads = (received: Received[]) =>
  received.filter((r) => r.url.includes('cardCommonId='));

/** A live board instance. */
function card(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cardId: `card-${over.cardCommonId ?? 'x'}`,
    cardCommonId: 'common-x',
    name: 'a card',
    widgetCommonId: TRACKER_BOARD,
    columnId: ACTIVE,
    archived: false,
    createdAt: '2026-01-01',
    ...over,
  };
}

const originalConfigDir = process.env.FAVRO_CONFIG_DIR;
const originalTrackerDoc = process.env.FAVRO_TRACKER_DOC;
let tmpDir: string;

beforeEach(async () => {
  // The name cache and the tracker doc are real files — give each test its own,
  // so a run never reads or clobbers the developer's own ~/.favro state.
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-frontier-test-'));
  process.env.FAVRO_CONFIG_DIR = tmpDir;
  process.env.FAVRO_TRACKER_DOC = path.join(tmpDir, 'issue-tracker.md');
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise((done) => s.close(() => done(null)))));
  for (const [key, value] of [
    ['FAVRO_CONFIG_DIR', originalConfigDir],
    ['FAVRO_TRACKER_DOC', originalTrackerDoc],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** The paste-ready block `tracker init` prints, as a designated tracker. */
async function designateTracker(): Promise<void> {
  const mapping = {
    collectionId: 'coll-1',
    boardId: TRACKER_BOARD,
    columns: { active: ACTIVE, done: DONE },
  };
  await fs.writeFile(
    process.env.FAVRO_TRACKER_DOC!,
    `<!-- favro-tracker -->\n\`\`\`json\n${JSON.stringify(mapping)}\n\`\`\`\n<!-- /favro-tracker -->\n`,
  );
}

describe('the unblocked frontier, on the wire', () => {
  it('reads the inlined dependencies Favro sends, keyed by the far cardCommonId', async () => {
    const { client } = await startServer({
      board: [
        card({
          cardCommonId: 'common-blocked',
          dependencies: [{ cardCommonId: 'common-blocker', isBefore: true, cardSequentialId: 'CLA-1' }],
        }),
      ],
      byCommonId: {},
    });

    const [read] = await new CardsAPI(client).listCards({ boardId: TRACKER_BOARD });
    expect(read.links).toEqual([
      { cardCommonId: 'common-blocker', isBefore: true, cardSequentialId: 'CLA-1' },
    ]);
  });

  it('a blocker in the same fetch costs no extra call, and its done column clears it', async () => {
    await designateTracker();
    const { client, received } = await startServer({
      board: [
        card({
          cardCommonId: 'common-blocked',
          dependencies: [{ cardCommonId: 'common-blocker', isBefore: true }],
        }),
        card({ cardCommonId: 'common-blocker', columnId: DONE }),
      ],
      byCommonId: {},
    });

    const cards = await new CardsAPI(client).listCards({ boardId: TRACKER_BOARD });
    const judged = await judgeBlockers(cards, client);

    expect(blockerReads(received)).toHaveLength(0);
    expect([...judged.done]).toEqual(['common-blocker']);
    expect(judged.unreachable).toEqual([]);

    const rows = filterCards(parseQuery('unblocked'), cards, { doneBlockers: judged.done });
    expect(rows.map((c) => c.cardCommonId)).toContain('common-blocked');
  });

  it('a blocker sitting in the tracker active column keeps the card off the frontier', async () => {
    await designateTracker();
    const { client } = await startServer({
      board: [
        card({
          cardCommonId: 'common-blocked',
          dependencies: [{ cardCommonId: 'common-blocker', isBefore: true }],
        }),
        card({ cardCommonId: 'common-blocker', columnId: ACTIVE }),
      ],
      byCommonId: {},
    });

    const cards = await new CardsAPI(client).listCards({ boardId: TRACKER_BOARD });
    const judged = await judgeBlockers(cards, client);
    const rows = filterCards(parseQuery('unblocked'), cards, { doneBlockers: judged.done });

    expect(rows.map((c) => c.cardCommonId)).not.toContain('common-blocked');
  });

  it('the per-blocker read sends NO archived param, so an archived blocker resolves free', async () => {
    await designateTracker();
    const { client, received } = await startServer({
      board: [
        card({
          cardCommonId: 'common-blocked',
          dependencies: [{ cardCommonId: 'common-archived', isBefore: true }],
        }),
      ],
      // Off the tracker board and archived — Favro answers it only because the
      // read did not filter the archive out.
      byCommonId: {
        'common-archived': [
          card({ cardCommonId: 'common-archived', widgetCommonId: OTHER_BOARD, archived: true }),
        ],
      },
    });

    const cards = await new CardsAPI(client).listCards({ boardId: TRACKER_BOARD });
    const judged = await judgeBlockers(cards, client);

    const [read] = blockerReads(received);
    expect(read.url).toContain('cardCommonId=common-archived');
    expect(read.url).not.toMatch(/[?&]archived=/);
    expect([...judged.done]).toEqual(['common-archived']);
  });

  it('off the tracker board, a LIVE blocker still blocks — archived is the only signal there', async () => {
    await designateTracker();
    const { client } = await startServer({
      board: [
        card({
          cardCommonId: 'common-blocked',
          dependencies: [{ cardCommonId: 'common-elsewhere', isBefore: true }],
        }),
      ],
      byCommonId: {
        'common-elsewhere': [
          card({ cardCommonId: 'common-elsewhere', widgetCommonId: OTHER_BOARD, archived: false }),
        ],
      },
    });

    const cards = await new CardsAPI(client).listCards({ boardId: TRACKER_BOARD });
    const judged = await judgeBlockers(cards, client);

    expect([...judged.done]).toEqual([]);
    expect(filterCards(parseQuery('unblocked'), cards, { doneBlockers: judged.done })).toEqual([]);
  });

  it('a blocker that cannot be read stays blocking AND is reported unreachable', async () => {
    await designateTracker();
    const { client } = await startServer({
      board: [
        card({
          cardCommonId: 'common-blocked',
          dependencies: [{ cardCommonId: 'common-forbidden', isBefore: true }],
        }),
      ],
      byCommonId: {},
      broken: ['common-forbidden'],
    });

    const cards = await new CardsAPI(client).listCards({ boardId: TRACKER_BOARD });
    const judged = await judgeBlockers(cards, client);

    expect(judged.unreachable.map((u) => u.id)).toEqual(['common-forbidden']);
    expect(judged.unreachable[0].reason).not.toBe('');
    // The card is NOT offered: "couldn't check" is not "not blocked".
    expect(filterCards(parseQuery('unblocked'), cards, { doneBlockers: judged.done })).toEqual([]);
  });

  it('a per-blocker read that answers 200 with no entities reports unreachable, not an empty row', async () => {
    await designateTracker();
    const { client, received } = await startServer({
      board: [
        card({
          cardCommonId: 'common-blocked',
          // A deleted blocker, one invisible to this key, and a `cardId` queried
          // as a `cardCommonId` are indistinguishable on the wire: 200 {entities: []}.
          dependencies: [{ cardCommonId: 'common-vanished', isBefore: true }],
        }),
      ],
      byCommonId: {},
    });

    const cards = await new CardsAPI(client).listCards({ boardId: TRACKER_BOARD });
    const judged = await judgeBlockers(cards, client);

    expect(blockerReads(received)).toHaveLength(1);
    expect([...judged.done]).toEqual([]);
    expect(judged.unreachable.map((u) => u.id)).toEqual(['common-vanished']);
    expect(judged.unreachable[0].reason).toContain('common-vanished');
    expect(judged.unreachable[0].reason).toMatch(/missing|not visible/);
    // Blocked either way — but the caller can now tell it apart from "0 blockers".
    expect(filterCards(parseQuery('unblocked'), cards, { doneBlockers: judged.done })).toEqual([]);
  });

  it('an archived instance in the fetch is confirmed against the whole card, so a live instance elsewhere still blocks', async () => {
    // `--archived all` on ONE board shows the archived instance of a blocker that
    // is alive on another. Judging that partial set on `archived` alone proved the
    // blocker done and offered the card it blocks — the under-block.
    const { client, received } = await startServer({
      board: [
        card({
          cardCommonId: 'common-blocked',
          widgetCommonId: OTHER_BOARD,
          dependencies: [{ cardCommonId: 'common-two-boards', isBefore: true }],
        }),
        card({ cardCommonId: 'common-two-boards', widgetCommonId: OTHER_BOARD, archived: true }),
      ],
      byCommonId: {
        'common-two-boards': [
          card({ cardCommonId: 'common-two-boards', widgetCommonId: OTHER_BOARD, archived: true }),
          card({ cardCommonId: 'common-two-boards', widgetCommonId: 'board-third', archived: false }),
        ],
      },
    });

    const cards = await new CardsAPI(client).listCards({ boardId: OTHER_BOARD, archived: 'all' });
    const judged = await judgeBlockers(cards, client);

    // One confirming read, and it must not filter the archive out.
    const [read] = blockerReads(received);
    expect(blockerReads(received)).toHaveLength(1);
    expect(read.url).toContain('cardCommonId=common-two-boards');
    expect(read.url).not.toMatch(/[?&]archived=/);

    expect([...judged.done]).toEqual([]);
    const rows = filterCards(parseQuery('unblocked'), cards, { doneBlockers: judged.done });
    expect(rows.map((c) => c.cardCommonId)).not.toContain('common-blocked');
  });

  it('the confirming read clears the blocker when every instance really is archived', async () => {
    const { client, received } = await startServer({
      board: [
        card({
          cardCommonId: 'common-blocked',
          widgetCommonId: OTHER_BOARD,
          dependencies: [{ cardCommonId: 'common-really-archived', isBefore: true }],
        }),
        card({ cardCommonId: 'common-really-archived', widgetCommonId: OTHER_BOARD, archived: true }),
      ],
      byCommonId: {
        'common-really-archived': [
          card({ cardCommonId: 'common-really-archived', widgetCommonId: OTHER_BOARD, archived: true }),
        ],
      },
    });

    const cards = await new CardsAPI(client).listCards({ boardId: OTHER_BOARD, archived: 'all' });
    const judged = await judgeBlockers(cards, client);

    expect(blockerReads(received)).toHaveLength(1);
    expect([...judged.done]).toEqual(['common-really-archived']);
    const rows = filterCards(parseQuery('unblocked'), cards, { doneBlockers: judged.done });
    expect(rows.map((c) => c.cardCommonId)).toContain('common-blocked');
  });

  it('a tracker done column in the fetch still costs zero reads — only the archived branch confirms', async () => {
    await designateTracker();
    const { client, received } = await startServer({
      board: [
        card({
          cardCommonId: 'common-blocked',
          dependencies: [
            { cardCommonId: 'common-done-here', isBefore: true },
            { cardCommonId: 'common-open-here', isBefore: true },
          ],
        }),
        card({ cardCommonId: 'common-done-here', columnId: DONE }),
        card({ cardCommonId: 'common-open-here', columnId: ACTIVE }),
      ],
      byCommonId: {},
    });

    const cards = await new CardsAPI(client).listCards({ boardId: TRACKER_BOARD });
    const judged = await judgeBlockers(cards, client);

    expect(blockerReads(received)).toHaveLength(0);
    expect([...judged.done]).toEqual(['common-done-here']);
    expect(judged.unreachable).toEqual([]);
  });

  it('with no tracker designated at all, only archived can clear a blocker', async () => {
    const { client } = await startServer({
      board: [
        card({
          cardCommonId: 'common-a',
          dependencies: [{ cardCommonId: 'common-open', isBefore: true }],
        }),
        card({
          cardCommonId: 'common-b',
          dependencies: [{ cardCommonId: 'common-gone', isBefore: true }],
        }),
        // In the tracker's `done` column — but nothing designates that board, so
        // the column means nothing and the card it blocks stays blocked.
        card({ cardCommonId: 'common-open', columnId: DONE }),
      ],
      byCommonId: {
        'common-gone': [card({ cardCommonId: 'common-gone', archived: true })],
      },
    });

    const cards = await new CardsAPI(client).listCards({ boardId: TRACKER_BOARD });
    const judged = await judgeBlockers(cards, client);

    expect([...judged.done]).toEqual(['common-gone']);
    const rows = filterCards(parseQuery('unblocked'), cards, { doneBlockers: judged.done });
    expect(rows.map((c) => c.cardCommonId).sort()).toEqual(['common-b', 'common-open']);
  });

  it('a card with no edges at all needs no call and is on the frontier', async () => {
    const { client, received } = await startServer({
      board: [card({ cardCommonId: 'common-free' })],
      byCommonId: {},
    });

    const cards = await new CardsAPI(client).listCards({ boardId: TRACKER_BOARD });
    const judged = await judgeBlockers(cards, client);

    expect(blockerReads(received)).toHaveLength(0);
    expect(judged.unreachable).toEqual([]);
    expect(filterCards(parseQuery('unblocked'), cards, { doneBlockers: judged.done })).toHaveLength(1);
  });

  it('the sweep is capped, and the ids past the cap say they were not attempted', async () => {
    const many = Array.from({ length: 25 }, (_, i) => `common-blocker-${i}`);
    const { client, received } = await startServer({
      board: [
        card({
          cardCommonId: 'common-blocked',
          dependencies: many.map((id) => ({ cardCommonId: id, isBefore: true })),
        }),
      ],
      byCommonId: Object.fromEntries(
        many.map((id) => [id, [card({ cardCommonId: id, archived: true })]]),
      ),
    });

    const cards = await new CardsAPI(client).listCards({ boardId: TRACKER_BOARD });
    const judged = await judgeBlockers(cards, client);

    expect(blockerReads(received)).toHaveLength(20);
    expect(judged.done.size).toBe(20);
    expect(judged.unreachable).toHaveLength(5);
    expect(judged.unreachable[0].reason).toMatch(/not attempted/);
  });

  it('archived and forked cards are never on the frontier, edges or not', async () => {
    const { client } = await startServer({
      board: [
        card({ cardCommonId: 'common-archived-card', archived: true }),
        // A fork: assigning a card produces a second entity with no
        // widgetCommonId and no columnId.
        { cardId: 'fork-1', cardCommonId: 'common-fork', name: 'a card', createdAt: '2026-01-01' },
        card({ cardCommonId: 'common-live' }),
      ],
      byCommonId: {},
    });

    const cards = await new CardsAPI(client).listCards({ boardId: TRACKER_BOARD, archived: 'all' });
    const judged = await judgeBlockers(cards, client);
    const rows = filterCards(parseQuery('unblocked'), cards, { doneBlockers: judged.done });

    expect(rows.map((c) => c.cardCommonId)).toEqual(['common-live']);
  });
});
