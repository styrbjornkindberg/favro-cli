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
import * as fs from 'fs';
import * as path from 'path';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import CardsAPI, { unknownTagMessage } from '../lib/cards-api';
import { CompensationLog, TxCards } from '../lib/tx-cards';
import { RefusalError } from '../lib/refusal';
import { tempConfigDir } from '../test-support/config-dir';

// The tag path is cache-backed and invalidates on a miss; the cache resolves its
// file per call, so a tmpdir keeps this suite off the real `~/.favro`.
const CONFIG_DIR = tempConfigDir('favro-tags-wire-');
const CACHE_FILE = path.join(CONFIG_DIR, 'name-cache.json');
const ORG = 'org-tags-wire';

// The cache is a file that outlives a test. Every case below starts from an
// empty one, so a hit is only ever the one the case itself planted.
//
// `invalidateCache()`, NOT `fs.rmSync` of the file. `name-cache` memoises the
// parsed file in a module global that only its own `writeFile` clears, and this
// suite keeps ONE `FAVRO_CONFIG_DIR` for every case — so the memo path matches
// and unlinking the file left the previous case's records being served from
// memory. Measured before this change: 8 of the 14 cases below began with a
// `tags` record they never planted, and the comment above was false for all of
// them. `invalidateCache()` truncates through `writeFile`, which is what drops
// the memo.
//
// The claim is asserted right here, per case, rather than in a test of its own:
// WHICH cases the old cleanup left dirty depends entirely on ordering, so a
// standalone test passes or fails on where it happens to land — one placed last
// in this file stayed green, because the case before it invalidates. Measured
// both ways: `fs.rmSync` here fails 12 of the 14 cases, `invalidateCache()`
// passes all 14.
beforeEach(async () => {
  const { invalidateCache, readCacheRecord } = await import('../lib/name-cache');
  await invalidateCache();
  expect(await readCacheRecord(ORG, 'tags')).toBeUndefined();
});

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
  organizationId: string | null = ORG,
): Promise<{ api: CardsAPI; client: FavroHttpClient; received: Received[]; close: () => Promise<void> }> {
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
      const client = new FavroHttpClient({
        baseURL: `http://127.0.0.1:${port}/api/v1`,
        ...(organizationId ? { auth: { organizationId } } : {}),
      });
      resolve({
        api: new CardsAPI(client as any),
        client,
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

  // #62: this used to go out as `addTags`, which to Favro is a tag CREATION.
  // On a key that holds the permission a typo silently and permanently added a
  // junk tag to the workspace — the same reason `cards create --tag` validates
  // client-side. Refusing is the only outcome an agent can act on.
  test('an unknown name is REFUSED, not handed to Favro to create', async () => {
    const { api, received, close } = await startServer(favro([]));
    try {
      await expect(api.updateCard(CARD, { tags: ['brand-new'] })).rejects.toThrow(RefusalError);
      await expect(api.updateCard(CARD, { tags: ['brand-new'] })).rejects.toThrow(
        /Unknown tag "brand-new"/,
      );
      expect(received.some((r) => r.method === 'PUT')).toBe(false);
      expect(received.map((r) => r.body).join('')).not.toContain('addTags');
    } finally {
      await close();
    }
  });

  test('a known name alongside an unknown one refuses the WHOLE write', async () => {
    // Partial application would leave the card in a state nobody asked for and
    // no undo entry describes.
    const { api, received, close } = await startServer(favro([]));
    try {
      await expect(api.updateCard(CARD, { tags: ['Bug', 'brand-new'] })).rejects.toThrow(
        /Unknown tag "brand-new"/,
      );
      expect(received.some((r) => r.method === 'PUT')).toBe(false);
    } finally {
      await close();
    }
  });

  test('a tag created since the last read is not refused on stale cache evidence', async () => {
    // The refusal must never fire on the cache alone: `favro tags create X` then
    // `cards update --tags X` has to work inside the 15-minute TTL.
    let listings = 0;
    const { api, received, close } = await startServer((req) => {
      if (req.method === 'GET' && req.url?.startsWith('/api/v1/tags')) {
        listings += 1;
        const entities = [{ tagId: BUG_ID, name: 'Bug' }];
        if (listings > 1) entities.push({ tagId: DEVOP_ID, name: 'fresh' });
        return { status: 200, body: { entities } };
      }
      return { status: 200, body: { cardId: CARD, name: 'probe', tags: [] } };
    });
    try {
      await api.updateCard(CARD, { tags: ['fresh'] });
      expect(putBody(received)).toEqual({ addTagIds: [DEVOP_ID] });
      expect(listings).toBeGreaterThan(1);
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

  // `client.organizationId` comes from saved auth, and `favro auth` warns it may
  // be absent ("Organization ID not saved"). The tag path used to react to a
  // cache miss with `invalidateCache(undefined, 'tags')`, which discarded the
  // kind and truncated the file for EVERY org — observed live as a 2-byte
  // `~/.favro/name-cache.json`. A tag write must never be able to do that.
  // An unknown tag is what drives the code to the invalidate, and a typo is how
  // an agent gets there. That invalidate used to run as
  // `invalidateCache(undefined, 'tags')`, which discarded the kind and truncated
  // the file for EVERY org.
  test('a REFUSED tag write with no organizationId leaves other orgs\' cache intact', async () => {
    const planted = {
      'other-org': { tags: { fetchedAt: Date.now(), entries: [{ tagId: 'x1', name: 'keepme' }] } },
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(planted));
    const { api, close } = await startServer(favro([]), null);
    try {
      await expect(api.updateCard(CARD, { tags: ['brand-new'] })).rejects.toThrow(RefusalError);
      expect(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'))).toEqual(planted);
    } finally {
      await close();
    }
  });

  // Without an org there is no cache, so the list just fetched is already live —
  // the refill re-asked the identical question over the wire for nothing.
  test('no organizationId costs exactly one tag listing, not two', async () => {
    const { api, received, close } = await startServer(favro([]), null);
    try {
      await expect(api.updateCard(CARD, { tags: ['brand-new'] })).rejects.toThrow(RefusalError);
      expect(received.filter((r) => r.url.startsWith('/api/v1/tags'))).toHaveLength(1);
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

// #62's stated goal: the create, update and tx tag-write paths "cannot drift".
// `TxCards.setTags` kept a hand-written copy of the refusal instead of calling
// the shared helper, so the wording had already drifted — the copy omitted the
// tag name from the `favro tags create` advice.
describe('TxCards.setTags refuses on the same wording as the other tag writes', () => {
  test('an unknown tag refuses with unknownTagMessage, byte for byte, and writes nothing', async () => {
    const { api, client, received, close } = await startServer(favro([]));
    try {
      const tx = new TxCards(api, new CompensationLog(), client as any);
      await expect(tx.setTags(CARD, ['brand-new'])).rejects.toThrow(RefusalError);
      await expect(tx.setTags(CARD, ['brand-new'])).rejects.toThrow(
        unknownTagMessage(['brand-new']),
      );
      expect(received.some((r) => r.method === 'PUT')).toBe(false);
    } finally {
      await close();
    }
  });
});
