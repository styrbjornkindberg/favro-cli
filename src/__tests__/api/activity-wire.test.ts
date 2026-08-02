/**
 * Wire-level tests for the card activity read path — issue #18.
 *
 * Same discipline as the dependency (#12), tag (#16) and description (#17) wire
 * tests: no client mock. A real `node:http` server stands in for Favro so the
 * axios stack builds the URL and query string, and the assertions are about what
 * Favro actually receives and what we do with what it sends back. The old mock
 * tests are exactly what let this bug live — they fed back a hand-written row
 * carrying `activityId` / `description` / `author` / `createdAt`, none of which
 * Favro sends, so a normalizer that produced empty strings looked correct.
 *
 * Expectations below are pinned to responses observed against the live Favro API
 * (probe recorded in #18):
 *
 * - `GET /cards/:cardId/activities`  → 200 JSON, populated on every card probed
 *                                      (1–22 rows), newest first.
 * - `GET /cards/:cardId/activity`    → 404 HTML (singular is not an endpoint).
 * - `GET /boards/:id/activity`       → 404 HTML (no board-level feed exists).
 * - `?limit=2`                       → ignored; all 22 rows still come back, so
 *                                      the cap must be applied client-side.
 * - `?page=0` / `requestId`          → ignored; a paging loop would refetch page
 *                                      0 and duplicate every row.
 * - `?since=<ISO>` / `?until=<ISO>`  → filters server-side, inclusive.
 * - `?since=nonsense`                → 400, so the window is parsed client-side.
 * - row keys                         → type, source, cardId, cardCommonId,
 *                                      cardName, widgetCommonId, widgetName,
 *                                      columnId, columnName, organizationId,
 *                                      time, byUserId. Nothing else.
 */
import * as http from 'http';
import { AddressInfo } from 'net';
import FavroHttpClient from '../../lib/http-client';
import ActivityApiClient from '../../api/activity';

interface Received {
  method: string;
  url: string;
}

const CARD = '0471a5fb295ef7e6a98fabbf';

/** A row in the exact shape Favro puts on the wire — no invented fields. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'card description changed',
    source: 'news and follow',
    cardId: CARD,
    cardCommonId: 'ce979d6e6913916fbebe84b3',
    cardName: 'Can we give the bot more options in the Calendar events?',
    widgetCommonId: '77a732ee70173a24439818ca',
    widgetName: 'Kanban',
    columnId: 'a7c8e6d2cd492bb49a35f88d',
    columnName: 'To Do',
    organizationId: 'b0b311ac98a0250191573541',
    time: '2026-07-01T17:13:41.745Z',
    byUserId: 'pk3qK36WHjnJt5jwr',
    ...overrides,
  };
}

function startServer(entities: Record<string, unknown>[]): Promise<{
  api: ActivityApiClient;
  received: Received[];
  close: () => Promise<void>;
}> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '' });

      // Favro answers 404 with an HTML page on every path that is not
      // `/cards/:cardId/activities` — the failure class this ticket fixed.
      if (!/\/cards\/[^/]+\/activities(\?|$)/.test(req.url ?? '')) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><head><title>Favro</title></head></html>');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      // `pages`/`requestId` are echoed because Favro sends them even though the
      // paging params are ignored.
      res.end(JSON.stringify({ entities, pages: 1, page: 0, limit: 100, requestId: 'req-1' }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const client = new FavroHttpClient({ baseURL: `http://127.0.0.1:${port}/api/v1` });
      resolve({
        api: new ActivityApiClient(client as any),
        received,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

describe('ActivityApiClient.getCardActivity — wire shape', () => {
  it('hits the plural /activities path, exactly once', async () => {
    const { api, received, close } = await startServer([row()]);
    try {
      await api.getCardActivity(CARD);
      expect(received).toHaveLength(1);
      expect(received[0].method).toBe('GET');
      expect(received[0].url).toContain(`/cards/${CARD}/activities`);
      // Singular `/activity` is a 404 — guard against a regression to it.
      expect(received[0].url).not.toMatch(/\/activity(\?|$)/);
    } finally {
      await close();
    }
  });

  it('sends no query params when no window is asked for', async () => {
    const { api, received, close } = await startServer([row()]);
    try {
      await api.getCardActivity(CARD);
      expect(received[0].url).toBe(`/api/v1/cards/${CARD}/activities`);
    } finally {
      await close();
    }
  });

  it('passes since and until as ISO 8601 on the query string', async () => {
    const { api, received, close } = await startServer([row()]);
    try {
      await api.getCardActivity(CARD, {
        since: new Date('2026-06-23T14:37:19.090Z'),
        until: new Date('2026-06-29T15:01:38.057Z'),
      });
      const url = decodeURIComponent(received[0].url);
      expect(url).toContain('since=2026-06-23T14:37:19.090Z');
      expect(url).toContain('until=2026-06-29T15:01:38.057Z');
    } finally {
      await close();
    }
  });

  it('never sends limit, and never cuts the result either (#99)', async () => {
    // The server returns 5 rows regardless, mirroring `?limit=2` → 22 rows live.
    // This read used to take a `limit` and slice the result client-side, which
    // dropped rows with nothing anywhere saying so. The cap moved to `capRows`
    // in the command, where it sets `truncated`; the client returns the feed.
    const { api, received, close } = await startServer([row(), row(), row(), row(), row()]);
    try {
      const entries = await api.getCardActivity(CARD);
      expect(received[0].url).not.toContain('limit');
      expect(entries).toHaveLength(5);
    } finally {
      await close();
    }
  });

  it('does not page — one call even though the response carries requestId and pages', async () => {
    const { api, received, close } = await startServer([row(), row()]);
    try {
      const entries = await api.getCardActivity(CARD);
      // A paging loop over ignored `page`/`requestId` params would refetch the
      // same page and return each row twice.
      expect(received).toHaveLength(1);
      expect(entries).toHaveLength(2);
    } finally {
      await close();
    }
  });

  it('preserves Favro field names and invents nothing', async () => {
    const { api, close } = await startServer([row()]);
    try {
      const [entry] = await api.getCardActivity(CARD);
      expect(entry.time).toBe('2026-07-01T17:13:41.745Z');
      expect(entry.byUserId).toBe('pk3qK36WHjnJt5jwr');
      expect(entry.type).toBe('card description changed');
      expect(entry.columnName).toBe('To Do');
      expect(entry.widgetName).toBe('Kanban');
      expect(entry.cardCommonId).toBe('ce979d6e6913916fbebe84b3');
      // The old normalizer fabricated these from absent wire fields, producing
      // '' for every row — an empty description and "(unknown time)" on output.
      expect(entry).not.toHaveProperty('activityId');
      expect(entry).not.toHaveProperty('description');
      expect(entry).not.toHaveProperty('author');
      expect(entry).not.toHaveProperty('createdAt');
    } finally {
      await close();
    }
  });

  it('returns an empty list when the viewer-scoped feed is empty', async () => {
    const { api, close } = await startServer([]);
    try {
      expect(await api.getCardActivity(CARD)).toEqual([]);
    } finally {
      await close();
    }
  });

  it('propagates an error rather than swallowing it into a synthetic entry', async () => {
    const { api, close } = await startServer([row()]);
    try {
      // The stand-in 404s any non-`/activities` path; a bogus shape reaches it as
      // a miss. The old code caught everything and synthesised rows from card
      // metadata, so a dead endpoint looked like real history.
      await expect(api.getCardActivity('')).rejects.toThrow();
    } finally {
      await close();
    }
  });
});
