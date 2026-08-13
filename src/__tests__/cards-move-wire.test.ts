/**
 * `dragMode` — the one field that tells a MOVE from a FORK (#161).
 *
 * `PUT /cards/{cardId} {widgetCommonId}` is two different writes wearing one
 * URL, and the request body is the only thing that picks between them. MEASURED
 * 2026-08-13, raw HTTP against the live API: the field defaults to `commit`, and
 * `commit` ADDS a board instance. So `cards move --to-board` — which sent no
 * `dragMode` — left the card on the board it was supposedly moving off, minted a
 * second instance of the same `cardCommonId` on the destination with its own
 * `cardId`, and reported the write as a success. Favro's own validator names the
 * enum when probed with a bogus value: `dragMode is expected as one of "commit",
 * "move" (optional)`.
 *
 * **Nothing but a request-body assertion could have caught this.** The response
 * was a genuine `200` for a genuinely-executed write. Status, message and
 * envelope were all indistinguishable from a correct move; the only tells were a
 * `cardId` nobody had asked about and an instance count nothing read. That is why
 * the stand below MODELS the two dragMode branches instead of canning a response:
 * a stand that answers the same row either way would pass with the field deleted
 * again.
 *
 * Both sides are pinned, and the PAIR is the point. `move` on
 * `CardsAPI.moveCard`, `commit` on `WidgetsAPI.addWidgetToBoard` — one arm alone
 * says only "this call sends a string", while the two together say the intents
 * are distinguishable at the wire, which is the property that was missing.
 */
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import CardsAPI from '../lib/cards-api';
import WidgetsAPI from '../lib/widgets-api';

const ORG = 'org-1';
const HOME_BOARD = 'w-home-0001';
const DEST_BOARD = 'w-dest-0002';
const CARD_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const CARD_COMMON_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
/** What the stand mints when a write commits rather than moves. */
const FORKED_CARD_ID = 'cccccccccccccccccccccccc';

interface Received {
  method: string;
  url: string;
  body: string;
}

const running: http.Server[] = [];

/**
 * A Favro stand that ACTS on `dragMode`, the way the live API was measured to.
 *
 * `instances` is the observable the defect was invisible without: one entry per
 * board instance of `CARD_COMMON_ID`, keyed by that instance's own `cardId`. A
 * move rewrites an entry; a commit adds one and answers with the new id.
 */
function startServer(): Promise<{
  client: FavroHttpClient;
  received: Received[];
  instances: Map<string, string>;
}> {
  const received: Received[] = [];
  const instances = new Map<string, string>([[CARD_ID, HOME_BOARD]]);
  const row = (cardId: string) => ({
    cardId,
    cardCommonId: CARD_COMMON_ID,
    name: 'A card',
    widgetCommonId: instances.get(cardId),
  });

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const url = req.url ?? '';
      const method = req.method ?? '';
      received.push({ method, url, body });

      const send = (payload: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (method === 'PUT' && url.startsWith('/api/v1/cards/')) {
        const sent = JSON.parse(body || '{}') as { widgetCommonId?: string; dragMode?: string };
        const addressed = url.slice('/api/v1/cards/'.length).split('?')[0];
        // The measured default: absent `dragMode` behaves exactly as `commit`.
        if (sent.dragMode === 'move') {
          instances.set(addressed, sent.widgetCommonId ?? HOME_BOARD);
          send(row(addressed));
          return;
        }
        instances.set(FORKED_CARD_ID, sent.widgetCommonId ?? HOME_BOARD);
        send(row(FORKED_CARD_ID));
        return;
      }

      if (url.startsWith('/api/v1/widgets')) {
        send({
          entities: [
            { widgetCommonId: HOME_BOARD, name: 'Home', columns: [] },
            { widgetCommonId: DEST_BOARD, name: 'Dest', columns: [] },
          ],
        });
        return;
      }
      if (url.startsWith('/api/v1/cards/')) {
        send(row(url.slice('/api/v1/cards/'.length).split('?')[0]));
        return;
      }
      if (url.startsWith('/api/v1/cards')) {
        send({ entities: [...instances.keys()].map(row) });
        return;
      }
      send({ entities: [] });
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
        instances,
      });
    });
  });
}

const putBody = (received: Received[]) =>
  JSON.parse(received.find((r) => r.method === 'PUT')?.body ?? '{}') as Record<string, unknown>;

