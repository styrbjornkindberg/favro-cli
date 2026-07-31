/**
 * Wire-level tests for column resolution — issue #43.
 *
 * The defect these pin down cannot be seen from a client mock: `GET /cards`
 * accepts a `columnId` alone, lets it **override** `widgetCommonId`, and never
 * validates the pair. So `--board A --status <id-from-B>` answers 200 and
 * populated — about board B. Forwarding that is a wrong answer, not an error,
 * which is why the refusal has to happen before the request is built.
 *
 * Assertions are therefore about the query string Favro receives, and about
 * the refusals that mean no request was built at all.
 */
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import CardsAPI from '../lib/cards-api';
import ColumnDirectory, { ColumnResolutionError } from '../lib/column-directory';

const ORG = 'org-1';
const BOARD_A = 'board-a';
const BOARD_B = 'board-b';
const BOARD_DUP = 'board-dup';
const DOING_A = 'col-doing-a';
const DONE_A = 'col-done-a';
const DOING_B = 'col-doing-b';
const DUP_1 = 'col-dup-1';
const DUP_2 = 'col-dup-2';

interface Received { method: string; url: string }

/** Every server this file started, so a failed assertion cannot leak one. */
const running: http.Server[] = [];

/** A Favro stand-in whose /widgets response inlines each board's columns. */
function startServer(): Promise<{
  client: FavroHttpClient;
  received: Received[];
}> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    req.on('data', () => { /* no bodies on this path */ });
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '' });
      const url = req.url ?? '';
      let body: unknown = { entities: [] };
      if (url.startsWith('/api/v1/widgets')) {
        body = {
          entities: [
            {
              widgetCommonId: BOARD_A,
              name: 'Board A',
              columns: [
                { columnId: DOING_A, name: 'Doing', position: 0, cardCount: 3 },
                { columnId: DONE_A, name: 'Done', position: 1, cardCount: 7 },
              ],
            },
            {
              widgetCommonId: BOARD_B,
              name: 'Board B',
              columns: [{ columnId: DOING_B, name: 'Doing', position: 0, cardCount: 1 }],
            },
            {
              widgetCommonId: BOARD_DUP,
              name: 'Board Dup',
              columns: [
                { columnId: DUP_1, name: 'Review', position: 0 },
                { columnId: DUP_2, name: 'Review', position: 1 },
              ],
            },
          ],
        };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
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

const cardsCalls = (received: Received[]) => received.filter((r) => r.url.startsWith('/api/v1/cards'));

const originalConfigDir = process.env.FAVRO_CONFIG_DIR;
let tmpDir: string;

beforeEach(async () => {
  // The name cache is a real file — give each test its own, so a run never
  // reads or clobbers the developer's own ~/.favro cache.
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-colwire-test-'));
  process.env.FAVRO_CONFIG_DIR = tmpDir;
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise((done) => s.close(() => done(null)))));
  if (originalConfigDir === undefined) delete process.env.FAVRO_CONFIG_DIR;
  else process.env.FAVRO_CONFIG_DIR = originalConfigDir;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('column resolution on the wire', () => {
  it('a column name resolves against its board and rides the wire as columnId', async () => {
    const { client, received } = await startServer();
    await new CardsAPI(client).listCards({ boardId: BOARD_A, status: 'Doing' });

    const [call] = cardsCalls(received);
    expect(call.url).toContain(`columnId=${DOING_A}`);
    expect(call.url).toContain(`widgetCommonId=${BOARD_A}`);
  });

  it('the name match is case-insensitive and trimmed', async () => {
    const { client, received } = await startServer();
    await new CardsAPI(client).listCards({ boardId: BOARD_A, status: '  doing ' });

    expect(cardsCalls(received)[0].url).toContain(`columnId=${DOING_A}`);
  });

  it('a name without a board is refused — a column name is only unique within one', async () => {
    const { client, received } = await startServer();
    await expect(new CardsAPI(client).listCards({ status: 'Doing' })).rejects.toThrow('--board');

    expect(cardsCalls(received)).toHaveLength(0);
  });

  it('a raw columnId is accepted with no board at all', async () => {
    const { client, received } = await startServer();
    await new CardsAPI(client).listCards({ status: DONE_A });

    expect(cardsCalls(received)[0].url).toContain(`columnId=${DONE_A}`);
  });

  it('a board/column mismatch is refused with that board\'s real columns, and never reaches the wire', async () => {
    const { client, received } = await startServer();
    const attempt = new CardsAPI(client).listCards({ boardId: BOARD_A, status: DOING_B });

    await expect(attempt).rejects.toBeInstanceOf(ColumnResolutionError);
    const error = (await attempt.catch((e: unknown) => e)) as ColumnResolutionError;

    expect(error.message).toContain(BOARD_B);
    expect(error.candidates.map((c) => c.columnId).sort()).toEqual([DOING_A, DONE_A].sort());
    expect(cardsCalls(received)).toHaveLength(0);
  });

  it('a column and a collection together are refused before any call', async () => {
    const { client, received } = await startServer();
    await expect(
      new CardsAPI(client).listCards({ collectionId: 'coll-1', status: 'Doing' }),
    ).rejects.toThrow('--collection');

    expect(received).toHaveLength(0);
  });

  it('two columns with the same name on one board refuse, with both ids listed', async () => {
    const { client, received } = await startServer();
    const attempt = new CardsAPI(client).listCards({ boardId: BOARD_DUP, status: 'Review' });

    await expect(attempt).rejects.toThrow(DUP_1);
    await expect(attempt).rejects.toThrow(DUP_2);
    expect(cardsCalls(received)).toHaveLength(0);
  });

  it('an unknown column name is missing-or-not-visible, with the real columns listed', async () => {
    const { client } = await startServer();
    const attempt = new CardsAPI(client).listCards({ boardId: BOARD_A, status: 'Nope' });

    await expect(attempt).rejects.toThrow('missing or not visible to your key');
    await expect(attempt).rejects.toThrow('Doing');
  });

  it('the whole org fills from one /widgets call, which inlines columns', async () => {
    const { client, received } = await startServer();
    const directory = new ColumnDirectory(client, ORG);
    await directory.resolveColumnId('Doing', BOARD_A);
    await directory.resolveColumnId('Doing', BOARD_B);
    await directory.nameOf(DONE_A);

    expect(received.filter((r) => r.url.startsWith('/api/v1/widgets'))).toHaveLength(1);
    expect(received.filter((r) => r.url.startsWith('/api/v1/columns'))).toHaveLength(0);
  });
});
