/**
 * `widgets list --card` reads a card's board instances — issue #167 item 1.
 *
 * No client mock: a real `node:http` server stands in for Favro, because the
 * bug was in the REQUEST. `GET /widgets?cardCommonId=<x>` was measured
 * (2026-08-14, #105 scratch board) to ignore `cardCommonId` and answer 500 rows
 * over 5 pages — every board in the organisation, types `backlog` and `board` —
 * which the caller then filtered for `type === 'card'`, a type no row carries.
 * The command answered `{"rows":[]}` for every card since the filter was
 * written. A mock of `listInstancesOfCard` cannot see any of that; the path and
 * query string are the assertion.
 *
 * Polarity is paired on purpose: a lone "returns zero rows" arm cannot tell a
 * silent wrong answer from a correct empty one, which is how this defect and
 * `blocked-by:` (#162) both lived green.
 */
import * as http from 'http';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import WidgetsAPI from '../lib/widgets-api';

const COMMON_ID = '9f1c2d3e4a5b6c7d8e9f0a1b';
const UNRELATED_ID = '0000aaaa1111bbbb2222cccc';

interface Received { url: string }

function startServer(
  handler: (req: Received) => unknown,
): Promise<{ client: FavroHttpClient; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    const entry = { url: req.url ?? '' };
    received.push(entry);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(handler(entry)));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        client: new FavroHttpClient({ baseURL: `http://127.0.0.1:${port}/api/v1` }),
        received,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** The two instances of `COMMON_ID`, on two different boards. */
const INSTANCES = [
  {
    cardId: 'aaaa1111aaaa1111aaaa1111',
    cardCommonId: COMMON_ID,
    widgetCommonId: 'board-a',
    columnId: 'col-a',
    name: 'probe',
    archived: false,
  },
  {
    cardId: 'bbbb2222bbbb2222bbbb2222',
    cardCommonId: COMMON_ID,
    widgetCommonId: 'board-b',
    columnId: 'col-b',
    name: 'probe',
    archived: false,
  },
];

describe('listInstancesOfCard', () => {
  test('a card on two boards comes back as two rows, each naming its own board', async () => {
    const { client, received, close } = await startServer(({ url }) => ({
      entities: url.includes(`cardCommonId=${COMMON_ID}`) ? INSTANCES : [],
    }));

    try {
      const rows = await new WidgetsAPI(client).listInstancesOfCard(COMMON_ID);

      expect(rows).toEqual([
        { cardId: 'aaaa1111aaaa1111aaaa1111', cardCommonId: COMMON_ID, boardId: 'board-a', columnId: 'col-a', name: 'probe', archived: false },
        { cardId: 'bbbb2222bbbb2222bbbb2222', cardCommonId: COMMON_ID, boardId: 'board-b', columnId: 'col-b', name: 'probe', archived: false },
      ]);
      // `/cards`, not `/widgets` — the endpoint that honours the filter.
      expect(received[0].url).toContain('/cards?');
      // `unique` collapses the multi-instance result to one row, which is the
      // one thing this read must not do.
      expect(received[0].url).not.toContain('unique');
    } finally {
      await close();
    }
  });

  test('a card commonId nothing matches comes back empty', async () => {
    const { client, close } = await startServer(({ url }) => ({
      entities: url.includes(`cardCommonId=${COMMON_ID}`) ? INSTANCES : [],
    }));

    try {
      expect(await new WidgetsAPI(client).listInstancesOfCard(UNRELATED_ID)).toEqual([]);
    } finally {
      await close();
    }
  });

  test('an entity with no widgetCommonId is listed with no boardId — a fork, not a board', async () => {
    const { client, close } = await startServer(() => ({
      entities: [{ cardId: 'cccc3333cccc3333cccc3333', cardCommonId: COMMON_ID, name: 'fork' }],
    }));

    try {
      const rows = await new WidgetsAPI(client).listInstancesOfCard(COMMON_ID);

      expect(rows).toHaveLength(1);
      expect(rows[0].boardId).toBeUndefined();
    } finally {
      await close();
    }
  });
});
