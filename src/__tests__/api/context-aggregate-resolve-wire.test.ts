/**
 * The two fuzzy matchers are gone — #122, ADR-0003.
 *
 * `api/context.ts` used to fall back to `boards.find(b => b.name.includes(…))`
 * with first-match-wins and no ambiguity refusal, and `api/aggregate.ts` did the
 * same for collections. Between them 17 command modules asked about one board
 * or collection and could be answered about another, with no signal.
 *
 * Both now route through the resolver, so the questions here are: does a
 * substring still win (it must not), and does a collision refuse with every
 * candidate listed (it must).
 *
 * No client mock — a real `node:http` server stands in for Favro, so the
 * assertions are about what Favro RECEIVES and what the caller OBSERVES.
 */
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { AddressInfo } from 'net';

// resolveNameToId reads and writes the on-disk name cache. Redirect it before
// anything imports the config module.
const TMP_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'favro-resolve-wire-'));
process.env.FAVRO_CONFIG_DIR = TMP_CONFIG_DIR;

import FavroHttpClient from '../../lib/http-client';
import { ContextAPI } from '../../api/context';
import AggregateAPI from '../../api/aggregate';

afterAll(() => {
  fs.rmSync(TMP_CONFIG_DIR, { recursive: true, force: true });
});

interface Received {
  method: string;
  url: string;
}

type Reply = { status: number; body?: unknown };

