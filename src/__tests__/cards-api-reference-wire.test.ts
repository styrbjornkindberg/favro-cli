/**
 * Wire-level tests for card identifier resolution — issue #40.
 *
 * No client mock: a real `node:http` server stands in for Favro, so the
 * assertions are about the request Favro actually receives (path and query
 * string) and the value the caller observes. A mock could not catch the bug
 * this replaces — the old comments resolver probed `GET /comments` and read
 * "it returned entities" as proof of the right shape, but Favro answers an
 * empty list for a `cardId` rather than an error, so a wrong shape read as a
 * card with no comments.
 *
 * Wire facts pinned here: path segments take `cardId`; `cardCommonId` and
 * `cardSequentialId` are filters on `GET /cards` and never path segments; and
 * a forked card is an entity with no `widgetCommonId`.
 */
import * as http from 'http';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import CardsAPI from '../lib/cards-api';
import { CommentsApiClient } from '../api/comments';
import { CardResolutionError } from '../lib/card-reference';

interface Received {
  method: string;
  url: string;
  body: string;
}

const CARD_ID = '713db3018af39956227d4279';
const COMMON_ID = '9f1c2d3e4a5b6c7d8e9f0a1b';
const OTHER_CARD_ID = '5a5a5a5a5a5a5a5a5a5a5a5a';

function startServer(
  handler: (req: Received) => { status: number; body?: unknown },
): Promise<{ client: FavroHttpClient; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const entry = { method: req.method ?? '', url: req.url ?? '', body };
      received.push(entry);
      const { status, body: out } = handler(entry);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out ?? {}));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        client: new FavroHttpClient({ baseURL: `http://127.0.0.1:${port}/api/v1` }),
        received,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const card = (over: Record<string, unknown> = {}) => ({
  cardId: CARD_ID,
  cardCommonId: COMMON_ID,
  widgetCommonId: 'board-1',
  columnId: 'col-1',
  name: 'probe',
  sequentialId: 1804,
  ...over,
});

/** Favro's 403-for-not-found, as it actually words it. */
const accessDenied = { status: 403, body: { message: 'Access denied' } };

