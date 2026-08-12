/**
 * The board id on a column arrives as `widgetCommonId`, not `boardId`.
 *
 * MEASURED 2026-08-12: `GET /columns?widgetCommonId=<board>` answers with the keys
 * `cardCount, columnId, estimationSum, name, organizationId, position, timeSum,
 * widgetCommonId`. `Column` declared a required `boardId: string`, so every read of
 * it was `undefined` while the type promised a string — and `columns update` fed
 * `col.boardId ?? ''` to `checkScope`, which refuses an empty board id **on purpose**
 * and does not let `--force` rescue it. Under a configured scope lock that command
 * therefore refused every column, however legitimate.
 *
 * A client mock cannot see this: a mock returns whatever shape the test author
 * believed in, and the belief was the defect. These assertions are about what the
 * class does with the bytes a Favro-shaped server actually sends, and about the
 * consequence at the guard — the scope check either resolves a real board or refuses.
 *
 * The third case is the one that must not regress in the other direction: a payload
 * carrying NEITHER spelling has to leave `boardId` undefined so the refusal still
 * fires. An `?? ''` normalisation there would trade a false refusal for a lock that
 * cannot see the write.
 */
import * as http from 'http';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import ColumnsAPI from '../lib/columns-api';
import { checkScope, ScopeError } from '../lib/safety';
import { FavroConfig } from '../lib/config';

const ORG = 'org-1';
const BOARD = 'board-in-scope';
const COLLECTION = 'collection-locked';
const COL_WIRE = 'col-wire';
const COL_NAMELESS = 'col-no-board';

/** Every server this file started, so a failed assertion cannot leak one. */
const running: http.Server[] = [];

/**
 * A Favro stand-in that answers columns the way the wire was measured to: with
 * `widgetCommonId` and no `boardId`. `COL_NAMELESS` carries neither, standing for a
 * response this repo has not measured and must not guess at.
 */
function startServer(): Promise<{ client: FavroHttpClient; urls: string[] }> {
  const urls: string[] = [];
  const server = http.createServer((req, res) => {
    req.on('data', () => { /* no bodies on these paths */ });
    req.on('end', () => {
      const url = req.url ?? '';
      urls.push(url);
      let body: unknown = {};
      if (url.startsWith(`/api/v1/columns/${COL_NAMELESS}`)) {
        body = { columnId: COL_NAMELESS, name: 'Orphan', position: 0 };
      } else if (url.startsWith(`/api/v1/columns/${COL_WIRE}`)) {
        body = { columnId: COL_WIRE, name: 'Doing', position: 1, widgetCommonId: BOARD, cardCount: 3 };
      } else if (url.startsWith('/api/v1/columns')) {
        body = {
          entities: [
            { columnId: COL_WIRE, name: 'Doing', position: 1, widgetCommonId: BOARD, cardCount: 3 },
            { columnId: 'col-todo', name: 'Todo', position: 0, widgetCommonId: BOARD, cardCount: 5 },
          ],
          page: 0,
          pages: 1,
        };
      } else if (url.startsWith(`/api/v1/widgets/${BOARD}`)) {
        body = { widgetCommonId: BOARD, name: 'Board', collectionIds: [COLLECTION] };
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
        urls,
      });
    });
  });
}

const lockedConfig: FavroConfig = {
  scopeCollectionId: COLLECTION,
  scopeCollectionName: 'Locked collection',
} as FavroConfig;

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise((done) => s.close(() => done(null)))));
});

describe('a column carries its board as widgetCommonId', () => {
  it('getColumn fills boardId from the widgetCommonId the wire actually sent', async () => {
    const { client } = await startServer();

    const column = await new ColumnsAPI(client).getColumn(COL_WIRE);

    expect(column.boardId).toBe(BOARD);
  });

  it('listColumns fills it on every row, not just the first', async () => {
    const { client } = await startServer();

    const columns = await new ColumnsAPI(client).listColumns(BOARD);

    expect(columns.map((c) => c.boardId)).toEqual([BOARD, BOARD]);
  });

  it('the scope lock resolves the real board instead of refusing a legitimate column', async () => {
    const { client, urls } = await startServer();
    const api = new ColumnsAPI(client);

    // Exactly what `columns update` does at the use site.
    const column = await api.getColumn(COL_WIRE);
    await expect(checkScope(column.boardId ?? '', client, lockedConfig, false)).resolves.toBeUndefined();

    // And it resolved by ASKING about that board — not by skipping the check.
    expect(urls).toContain(`/api/v1/widgets/${BOARD}`);
  });

  it('a column carrying neither spelling still refuses — fail-closed is preserved', async () => {
    const { client, urls } = await startServer();
    const api = new ColumnsAPI(client);

    const column = await api.getColumn(COL_NAMELESS);
    expect(column.boardId).toBeUndefined();

    await expect(checkScope(column.boardId ?? '', client, lockedConfig, false)).rejects.toThrow(ScopeError);
    await expect(checkScope(column.boardId ?? '', client, lockedConfig, false)).rejects.toThrow(
      'names no board',
    );

    // No board was named, so no board was asked about.
    expect(urls.some((u) => u.startsWith('/api/v1/widgets/'))).toBe(false);
  });
});
