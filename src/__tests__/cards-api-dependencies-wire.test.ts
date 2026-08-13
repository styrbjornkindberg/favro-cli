/**
 * Wire-level tests for the card dependency endpoints — issue #12.
 *
 * These deliberately do NOT mock the http client. A real `node:http` server
 * stands in for Favro, so the real axios stack builds the URL, serialises the
 * body, and interprets the status code. The old client-mock tests could not
 * catch a wrong path, a wrong request shape, or a wrong response envelope key,
 * which is exactly how `getCardLinks` shipped reading `.entities` (Favro sends
 * `.dependencies`) and `createCards` shipped posting to a route that does not
 * exist.
 *
 * Expectations below are pinned to responses observed against the live Favro
 * API on 2026-07-31 (throwaway board, cards created and deleted by the probe).
 */
import * as http from 'http';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import CardsAPI from '../lib/cards-api';
import { filterCards, parseQuery } from '../lib/query-parser';

interface Received {
  method: string;
  url: string;
  body: string;
}

/** A fake Favro that records what it was asked, and replies how Favro replies. */
function startServer(
  handler: (req: Received) => { status: number; body?: unknown },
): Promise<{ api: CardsAPI; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const entry = { method: req.method ?? '', url: req.url ?? '', body };
      received.push(entry);
      const { status, body: out } = handler(entry);
      if (out === undefined) {
        res.writeHead(status);
        res.end();
        return;
      }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const client = new FavroHttpClient({ baseURL: `http://127.0.0.1:${port}/api/v1` });
      resolve({
        api: new CardsAPI(client as any),
        received,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const CARD = '117a0f59f4145c41747b32dc';
const OTHER = 'a41ca08db390ccbfd91a55f5';

describe('unlinkCard (no client mock)', () => {
  test('DELETEs the documented path and resolves on Favro\'s 204', async () => {
    const { api, received, close } = await startServer(() => ({ status: 204 }));
    try {
      await expect(api.unlinkCard(CARD, OTHER)).resolves.toBeUndefined();
      expect(received).toHaveLength(1);
      expect(received[0].method).toBe('DELETE');
      expect(received[0].url).toBe(`/api/v1/cards/${CARD}/dependencies/${OTHER}`);
      expect(received[0].body).toBe('');
    } finally {
      await close();
    }
  });

  test('rejects on Favro\'s 404 "Dependency not found" for an edge already gone', async () => {
    const { api, close } = await startServer(() => ({
      status: 404,
      body: { message: 'Dependency not found' },
    }));
    try {
      // The rollback contract in #11 treats this 404 as "already undone", but it
      // has to be able to *see* it — so the error must carry the status through.
      await expect(api.unlinkCard(CARD, OTHER)).rejects.toMatchObject({
        response: { status: 404 },
      });
    } finally {
      await close();
    }
  });
});

describe('getCardLinks (no client mock)', () => {
  test('reads the `dependencies` envelope key, not `entities`', async () => {
    const { api, received, close } = await startServer(() => ({
      status: 200,
      body: {
        cardId: CARD,
        cardCommonId: 'bc948674af3413d345488800',
        organizationId: 'b0b311ac98a0250191573541',
        dependencies: [
          {
            cardId: OTHER,
            isBefore: true,
            cardCommonId: '39b9f66d474a5575ab380f2b',
            reverseCardId: CARD,
          },
        ],
      },
    }));
    try {
      const links = await api.getCardLinks(CARD);
      expect(received[0].url).toBe(`/api/v1/cards/${CARD}/dependencies`);
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ cardId: OTHER, isBefore: true });
    } finally {
      await close();
    }
  });

  test('returns [] when a card has no edges', async () => {
    const { api, close } = await startServer(() => ({
      status: 200,
      body: { cardId: CARD, cardCommonId: 'x', organizationId: 'y', dependencies: [] },
    }));
    try {
      await expect(api.getCardLinks(CARD)).resolves.toEqual([]);
    } finally {
      await close();
    }
  });
});

describe('linkCard (no client mock)', () => {
  test('POSTs { dependencies: [{ cardId, isBefore }] } — the shape Favro accepts', async () => {
    const { api, received, close } = await startServer((req) => {
      // Mirror Favro's real validator: it 400s on an unrecognised body.
      const parsed = JSON.parse(req.body);
      if (!Array.isArray(parsed.dependencies)) {
        return { status: 400, body: { message: `Match error: Expected array, got ${req.body}` } };
      }
      if (parsed.dependencies.some((d: any) => d.isBefore === undefined)) {
        return { status: 400, body: { message: "Match error: Missing key 'isBefore' in field [0]" } };
      }
      return {
        status: 201,
        body: {
          cardId: CARD,
          dependencies: parsed.dependencies.map((d: any) => ({ ...d, reverseCardId: CARD })),
        },
      };
    });
    try {
      const edges = await api.linkCard(CARD, { toCardId: OTHER, isBefore: true });
      expect(received[0].method).toBe('POST');
      expect(received[0].url).toBe(`/api/v1/cards/${CARD}/dependencies`);
      expect(JSON.parse(received[0].body)).toEqual({
        dependencies: [{ cardId: OTHER, isBefore: true }],
      });
      expect(edges).toEqual([{ cardId: OTHER, isBefore: true, reverseCardId: CARD }]);
    } finally {
      await close();
    }
  });
});

/**
 * The inlined edge, end to end: `GET /cards` → `normalizeCard` → `filterCards`.
 *
 * This is the shape #162 item 3 needed and did not have. The arm that looked
 * like it covered this (`lib/query-parser.test.ts`) fed `filterCards` a
 * hand-written `links` array, so it never crossed `normalizeCard` — the one
 * function that was dropping the `cardId`. Entering through the wire is what
 * makes the normaliser part of the subject under test.
 *
 * The bodies below are the LIVE response, copied from board
 * `abf5860049452d51cacb8162` on 2026-08-13: T1 blocks T2 and T3. Note there is
 * no `cardSequentialId` on any edge — Favro does not send one.
 *
 * Every assertion is PAIRED: a filter that must match AND a filter that must
 * not, for each identifier and each direction. A lone `toHaveLength(0)` cannot
 * tell a silent wrong answer from a genuine empty result, which is exactly how
 * the defect stayed invisible.
 */
const T1 = { cardId: '621a8a2e7a2eb278bf008484', commonId: 'ed952c352c7022ead230856c' };
const T2 = { cardId: 'b9303e90cb9db9e78ce6f9bf', commonId: '03748d44fa3408f37bbb06fa' };
const T3 = { cardId: '68c1989e567233ca979db848', commonId: 'e02593ea450619b793f7d610' };
const UNRELATED = { cardId: '84592f2c62fbcd63fc7555c8', commonId: '0dc08c95ee62a12beeac6a13' };

const BOARD = 'abf5860049452d51cacb8162';

/** The three cards of the live fixture, exactly as `GET /cards` returns them. */
const FIXTURE_PAGE = [
  {
    cardId: T1.cardId, cardCommonId: T1.commonId, name: 'T1', widgetCommonId: BOARD,
    dependencies: [
      { cardId: T2.cardId, isBefore: false, cardCommonId: T2.commonId, reverseCardId: T1.cardId },
      { cardId: T3.cardId, isBefore: false, cardCommonId: T3.commonId, reverseCardId: T1.cardId },
    ],
  },
  {
    cardId: T2.cardId, cardCommonId: T2.commonId, name: 'T2', widgetCommonId: BOARD,
    dependencies: [
      { cardId: T1.cardId, isBefore: true, cardCommonId: T1.commonId, reverseCardId: T2.cardId },
    ],
  },
  {
    cardId: T3.cardId, cardCommonId: T3.commonId, name: 'T3', widgetCommonId: BOARD,
    dependencies: [
      { cardId: T1.cardId, isBefore: true, cardCommonId: T1.commonId, reverseCardId: T3.cardId },
    ],
  },
];

describe('blocked-by: / blocks: over cards that came through normalizeCard (#162)', () => {
  /**
   * A Favro that answers `/cards` with the fixture page and `/widgets` with the
   * one board it sits on — routed by path, because `--board <id>` is resolved
   * through `/widgets` before the cards are read.
   */
  const fixtureServer = () =>
    startServer((req) => ({
      status: 200,
      body: req.url.startsWith('/api/v1/widgets')
        ? { entities: [{ widgetCommonId: BOARD, name: 'fixture board' }] }
        : { entities: FIXTURE_PAGE },
    }));

  /** Fetch the fixture board the way `cards list` does, then filter it. */
  async function listAndFilter(filter: string): Promise<string[]> {
    const { api, close } = await fixtureServer();
    try {
      const cards = await api.listCards({ boardId: BOARD });
      return filterCards(parseQuery(filter), cards).map((c) => c.name);
    } finally {
      await close();
    }
  }

  test('the normalised card keeps every key the wire put on the edge', async () => {
    const { api, close } = await fixtureServer();
    try {
      const [t1] = await api.listCards({ boardId: BOARD });
      // `links` used to be `{cardCommonId, isBefore}` — the cardId was dropped
      // here, and `linksOf` reads `links` before `dependencies`, so nothing
      // downstream could ever see it.
      expect(t1.links?.[0]).toEqual({
        cardId: T2.cardId, isBefore: false, cardCommonId: T2.commonId, reverseCardId: T1.cardId,
      });
    } finally {
      await close();
    }
  });

  // Paired polarity: the id of a card that IS the far end matches, the id of a
  // card on the same board that is NOT the far end does not.
  test.each([
    ['cardId', T1.cardId, UNRELATED.cardId],
    ['cardCommonId', T1.commonId, UNRELATED.commonId],
  ])('blocked-by:<%s> finds both cards T1 blocks, and nothing for an unrelated card',
    async (_shape, blocker, unrelated) => {
      expect((await listAndFilter(`blocked-by:${blocker}`)).sort()).toEqual(['T2', 'T3']);
      expect(await listAndFilter(`blocked-by:${unrelated}`)).toEqual([]);
    });

  test.each([
    ['cardId', T2.cardId, UNRELATED.cardId],
    ['cardCommonId', T2.commonId, UNRELATED.commonId],
  ])('blocks:<%s> finds T1 from the other end, and nothing for an unrelated card',
    async (_shape, blocked, unrelated) => {
      expect(await listAndFilter(`blocks:${blocked}`)).toEqual(['T1']);
      expect(await listAndFilter(`blocks:${unrelated}`)).toEqual([]);
    });

  // Direction is not symmetric. Reading the SAME id under the opposite
  // predicate must come back empty — otherwise a predicate that ignored
  // `isBefore` entirely would pass every arm above.
  test.each([
    ['cardId', T1.cardId, T2.cardId],
    ['cardCommonId', T1.commonId, T2.commonId],
  ])('the two directions do not answer each other (%s)', async (_shape, blocker, blocked) => {
    expect(await listAndFilter(`blocks:${blocker}`)).toEqual([]);
    expect(await listAndFilter(`blocked-by:${blocked}`)).toEqual([]);
    // The two emptinesses above are only meaningful next to a populated answer
    // for the same ids: without this line the arm passes just as happily when
    // the identifier matches NOTHING, which is the #162 defect itself.
    expect((await listAndFilter(`blocked-by:${blocker}`)).sort()).toEqual(['T2', 'T3']);
    expect(await listAndFilter(`blocks:${blocked}`)).toEqual(['T1']);
  });
});

// `CardsAPI.createCards` was deleted with #67 — since #55 `cards create
// --csv/--bulk` routes through `dispatch('create', {cards})`, which is where the
// one-POST-per-card guarantee (and the "never `POST /cards/bulk`" assertion that
// used to live here) is now pinned: see the multi-create test in
// `dispatch-tx-wire.test.ts`.