const originalConfigDir = process.env.FAVRO_CONFIG_DIR;
let tmpDir: string;

beforeEach(async () => {
  // The name cache is a real file — give each test its own, so a run never reads
  // or clobbers the developer's own ~/.favro cache.
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-cards-move-test-'));
  process.env.FAVRO_CONFIG_DIR = tmpDir;
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise((done) => s.close(() => done(null)))));
  if (originalConfigDir === undefined) delete process.env.FAVRO_CONFIG_DIR;
  else process.env.FAVRO_CONFIG_DIR = originalConfigDir;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('the stand acts on dragMode, so the arms below are not vacuous', () => {
  it('a bare PUT forks — the shape `cards move` used to send', async () => {
    const { client, instances } = await startServer();
    const forked = await client.put<{ cardId: string }>(`/cards/${CARD_ID}`, {
      widgetCommonId: DEST_BOARD,
    });
    expect(instances.size).toBe(2);
    expect(instances.get(CARD_ID)).toBe(HOME_BOARD);
    expect(forked.cardId).not.toBe(CARD_ID);
  });

  it('`move` rewrites the instance it addressed', async () => {
    const { client, instances } = await startServer();
    const moved = await client.put<{ cardId: string }>(`/cards/${CARD_ID}`, {
      widgetCommonId: DEST_BOARD,
      dragMode: 'move',
    });
    expect(instances.size).toBe(1);
    expect(moved.cardId).toBe(CARD_ID);
  });
});

describe('cards move sends dragMode:move, and the card MOVES (#161)', () => {
  it('the PUT body carries the resolved board and dragMode move — nothing else', async () => {
    const { client, received } = await startServer();
    await new CardsAPI(client).moveCard(CARD_ID, { toBoardId: DEST_BOARD });
    expect(putBody(received)).toEqual({ widgetCommonId: DEST_BOARD, dragMode: 'move' });
  });

  /**
   * Not just the bytes. Drop `dragMode` from the body and this arm reddens on
   * every line: the count goes to 2, the home instance survives, and the id
   * handed back is one the caller never addressed.
   */
  it('one instance after, on the destination, under the SAME cardId', async () => {
    const { client, instances } = await startServer();
    const moved = await new CardsAPI(client).moveCard(CARD_ID, { toBoardId: DEST_BOARD });
    expect([...instances]).toEqual([[CARD_ID, DEST_BOARD]]);
    expect(moved.cardId).toBe(CARD_ID);
    expect(moved.boardId).toBe(DEST_BOARD);
  });
});

describe('widgets add sends dragMode:commit, and the card FORKS (#82, unchanged)', () => {
  it('the PUT body carries the resolved board and dragMode commit', async () => {
    const { client, received } = await startServer();
    await new WidgetsAPI(client).addWidgetToBoard(DEST_BOARD, CARD_COMMON_ID);
    expect(putBody(received)).toEqual({ widgetCommonId: DEST_BOARD, dragMode: 'commit' });
  });

  it('two instances after — the fork this command exists to make', async () => {
    const { client, instances } = await startServer();
    await new WidgetsAPI(client).addWidgetToBoard(DEST_BOARD, CARD_COMMON_ID);
    expect([...instances]).toEqual([[CARD_ID, HOME_BOARD], [FORKED_CARD_ID, DEST_BOARD]]);
  });
});

describe('the two intents are distinguishable at the wire', () => {
  /**
   * The pair, in one assertion. Same method, same path, same board — and the two
   * commands are telling the API to do opposite things. Before #161 these two
   * bodies differed by nothing that the API read as intent, so `cards move` WAS
   * `widgets add`.
   */
  it('same endpoint, same board, opposite dragMode', async () => {
    const move = await startServer();
    await new CardsAPI(move.client).moveCard(CARD_ID, { toBoardId: DEST_BOARD });
    const commit = await startServer();
    await new WidgetsAPI(commit.client).addWidgetToBoard(DEST_BOARD, CARD_COMMON_ID);

    const movePut = move.received.find((r) => r.method === 'PUT');
    const commitPut = commit.received.find((r) => r.method === 'PUT');
    expect(movePut?.url).toBe(commitPut?.url);
    expect(putBody(move.received).dragMode).toBe('move');
    expect(putBody(commit.received).dragMode).toBe('commit');
    expect(move.instances.size).toBe(1);
    expect(commit.instances.size).toBe(2);
  });
});
