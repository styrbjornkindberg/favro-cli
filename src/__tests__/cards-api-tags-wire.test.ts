/**
 * Wire-level tests for the card tag-write path — issue #16.
 *
 * Same discipline as the dependency wire tests: no client mock. A real
 * `node:http` server stands in for Favro, so the axios stack builds the URL and
 * serialises the body, and the assertions are about what Favro actually
 * receives. A client mock could not have caught the bug this fixes — `PUT
 * /cards/:cardId {tags:[…]}` answers **200 and changes nothing**, so the old
 * pass-through reported success and mutated no state.
 *
 * Expectations below are pinned to responses observed against the live Favro
 * API on 2026-07-31 (throwaway board, cards and board deleted by the probe):
 *
 * - `PUT {tags:["probe-alpha"]}`      → 200, tags unchanged (`[]`).
 * - `PUT {addTags:["Bug"]}`           → 200, tags `["0b49b8…"]` (write by name, read as id).
 * - `PUT {addTags:["probe-alpha"]}`   → 403 "User does not have correct permission
 *                                       level in workspace" — an unknown name is a
 *                                       tag *creation*, which this key may not do.
 * - `PUT {addTagIds:[id]}` / `{removeTags:[name]}` / `{removeTagIds:[id]}` → all honoured.
 * - `POST /cards {tags:["Bug"]}`      → honoured at create time; only the PUT ignores `tags`.
 */
import * as http from 'http';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import CardsAPI from '../lib/cards-api';

interface Received {
  method: string;
  url: string;
  body: string;
}

const CARD = '713db3018af39956227d4279';
const BUG_ID = '0b49b86eba332b1b342f844c';
const DEVOP_ID = '4HGKcSnW2xuXvnQqN';

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

/** Favro as far as the tag path cares: one card with `currentTags`, a 2-tag org. */
function favro(currentTags: string[]) {
  return (req: Received) => {
    if (req.method === 'GET' && req.url?.startsWith('/api/v1/tags')) {
      return {
        status: 200,
        body: {
          entities: [
            { tagId: BUG_ID, name: 'Bug' },
            { tagId: DEVOP_ID, name: 'devop' },
          ],
        },
      };
    }
    if (req.method === 'GET' && req.url?.startsWith(`/api/v1/cards/${CARD}`)) {
      return { status: 200, body: { cardId: CARD, name: 'probe', tags: currentTags } };
    }
    return { status: 200, body: { cardId: CARD, name: 'probe', tags: currentTags } };
  };
}

function putBody(received: Received[]): Record<string, unknown> {
  const put = received.find((r) => r.method === 'PUT');
  if (!put) throw new Error('no PUT was sent');
  return JSON.parse(put.body);
}

describe('updateCard tag writes (no client mock)', () => {
  test('never sends `tags` — Favro 200s on it and changes nothing', async () => {
    const { api, received, close } = await startServer(favro([]));
    try {
      await api.updateCard(CARD, { tags: ['Bug'] });
      expect(putBody(received)).not.toHaveProperty('tags');
    } finally {
      await close();
    }
  });

  test('resolves known names to ids and diffs against the card\'s current tags', async () => {
    // Card holds Bug; caller wants devop only → add devop, remove Bug.
    const { api, received, close } = await startServer(favro([BUG_ID]));
    try {
      await api.updateCard(CARD, { tags: ['devop'] });
      expect(putBody(received)).toEqual({
        addTagIds: [DEVOP_ID],
        removeTagIds: [BUG_ID],
      });
    } finally {
      await close();
    }
  });

  test('a name already on the card produces no add and no remove', async () => {
    const { api, received, close } = await startServer(favro([BUG_ID]));
    try {
      await api.updateCard(CARD, { tags: ['Bug'] });
      expect(putBody(received)).toEqual({});
    } finally {
      await close();
    }
  });

  test('accepts tagIds as well as names, so a read-then-write round-trip is stable', async () => {
    // `Card.tags` is ids, so the batch undo path hands back ids, not names.
    const { api, received, close } = await startServer(favro([BUG_ID, DEVOP_ID]));
    try {
      await api.updateCard(CARD, { tags: [BUG_ID, DEVOP_ID] });
      expect(putBody(received)).toEqual({});
    } finally {
      await close();
    }
  });

  test('an unknown name goes out as addTags, so Favro creates it or 403s loudly', async () => {
    const { api, received, close } = await startServer(favro([]));
    try {
      await api.updateCard(CARD, { tags: ['brand-new'] });
      expect(putBody(received)).toEqual({ addTags: ['brand-new'] });
    } finally {
      await close();
    }
  });

  test('matches names case-insensitively rather than creating a near-duplicate tag', async () => {
    const { api, received, close } = await startServer(favro([]));
    try {
      await api.updateCard(CARD, { tags: ['BUG'] });
      expect(putBody(received)).toEqual({ addTagIds: [BUG_ID] });
    } finally {
      await close();
    }
  });

  test('clearing tags removes every current id', async () => {
    const { api, received, close } = await startServer(favro([BUG_ID, DEVOP_ID]));
    try {
      await api.updateCard(CARD, { tags: [] });
      expect(putBody(received)).toEqual({ removeTagIds: [BUG_ID, DEVOP_ID] });
    } finally {
      await close();
    }
  });

  test('addTags/removeTags pass straight through and cost no extra reads', async () => {
    const { api, received, close } = await startServer(favro([BUG_ID]));
    try {
      await api.updateCard(CARD, { addTags: ['devop'], removeTags: ['Bug'] });
      expect(received).toHaveLength(1);
      expect(received[0].method).toBe('PUT');
      expect(JSON.parse(received[0].body)).toEqual({
        addTags: ['devop'],
        removeTags: ['Bug'],
      });
    } finally {
      await close();
    }
  });

  test('surfaces Favro\'s 403 on an unpermitted tag creation instead of swallowing it', async () => {
    const { api, close } = await startServer((req) => {
      if (req.method === 'PUT') {
        return { status: 403, body: { message: 'User does not have correct permission level in workspace' } };
      }
      return favro([])(req);
    });
    try {
      await expect(api.updateCard(CARD, { addTags: ['brand-new'] })).rejects.toThrow();
    } finally {
      await close();
    }
  });
});
