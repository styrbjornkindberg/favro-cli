/**
 * Wire-level tests for the card dependency endpoints — issue #12.
 *
 * These deliberately do NOT mock the http client. A real `node:http` server
 * stands in for Favro, so the real axios stack builds the URL, serialises the
 * body, and interprets the status code. The old client-mock tests could not
 * catch a wrong path, a wrong request shape, or a wrong response envelope key,
 * which is exactly how `getCardLinks` shipped reading `.entities` (Favro sends
 * `.dependencies`) and `createCards` shipped posting to a route that does not
 * exist.
 *
 * Expectations below are pinned to responses observed against the live Favro
 * API on 2026-07-31 (throwaway board, cards created and deleted by the probe).
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

const CARD = '117a0f59f4145c41747b32dc';
const OTHER = 'a41ca08db390ccbfd91a55f5';

describe('unlinkCard (no client mock)', () => {
  test('DELETEs the documented path and resolves on Favro\'s 204', async () => {
    const { api, received, close } = await startServer(() => ({ status: 204 }));
    try {
      await expect(api.unlinkCard(CARD, OTHER)).resolves.toBeUndefined();
      expect(received).toHaveLength(1);
      expect(received[0].method).toBe('DELETE');
      expect(received[0].url).toBe(`/api/v1/cards/${CARD}/dependencies/${OTHER}`);
      expect(received[0].body).toBe('');
    } finally {
      await close();
    }
  });

  test('rejects on Favro\'s 404 "Dependency not found" for an edge already gone', async () => {
    const { api, close } = await startServer(() => ({
      status: 404,
      body: { message: 'Dependency not found' },
    }));
    try {
      // The rollback contract in #11 treats this 404 as "already undone", but it
      // has to be able to *see* it — so the error must carry the status through.
      await expect(api.unlinkCard(CARD, OTHER)).rejects.toMatchObject({
        response: { status: 404 },
      });
    } finally {
      await close();
    }
  });
});

describe('getCardLinks (no client mock)', () => {
  test('reads the `dependencies` envelope key, not `entities`', async () => {
    const { api, received, close } = await startServer(() => ({
      status: 200,
      body: {
        cardId: CARD,
        cardCommonId: 'bc948674af3413d345488800',
        organizationId: 'b0b311ac98a0250191573541',
        dependencies: [
          {
            cardId: OTHER,
            isBefore: true,
            cardCommonId: '39b9f66d474a5575ab380f2b',
            reverseCardId: CARD,
          },
        ],
      },
    }));
    try {
      const links = await api.getCardLinks(CARD);
      expect(received[0].url).toBe(`/api/v1/cards/${CARD}/dependencies`);
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ cardId: OTHER, isBefore: true });
    } finally {
      await close();
    }
  });

  test('returns [] when a card has no edges', async () => {
    const { api, close } = await startServer(() => ({
      status: 200,
      body: { cardId: CARD, cardCommonId: 'x', organizationId: 'y', dependencies: [] },
    }));
    try {
      await expect(api.getCardLinks(CARD)).resolves.toEqual([]);
    } finally {
      await close();
    }
  });
});

describe('linkCard (no client mock)', () => {
  test('POSTs { dependencies: [{ cardId, isBefore }] } — the shape Favro accepts', async () => {
    const { api, received, close } = await startServer((req) => {
      // Mirror Favro's real validator: it 400s on an unrecognised body.
      const parsed = JSON.parse(req.body);
      if (!Array.isArray(parsed.dependencies)) {
        return { status: 400, body: { message: `Match error: Expected array, got ${req.body}` } };
      }
      if (parsed.dependencies.some((d: any) => d.isBefore === undefined)) {
        return { status: 400, body: { message: "Match error: Missing key 'isBefore' in field [0]" } };
      }
      return {
        status: 201,
        body: {
          cardId: CARD,
          dependencies: parsed.dependencies.map((d: any) => ({ ...d, reverseCardId: CARD })),
        },
      };
    });
    try {
      const edges = await api.linkCard(CARD, { toCardId: OTHER, isBefore: true });
      expect(received[0].method).toBe('POST');
      expect(received[0].url).toBe(`/api/v1/cards/${CARD}/dependencies`);
      expect(JSON.parse(received[0].body)).toEqual({
        dependencies: [{ cardId: OTHER, isBefore: true }],
      });
      expect(edges).toEqual([{ cardId: OTHER, isBefore: true, reverseCardId: CARD }]);
    } finally {
      await close();
    }
  });
});

// `CardsAPI.createCards` was deleted with #67 — since #55 `cards create
// --csv/--bulk` routes through `dispatch('create', {cards})`, which is where the
// one-POST-per-card guarantee (and the "never `POST /cards/bulk`" assertion that
// used to live here) is now pinned: see the multi-create test in
// `dispatch-tx-wire.test.ts`.
