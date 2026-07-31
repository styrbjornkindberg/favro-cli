/**
 * Wire-level tests for board/collection name resolution — issue #41.
 *
 * Same discipline as the card wire suites: no client mock. A real `node:http`
 * server stands in for Favro, so axios builds the URL and the assertions are
 * about what Favro actually RECEIVES (path + query string) and what the caller
 * OBSERVES. A client mock would only re-state our own outgoing shape, and the
 * thing worth pinning here is call *count* and call *order* — "1 call + 1"
 * instead of 322 rows plus a collections sweep.
 *
 * Favro facts these tests encode:
 * - `/widgets?collectionId=…` narrows server-side.
 * - A collectionId that does not exist answers **200 with an empty page**, not
 *   an error — which is why the collection argument is resolved against the
 *   real listing rather than passed through.
 * - A withheld or absent widget answers **403 {"message":"Access denied"}**,
 *   and a collection **403 {"message":"Page not found"}** (see #38).
 */
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import BoardsAPI from '../lib/boards-api';
import CollectionsAPI from '../lib/collections-api';

interface Received {
  method: string;
  url: string;
}

type Reply = { status: number; body?: unknown };

async function startServer(
  handler: (req: Received) => Reply,
  organizationId?: string
): Promise<{
  boards: BoardsAPI;
  collections: CollectionsAPI;
  received: Received[];
  urls: () => string[];
  close: () => Promise<void>;
}> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      const entry = { method: req.method ?? '', url: req.url ?? '' };
      received.push(entry);
      const { status, body } = handler(entry);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body ?? {}));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const client = new FavroHttpClient({
        baseURL: `http://127.0.0.1:${port}/api/v1`,
        auth: organizationId ? { organizationId } : undefined,
      });
      resolve({
        boards: new BoardsAPI(client),
        collections: new CollectionsAPI(client),
        received,
        urls: () => received.map((r) => r.url.replace('/api/v1', '')),
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** The Error a refusal threw. Fails loudly if the call unexpectedly succeeded. */
const refusal = (promise: Promise<unknown>): Promise<Error> =>
  promise.then(
    () => { throw new Error('expected a refusal, got a result'); },
    (error: Error) => error
  );

const widget = (id: string, name: string, collectionId?: string) => ({
  widgetCommonId: id,
  name,
  collectionIds: collectionId ? [collectionId] : [],
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
});

const HUB = '77a732ee70173a24439818ca';
const OTHER = '5f2a11bb70173a2443981000';
const COLL = 'c0a732ee70173a2443981111';

/** A Favro with two boards and one collection, and honest 403s for the rest. */
function favro(widgets = [widget(HUB, 'Backlog - Web Hub', COLL), widget(OTHER, 'Sales', 'other')]) {
  return (req: Received): Reply => {
    const [pathname, query = ''] = req.url.replace('/api/v1', '').split('?');
    const params = new URLSearchParams(query);

    if (pathname === '/widgets') {
      const collectionId = params.get('collectionId');
      const entities = collectionId
        ? widgets.filter((w) => (w.collectionIds ?? []).includes(collectionId))
        : widgets;
      return { status: 200, body: { entities } };
    }
    if (pathname.startsWith('/widgets/')) {
      const found = widgets.find((w) => w.widgetCommonId === pathname.slice('/widgets/'.length));
      return found ? { status: 200, body: found } : { status: 403, body: { message: 'Access denied' } };
    }
    if (pathname === '/collections') {
      return { status: 200, body: { entities: [{ collectionId: COLL, name: 'Web Hub', createdAt: '', updatedAt: '' }] } };
    }
    if (pathname.startsWith('/collections/')) {
      const id = pathname.slice('/collections/'.length);
      return id === COLL
        ? { status: 200, body: { collectionId: COLL, name: 'Web Hub', createdAt: '', updatedAt: '' } }
        : { status: 403, body: { message: 'Page not found' } };
    }
    return { status: 404, body: {} };
  };
}

describe('boards get by name (no client mock)', () => {
  test('a name with a space is listed once, then read by the id it resolved to', async () => {
    const { boards, urls, close } = await startServer(favro());
    try {
      const board = await boards.getBoard('Backlog - Web Hub');
      expect(board.boardId).toBe(HUB);
      expect(urls()).toEqual(['/widgets?limit=100', `/widgets/${HUB}`]);
    } finally {
      await close();
    }
  });

  test('an id costs no listing at all', async () => {
    const { boards, urls, close } = await startServer(favro());
    try {
      await boards.getBoard(HUB);
      expect(urls()).toEqual([`/widgets/${HUB}`]);
    } finally {
      await close();
    }
  });

  test("a one-word name is tried as an id first, then escalated on Favro's 403", async () => {
    const { boards, urls, close } = await startServer(favro([widget(HUB, 'Backlog', COLL)]));
    try {
      const board = await boards.getBoard('Backlog');
      expect(board.boardId).toBe(HUB);
      expect(urls()).toEqual(['/widgets/Backlog', '/widgets?limit=100', `/widgets/${HUB}`]);
    } finally {
      await close();
    }
  });

  test('matching is trimmed and case-insensitive', async () => {
    const { boards, close } = await startServer(favro());
    try {
      expect((await boards.getBoard('  backlog - WEB hub  ')).boardId).toBe(HUB);
    } finally {
      await close();
    }
  });

  test('matching is exact — a prefix of a real name resolves nothing', async () => {
    const { boards, close } = await startServer(favro());
    try {
      await expect(boards.getBoard('Backlog - Web')).rejects.toThrow(/missing or not visible to your key/);
    } finally {
      await close();
    }
  });

  test('an unresolvable name refuses with the ambiguous wording, never a bare "not found"', async () => {
    const { boards, close } = await startServer(favro());
    try {
      await expect(boards.getBoard('No Such Board')).rejects.toThrow(
        /No board named "No Such Board" — it is missing or not visible to your key/
      );
      await expect(boards.getBoard('No Such Board')).rejects.not.toThrow(/not found/);
    } finally {
      await close();
    }
  });

  test('a duplicated name refuses with every colliding id and the disambiguating flag', async () => {
    const dupes = [widget(HUB, 'Backlog', COLL), widget(OTHER, 'backlog ', COLL)];
    const { boards, received, close } = await startServer(favro(dupes));
    try {
      // A leading space skips the id probe and goes straight to the name path.
      const dup = await refusal(boards.getBoard(' Backlog '));
      expect(dup.message).toContain('2 boards are named " Backlog " — refusing to pick one.');
      expect(dup.message).toContain(HUB);
      expect(dup.message).toContain(OTHER);
      expect(dup.message).toContain('Pass the id instead: favro boards get <boardId>');
      // Never picks one: no `/widgets/<id>` read followed the refusal.
      expect(received.filter((r) => /\/widgets\/[^?]+$/.test(r.url))).toHaveLength(0);
    } finally {
      await close();
    }
  });
});

describe('boards list --collection filters on the wire', () => {
  test('a collection name costs one resolve call plus one filtered listing', async () => {
    const { boards, urls, close } = await startServer(favro());
    try {
      const rows = await boards.listBoardsByCollection('Web Hub');
      expect(rows.map((b) => b.boardId)).toEqual([HUB]);
      expect(urls()).toEqual(['/collections?limit=100', `/widgets?collectionId=${COLL}&limit=50`]);
    } finally {
      await close();
    }
  });

  test('a collection id still narrows on the wire', async () => {
    const { boards, urls, close } = await startServer(favro());
    try {
      await boards.listBoardsByCollection(COLL);
      expect(urls()).toEqual(['/collections?limit=100', `/widgets?collectionId=${COLL}&limit=50`]);
    } finally {
      await close();
    }
  });

  test('an unknown collection refuses instead of answering an empty page', async () => {
    const { boards, urls, close } = await startServer(favro());
    try {
      const err = await refusal(boards.listBoardsByCollection('Nope'));
      expect(err.message).toContain('missing or not visible to your key');
      expect(err.message).toContain('Web Hub');
      // The refusal is pre-call: Favro would have answered 200 + [] here.
      expect(urls()).toEqual(['/collections?limit=100']);
    } finally {
      await close();
    }
  });

  test('a duplicated collection name names the flag that disambiguates it', async () => {
    const { boards, close } = await startServer((req) => {
      if (req.url.startsWith('/api/v1/collections?')) {
        return {
          status: 200,
          body: {
            entities: [
              { collectionId: COLL, name: 'Web Hub' },
              { collectionId: 'c1b732ee70173a2443982222', name: 'web hub' },
            ],
          },
        };
      }
      return favro()(req);
    });
    try {
      const err = await refusal(boards.listBoardsByCollection('Web Hub'));
      expect(err.message).toContain('2 collections are named "Web Hub" — refusing to pick one.');
      expect(err.message).toContain('Pass the id instead: favro boards list --collection <collectionId>');
    } finally {
      await close();
    }
  });
});

describe('collections get by name (no client mock)', () => {
  test('resolves an exact name to its id and reads it', async () => {
    const { collections, urls, close } = await startServer(favro());
    try {
      const found = await collections.getCollection('Web Hub');
      expect(found.collectionId).toBe(COLL);
      expect(urls()).toEqual(['/collections?limit=100', `/collections/${COLL}`]);
    } finally {
      await close();
    }
  });

  test('an id reads directly', async () => {
    const { collections, urls, close } = await startServer(favro());
    try {
      await collections.getCollection(COLL);
      expect(urls()).toEqual([`/collections/${COLL}`]);
    } finally {
      await close();
    }
  });

  test("a one-word name escalates on Favro's 403 'Page not found'", async () => {
    const { collections, urls, close } = await startServer((req) => {
      if (req.url.startsWith('/api/v1/collections?')) {
        return { status: 200, body: { entities: [{ collectionId: COLL, name: 'Hub' }] } };
      }
      return favro()(req);
    });
    try {
      expect((await collections.getCollection('Hub')).collectionId).toBe(COLL);
      expect(urls()).toEqual(['/collections/Hub', '/collections?limit=100', `/collections/${COLL}`]);
    } finally {
      await close();
    }
  });

  test('an unresolvable name refuses with the ambiguous wording', async () => {
    const { collections, close } = await startServer(favro());
    try {
      await expect(collections.getCollection('Ghost Collection')).rejects.toThrow(
        /No collection named "Ghost Collection" — it is missing or not visible to your key/
      );
    } finally {
      await close();
    }
  });
});

describe('resolution reuses the persistent cache', () => {
  let dir: string;
  let previous: string | undefined;

  beforeEach(async () => {
    previous = process.env.FAVRO_CONFIG_DIR;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-resolve-'));
    process.env.FAVRO_CONFIG_DIR = dir;
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.FAVRO_CONFIG_DIR;
    else process.env.FAVRO_CONFIG_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('a second resolution in the same org costs no second listing', async () => {
    const { collections, urls, close } = await startServer(favro(), 'org-1');
    try {
      await collections.getCollection('Web Hub');
      await collections.getCollection('Web Hub');
      expect(urls()).toEqual([
        '/collections?limit=100',
        `/collections/${COLL}`,
        `/collections/${COLL}`,
      ]);
    } finally {
      await close();
    }
  });
});
