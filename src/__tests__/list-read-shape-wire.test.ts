/**
 * Wire-level tests for the agent output shape and the archived selector —
 * issues #44 and #45.
 *
 * What these pin down cannot be seen from a client mock:
 *
 *  - `--limit` used to truncate the FETCH, so the pagination loop stopped early
 *    and every client-side filter downstream filtered a partial set. The proof
 *    is the number of `GET /cards` requests the server actually receives.
 *  - `archived` is a Favro SELECTOR: its absence means "mixed", not "live", so
 *    the assertion has to be about the query string, not about the rows.
 *  - Omission is a rendering decision. The proof is that the read still returns
 *    the field the renderer drops.
 */
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import CardsAPI from '../lib/cards-api';
import {
  boundedSweep,
  capRows,
  omitBulk,
  omittedFields,
  SWEEP_CAP,
} from '../lib/read-shape';

const ORG = 'org-1';
const BOARD = 'board-a';

interface Received { method: string; url: string }

/** Every server this file started, so a failed assertion cannot leak one. */
const running: http.Server[] = [];

/**
 * A Favro stand-in serving `pages` pages of `perPage` cards each, so the
 * pagination loop is observable.
 */
function startServer(options: { pages?: number; perPage?: number; status?: number } = {}): Promise<{
  client: FavroHttpClient;
  received: Received[];
}> {
  const pages = options.pages ?? 1;
  const perPage = options.perPage ?? 2;
  const received: Received[] = [];
  let served = 0;

  const server = http.createServer((req, res) => {
    req.on('data', () => { /* no bodies on this path */ });
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '' });
      const url = req.url ?? '';

      if (url.startsWith('/api/v1/widgets') || url.startsWith('/api/v1/tags')) {
        // `/widgets` carries the board, because every card read now settles
        // `--board` against the listing before it reaches the wire (#82).
        const entities = url.startsWith('/api/v1/widgets')
          ? [{ widgetCommonId: BOARD, name: 'Board A', columns: [] }]
          : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ entities }));
        return;
      }

      if (options.status && options.status >= 400) {
        res.writeHead(options.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Access denied' }));
        return;
      }

      const page = served;
      served += 1;
      const entities = Array.from({ length: perPage }, (_, i) => ({
        cardId: `card-${page}-${i}`,
        name: `Card ${page}-${i}`,
        detailedDescription: 'x'.repeat(500),
        customFields: [{ customFieldId: 'cf-1', value: 'noisy' }],
        createdAt: '2026-01-01',
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entities, requestId: 'req-1', pages, page }));
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-listshape-test-'));
  process.env.FAVRO_CONFIG_DIR = tmpDir;
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise((done) => s.close(() => done(null)))));
  if (originalConfigDir === undefined) delete process.env.FAVRO_CONFIG_DIR;
  else process.env.FAVRO_CONFIG_DIR = originalConfigDir;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('the archived selector rides the wire (#45)', () => {
  it('defaults to live cards only — archived=false, unasked', async () => {
    const { client, received } = await startServer();
    await new CardsAPI(client).listCards({ boardId: BOARD });

    expect(cardsCalls(received)[0].url).toContain('archived=false');
  });

  it("'true' reads the archive alone", async () => {
    const { client, received } = await startServer();
    await new CardsAPI(client).listCards({ boardId: BOARD, archived: 'true' });

    expect(cardsCalls(received)[0].url).toContain('archived=true');
  });

  it("'all' sends no selector at all — Favro's own default is the mixed list", async () => {
    const { client, received } = await startServer();
    await new CardsAPI(client).listCards({ boardId: BOARD, archived: 'all' });

    expect(cardsCalls(received)[0].url).not.toContain('archived');
  });
});

describe('the fetch runs to completion (#44)', () => {
  it('paginates every page, so a later filter never filters a partial set', async () => {
    const { client, received } = await startServer({ pages: 3, perPage: 2 });
    const cards = await new CardsAPI(client).listCards({ boardId: BOARD });

    expect(cardsCalls(received)).toHaveLength(3);
    expect(cards).toHaveLength(6);
  });

  it('asks the wire for the page maximum, never for a caller-shaped limit', async () => {
    const { client, received } = await startServer();
    await new CardsAPI(client).listCards({ boardId: BOARD });

    expect(cardsCalls(received)[0].url).toContain('limit=100');
  });

  it('a failing single-call read throws rather than answering an empty list', async () => {
    const { client } = await startServer({ status: 403 });

    await expect(new CardsAPI(client).listCards({ boardId: BOARD })).rejects.toThrow();
  });

  it('a true-empty board is an empty list, unambiguously', async () => {
    const { client } = await startServer({ pages: 1, perPage: 0 });

    await expect(new CardsAPI(client).listCards({ boardId: BOARD })).resolves.toEqual([]);
  });
});