async function startServer(handler: (req: Received) => Reply): Promise<{
  context: ContextAPI;
  aggregate: AggregateAPI;
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
      // No organizationId: the cache is disabled, never the lookup — so each
      // test sees the listing this server serves and nothing a sibling wrote.
      const client = new FavroHttpClient({ baseURL: `http://127.0.0.1:${port}/api/v1` });
      resolve({
        context: new ContextAPI(client),
        aggregate: new AggregateAPI(client),
        urls: () => received.map((r) => r.url.replace('/api/v1', '')),
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** The Error a refusal threw. Fails loudly if the call unexpectedly succeeded. */
const refusal = (promise: Promise<unknown>): Promise<Error> =>
  promise.then(
    () => {
      throw new Error('expected a refusal, got a result');
    },
    (error: Error) => error,
  );

const DEV = '77a732ee70173a24439818ca';
const DEV_TWIN = '5f2a11bb70173a2443981000';
const COLL_WEB = 'c0a732ee70173a2443981111';
const COLL_WEB_TWIN = 'c1b732ee70173a2443982222';

const widget = (id: string, name: string) => ({
  widgetCommonId: id,
  name,
  collectionIds: [],
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
});

/** A Favro serving the given boards and collections, and honest 403s otherwise. */
function favro(
  widgets: Array<ReturnType<typeof widget>>,
  collections: Array<{ collectionId: string; name: string }> = [],
) {
  return (req: Received): Reply => {
    const [pathname] = req.url.replace('/api/v1', '').split('?');

    if (pathname === '/widgets') return { status: 200, body: { entities: widgets } };
    if (pathname.startsWith('/widgets/')) {
      const found = widgets.find((w) => w.widgetCommonId === pathname.slice('/widgets/'.length));
      return found ? { status: 200, body: found } : { status: 403, body: { message: 'Access denied' } };
    }
    if (pathname === '/collections') return { status: 200, body: { entities: collections } };
    if (pathname.startsWith('/collections/')) {
      const found = collections.find((c) => c.collectionId === pathname.slice('/collections/'.length));
      return found ? { status: 200, body: found } : { status: 403, body: { message: 'Page not found' } };
    }
    return { status: 200, body: { entities: [] } };
  };
}

describe('ContextAPI.resolveBoard — no substring fallback', () => {
  test('an exact name resolves', async () => {
    const { context, close } = await startServer(favro([widget(DEV, 'Dev Board')]));
    try {
      expect((await context.resolveBoard('Dev Board')).boardId).toBe(DEV);
    } finally {
      await close();
    }
  });

  test('an id reads directly', async () => {
    const { context, urls, close } = await startServer(favro([widget(DEV, 'Dev Board')]));
    try {
      expect((await context.resolveBoard(DEV)).boardId).toBe(DEV);
      expect(urls()).toEqual([`/widgets/${DEV}`]);
    } finally {
      await close();
    }
  });

  test('a substring of a real name resolves nothing — it used to win', async () => {
    const { context, close } = await startServer(favro([widget(DEV, 'Dev Board')]));
    try {
      // The deleted matcher answered "Dev Board" here, with no signal at all.
      const err = await refusal(context.resolveBoard('Dev'));
      expect(err.message).toContain('missing or not visible to your key');
      expect(err.message).toContain('Dev Board');
    } finally {
      await close();
    }
  });

  test('a colliding name refuses with EVERY candidate, not the first', async () => {
    const { context, close } = await startServer(
      favro([widget(DEV, 'Dev Board'), widget(DEV_TWIN, 'dev board')]),
    );
    try {
      const err = await refusal(context.resolveBoard('Dev Board'));
      expect(err.message).toContain('2 boards are named "Dev Board" — refusing to pick one.');
      expect(err.message).toContain(DEV);
      expect(err.message).toContain(DEV_TWIN);
      expect(err.message).toContain('Pass the id instead');
    } finally {
      await close();
    }
  });
});

describe('AggregateAPI.getCollectionSnapshot — no substring fallback', () => {
  test('a substring of a real name resolves nothing', async () => {
    const { aggregate, close } = await startServer(
      favro([], [{ collectionId: COLL_WEB, name: 'Web Hub' }]),
    );
    try {
      const err = await refusal(aggregate.getCollectionSnapshot('Web'));
      expect(err.message).toContain('missing or not visible to your key');
      expect(err.message).toContain('Web Hub');
    } finally {
      await close();
    }
  });

  test('a colliding name refuses with every candidate', async () => {
    const { aggregate, close } = await startServer(
      favro([], [
        { collectionId: COLL_WEB, name: 'Web Hub' },
        { collectionId: COLL_WEB_TWIN, name: 'web hub' },
      ]),
    );
    try {
      const err = await refusal(aggregate.getCollectionSnapshot('Web Hub'));
      expect(err.message).toContain('2 collections are named "Web Hub" — refusing to pick one.');
      expect(err.message).toContain(COLL_WEB);
      expect(err.message).toContain(COLL_WEB_TWIN);
    } finally {
      await close();
    }
  });

  test('an exact name scopes the snapshot to that collection', async () => {
    const { aggregate, close } = await startServer(
      favro([], [{ collectionId: COLL_WEB, name: 'Web Hub' }]),
    );
    try {
      const snapshot = await aggregate.getCollectionSnapshot('Web Hub');
      expect(snapshot.collections.map((c) => c.id)).toEqual([COLL_WEB]);
    } finally {
      await close();
    }
  });

  // The fast path survived the deletion — only the substring fallback and the
  // bare `catch {}` that reached it are gone. Same shape the board side keeps,
  // which is the point: the two resolve alike or the next reader has to work
  // out why not.
  test('an id opens with a direct read, not a listing scan', async () => {
    const { aggregate, urls, close } = await startServer(
      favro([], [{ collectionId: COLL_WEB, name: 'Web Hub' }]),
    );
    try {
      await aggregate.getCollectionSnapshot(COLL_WEB);
      // Resolution OPENS with the read. It does not open by listing the org
      // and scanning for the id, which is what dropping the fast path did.
      expect(urls()[0]).toBe(`/collections/${COLL_WEB}`);
    } finally {
      await close();
    }
  });

  // A one-word name is id-shaped, so it is tried as an id first and only
  // Favro's classified "Page not found" escalates it to the name lookup.
  test('a one-word name escalates on the wire’s classified not-found', async () => {
    const { aggregate, urls, close } = await startServer(
      favro([], [{ collectionId: COLL_WEB, name: 'Hub' }]),
    );
    try {
      const snapshot = await aggregate.getCollectionSnapshot('Hub');
      expect(snapshot.collections.map((c) => c.id)).toEqual([COLL_WEB]);
      expect(urls()[0]).toBe('/collections/Hub');
      expect(urls()).toContain('/collections?limit=100');
    } finally {
      await close();
    }
  });
});