describe('card identifier resolution on the wire', () => {
  it('a cardId goes straight to the path segment and costs no lookup', async () => {
    const { client, received, close } = await startServer(() => ({ status: 200, body: card() }));
    const result = await new CardsAPI(client).getCard(CARD_ID);
    await close();

    // One card call and no resolution lookup. (The `/widgets` call is the
    // column-name cache filling once per TTL window, not per card.)
    const cardCalls = received.filter((r) => r.url.startsWith('/api/v1/cards'));
    expect(cardCalls.map((r) => r.url)).toEqual([`/api/v1/cards/${CARD_ID}?descriptionFormat=markdown`]);
    expect(result.cardId).toBe(CARD_ID);
  });

  it('a sequentialId label is queried via cardSequentialId, never as a path segment', async () => {
    const { client, received, close } = await startServer((req) => {
      if (req.url?.startsWith('/api/v1/cards?')) return { status: 200, body: { entities: [card()] } };
      return { status: 200, body: card() };
    });
    const result = await new CardsAPI(client).getCard('CLA-1804');
    await close();

    expect(received[0].url).toContain('cardSequentialId=1804');
    expect(received[0].url).toContain('unique=true');
    expect(received.some((r) => r.url.includes('/cards/CLA-1804'))).toBe(false);
    expect(result.cardId).toBe(CARD_ID);
  });

  it('a cardCommonId escalates to the cards filter only after a classified not-found', async () => {
    const { client, received, close } = await startServer((req) => {
      if (req.url?.startsWith(`/api/v1/cards/${COMMON_ID}`)) return accessDenied;
      if (req.url?.startsWith('/api/v1/cards?')) return { status: 200, body: { entities: [card()] } };
      return { status: 200, body: card() };
    });
    const result = await new CardsAPI(client).getCard(COMMON_ID);
    await close();

    // Tried the path first (shape-first), then escalated exactly once.
    expect(received[0].url).toContain(`/cards/${COMMON_ID}`);
    expect(received[1].url).toContain(`cardCommonId=${COMMON_ID}`);
    expect(result.cardId).toBe(CARD_ID);
  });

  it('a fork — an entity with no widgetCommonId — never takes part in resolution', async () => {
    const { client, close } = await startServer((req) => {
      if (req.url?.startsWith('/api/v1/cards?')) {
        return {
          status: 200,
          body: { entities: [card(), card({ cardId: 'fork-1', widgetCommonId: undefined, columnId: undefined })] },
        };
      }
      return { status: 200, body: card() };
    });
    const result = await new CardsAPI(client).getCard('CLA-1804');
    await close();

    expect(result.cardId).toBe(CARD_ID);
  });

  it('a card on two boards is refused with both instances listed, never entities[0]', async () => {
    const { client, close } = await startServer((req) => {
      if (req.url?.startsWith('/api/v1/cards?')) {
        return {
          status: 200,
          body: {
            entities: [card(), card({ cardId: OTHER_CARD_ID, widgetCommonId: 'board-2' })],
          },
        };
      }
      return { status: 200, body: card() };
    });

    const attempt = new CardsAPI(client).getCard('CLA-1804');
    await expect(attempt).rejects.toBeInstanceOf(CardResolutionError);
    await expect(attempt).rejects.toThrow('--board');
    const error = (await attempt.catch((e: unknown) => e)) as CardResolutionError;
    await close();

    expect(error.candidates.map((c) => c.cardId).sort()).toEqual([OTHER_CARD_ID, CARD_ID].sort());
    expect(error.disambiguateWith).toBe('--board <board>');
    expect(error.message).toContain(OTHER_CARD_ID);
  });

  it('an unresolvable reference says missing-or-not-visible, never a bare "not found"', async () => {
    const { client, close } = await startServer((req) => {
      if (req.url?.startsWith('/api/v1/cards?')) return { status: 200, body: { entities: [] } };
      return accessDenied;
    });

    const attempt = new CardsAPI(client).getCard('CLA-9999');
    await expect(attempt).rejects.toThrow('missing or not visible to your key');
    await close();
  });

  it('comments take a cardCommonId, resolved from whichever shape the caller held', async () => {
    const { client, received, close } = await startServer((req) => {
      if (req.url?.startsWith(`/api/v1/cards/${CARD_ID}`)) return { status: 200, body: card() };
      return { status: 200, body: { entities: [] } };
    });
    await new CommentsApiClient(client).listComments(CARD_ID);
    await close();

    const commentsCall = received.find((r) => r.url.startsWith('/api/v1/comments'));
    // The cardId the caller held is translated — the endpoint never sees it.
    expect(commentsCall?.url).toContain(`cardCommonId=${COMMON_ID}`);
    expect(commentsCall?.url).not.toContain(CARD_ID);
  });

  it('a reference that is already a cardCommonId passes through to comments unchanged', async () => {
    const { client, received, close } = await startServer((req) => {
      if (req.url?.startsWith(`/api/v1/cards/${COMMON_ID}`)) return accessDenied;
      return { status: 200, body: { entities: [] } };
    });
    await new CommentsApiClient(client).listComments(COMMON_ID);
    await close();

    const commentsCall = received.find((r) => r.url.startsWith('/api/v1/comments'));
    expect(commentsCall?.url).toContain(`cardCommonId=${COMMON_ID}`);
  });

  // A card read that answers 200 without a `cardCommonId` is off-contract, and
  // the resolver used to substitute the reference for it (#89). That is the one
  // wrong answer this endpoint cannot report: it takes `cardCommonId` as a query
  // or body value, never a path segment, so a `cardId` in that slot is a
  // well-formed request for a card that does not exist. Refuse instead.

  it('refuses when a card read comes back with no cardCommonId, rather than substituting the reference', async () => {
    const { client, received, close } = await startServer((req) => {
      if (req.url?.startsWith(`/api/v1/cards/${CARD_ID}`)) {
        return { status: 200, body: card({ cardCommonId: undefined }) };
      }
      return { status: 200, body: { entities: [] } };
    });

    const attempt = new CommentsApiClient(client).listComments(CARD_ID);
    await expect(attempt).rejects.toThrow(/no cardCommonId/);
    await close();

    expect(received.some((r) => r.url.startsWith('/api/v1/comments'))).toBe(false);
  });

  it('refuses the same way down the sequentialId path', async () => {
    const { client, close } = await startServer((req) => {
      if (req.url?.startsWith('/api/v1/cards?')) {
        return { status: 200, body: { entities: [card({ cardCommonId: undefined })] } };
      }
      return { status: 200, body: { entities: [] } };
    });

    const attempt = new CommentsApiClient(client).listComments('CLA-1804');
    await expect(attempt).rejects.toThrow(/no cardCommonId/);
    await close();
  });
});