describe('the envelope and the output cap', () => {
  it('a list read is always an envelope, marker or not', () => {
    expect(capRows([1, 2, 3])).toEqual({ rows: [1, 2, 3] });
    expect(capRows([])).toEqual({ rows: [] });
  });

  it('the cap trims output and says so', () => {
    expect(capRows([1, 2, 3], 2)).toEqual({ rows: [1, 2], truncated: true });
  });

  it('a cap wider than the data leaves no marker', () => {
    expect(capRows([1, 2], 10)).toEqual({ rows: [1, 2] });
  });

  it('a cap exactly the size of the data leaves no marker', () => {
    // The off-by-one: `rows.length <= cap` is the boundary, and nothing was cut.
    expect(capRows([1, 2, 3], 3)).toEqual({ rows: [1, 2, 3] });
    expect(capRows([1, 2, 3], '3')).toEqual({ rows: [1, 2, 3] });
  });

  it('a numeric PREFIX is not a cap — `parseInt` read `1e9` as 1', () => {
    // Each of these returned `{rows:[1], truncated:true}` or similar: a
    // well-formed, plausible, wrong answer to "give me effectively everything".
    for (const limit of ['1e9', '2abc', '2.7', '5,000', '1_000', 'banana']) {
      expect(capRows([1, 2, 3], limit)).toEqual({ rows: [1, 2, 3] });
    }
  });

  it('the cap is applied to output only — the read already ran to completion', async () => {
    const { client, received } = await startServer({ pages: 3, perPage: 2 });
    const cards = await new CardsAPI(client).listCards({ boardId: BOARD });
    const capped = capRows(cards, 1);

    expect(cardsCalls(received)).toHaveLength(3);
    expect(capped).toEqual({ rows: [cards[0]], truncated: true });
  });
});

describe('the denylist omits, and the read still returns', () => {
  it('a card read carries the body and custom fields the renderer drops', async () => {
    const { client } = await startServer();
    const [card] = await new CardsAPI(client).listCards({ boardId: BOARD });

    // The object the read returns is whole — that is what keeps
    // `--filter "description:foo"` real grammar rather than a dead flag.
    expect(card.description).toHaveLength(500);
    expect(card.customFields).toBeDefined();

    const [rendered] = omitBulk('card', [card]);
    expect(rendered.description).toBeUndefined();
    expect(rendered.customFields).toBeUndefined();
    expect(rendered.cardId).toBe(card.cardId);
  });

  it('--body and --include custom-fields restore their own field, not each other', async () => {
    const { client } = await startServer();
    const cards = await new CardsAPI(client).listCards({ boardId: BOARD });

    const withBody = omitBulk('card', cards, ['description', 'detailedDescription'])[0];
    expect(withBody.description).toHaveLength(500);
    expect(withBody.customFields).toBeUndefined();

    const withFields = omitBulk('card', cards, ['customFields'])[0];
    expect(withFields.customFields).toBeDefined();
    expect(withFields.description).toBeUndefined();
  });

  it('omission never mutates the rows it was handed', () => {
    const rows = [{ cardId: 'c1', description: 'body' }];
    omitBulk('card', rows);
    expect(rows[0].description).toBe('body');
  });

  it('is a denylist, so an unnamed field passes through — including a new one', () => {
    const [rendered] = omitBulk('card', [
      { cardId: 'c1', description: 'body', fieldFavroAddedYesterday: 42 },
    ]);
    expect(rendered.fieldFavroAddedYesterday).toBe(42);
  });

  it('collections drop the two fields that dominate their payload', () => {
    const [rendered] = omitBulk('collection', [
      { collectionId: 'coll-1', name: 'C', sharedToUsers: [1, 2, 3], boards: [{ boardId: 'b' }] },
    ]);
    expect(rendered.sharedToUsers).toBeUndefined();
    expect(rendered.boards).toBeUndefined();
    expect(rendered.name).toBe('C');
  });

  it('a resource with no bulk field is left alone', () => {
    const rows = [{ tagId: 't1', name: 'bug' }];
    expect(omittedFields('tag')).toEqual([]);
    expect(omitBulk('tag', rows)).toEqual(rows);
  });
});

describe('boundedSweep is how a composite read stays honest', () => {
  it('returns the rows it reached and no hole when everything answers', async () => {
    const result = await boundedSweep(['a', 'b'], async (id) => ({ id }));

    expect(result.rows).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(result.unreachable).toEqual([]);
  });

  it('one bad item is a hole, not a failed sweep', async () => {
    const result = await boundedSweep(['a', 'bad', 'c'], async (id) => {
      if (id === 'bad') throw new Error('Access denied');
      return { id };
    });

    expect(result.rows).toEqual([{ id: 'a' }, { id: 'c' }]);
    expect(result.unreachable).toHaveLength(1);
    expect(result.unreachable[0].id).toBe('bad');
    expect(result.unreachable[0].reason).toBeTruthy();
  });

  it('ids past the cap are reported as unattempted, never silently dropped', async () => {
    const ids = Array.from({ length: SWEEP_CAP + 3 }, (_, i) => `id-${i}`);
    const calls: string[] = [];
    const result = await boundedSweep(ids, async (id) => { calls.push(id); return id; });

    expect(calls).toHaveLength(SWEEP_CAP);
    expect(result.rows).toHaveLength(SWEEP_CAP);
    expect(result.unreachable.map((u) => u.id)).toEqual(ids.slice(SWEEP_CAP));
    expect(result.unreachable[0].reason).toContain(String(SWEEP_CAP));
  });
});
