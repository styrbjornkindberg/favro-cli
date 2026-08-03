/**
 * The wire shape of `dueDate`, measured (#132).
 *
 * #89 unified two `isOverdue` copies that were each broken on the shape the
 * other handled, and left the question open: does Favro send a date-only
 * `YYYY-MM-DD` or a full ISO timestamp? It could not be answered from this
 * repo. Every fixture here is date-only, which records what the fixtures'
 * authors assumed, not what the wire sends — so a fixture-based test would
 * have proved nothing. It needed a live read.
 *
 * ── THE MEASUREMENT ─────────────────────────────────────────────────────────
 *
 * Read-only scan of one live Favro organization on 2026-08-03, reading
 * `/widgets` and `/cards` to the LAST page: 422 boards, 10601 unarchived cards.
 * (Both list endpoints clamp to 100 entities per page. Stopping at the first
 * page reports 100 boards and 1262 cards and silently understates every count
 * below by roughly 4x — the numbers here are paginated to completion.)
 *
 *   dueDate full ISO (`2023-07-27T07:00:00.000Z`) :  853
 *   dueDate date-only (`2023-07-27`)              :    0
 *   dueDate any other shape                       :    0
 *   dueDate present but null                      :    0
 *   dueDate key absent from the card entirely     : 9748
 *
 * **Favro sends a full ISO timestamp. Date-only never occurred.** Both
 * `GET /cards/<id>` and `GET /cards?widgetCommonId=…` returned the byte-identical
 * string for the same card — the two paths agree, which matters because only the
 * second feeds `buildCardFilter` in `batch smart`.
 *
 * An undated card omits the key. It is not `null` and not `''`, so
 * `hasOwnProperty('dueDate')` is false — which is why `isOverdue`'s falsy guard
 * is the right test and a `=== null` check would not be.
 *
 * The time-of-day part is not a constant. Eleven distinct values occur across
 * the 853 dated cards — `T00:00:00.000Z`, `T07:00:00.000Z`, `T08:00:00.000Z`,
 * `T08:58:00.000Z`, `T09:00:00.000Z`, `T10:00:00.000Z`, `T12:00:00.000Z`,
 * `T21:59:59.999Z`, `T22:00:00.000Z`, `T22:59:59.999Z`, `T23:00:00.000Z` —
 * Favro encodes a *local* day boundary for whoever set the date, so the
 * timestamp is load-bearing and truncating it to ten characters would move the
 * day. Card `startDate` was measured at the same time and is the same shape:
 * full ISO, zero date-only out of 524.
 *
 * Sample size is one organization on one day. It is a large and perfectly
 * consistent sample, and it is still not a published contract — which is why
 * `isOverdue` keeps its date-only branch rather than deleting it.
 *
 * ── WHY IT IS PINNED HERE ───────────────────────────────────────────────────
 *
 * `dueDate` reaches the caller through `normalizeCard`'s `...rest` passthrough,
 * so nothing in the type system stops a future normalisation from reformatting
 * it. This file serves the observed string over a real socket and asserts it
 * arrives unchanged through both read paths, then asserts `isOverdue` still
 * classifies it. Sockets rather than queued mocks for the usual reason
 * (`pagination-wire.test.ts`), plus one specific to this file: the fixture below
 * is the only date-shaped string in this repo that was copied off the wire
 * rather than invented, and it must stay that way.
 */
import http from 'http';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import { CardsAPI } from '../lib/cards-api';
import { isOverdue } from '../lib/card-predicates';

/**
 * Copied verbatim from the wire, not composed here. Card
 * `059c685005023675a64838c0`, returned identically by `GET /cards/<id>` and by
 * `GET /cards?widgetCommonId=…` on 2026-08-03.
 */
const OBSERVED_DUE_DATE = '2023-07-27T07:00:00.000Z';
const OBSERVED_CARD_ID = '059c685005023675a64838c0';

/** A second observed string, from a different board and a different local zone offset. */
const OBSERVED_DUE_DATE_2 = '2025-11-27T09:00:00.000Z';

const BOARD = 'board-1';
const ORG = 'org-1';

/** Every server this file started, so a failed assertion cannot leak one. */
const running: http.Server[] = [];

interface WireCard {
  cardId: string;
  name: string;
  widgetCommonId: string;
  /** Omitted entirely for an undated card — that is what Favro does. */
  dueDate?: string;
}

/**
 * A Favro stand-in that serves the given cards on both read paths: the list
 * (`/cards?widgetCommonId=`) and the single read (`/cards/<id>`). The same
 * objects back both, so a divergence between the paths can only come from our
 * own normalisation — which is the thing under test.
 */
function startServer(cards: WireCard[]): Promise<{ api: CardsAPI; paths: string[] }> {
  const paths: string[] = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://x');
    paths.push(url.pathname);

    const page = (entities: unknown[]) => ({ entities, requestId: 'req-1', pages: 1, page: 0 });
    const single = url.pathname.match(/\/cards\/([^/]+)$/);
    const body = single
      ? cards.find((c) => c.cardId === single[1])
      // `listCards` settles the board reference before it reads, so the board
      // listing has to be its own route — answering it with the card array made
      // every card look like a board of the same name.
      : url.pathname.endsWith('/widgets')
        ? page([{ widgetCommonId: BOARD, name: BOARD }])
        : page(cards);

    res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body ?? { message: 'Card not found' }));
  });
  running.push(server);

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const client = new FavroHttpClient({
        baseURL: `http://127.0.0.1:${port}/api/v1`,
        auth: { organizationId: ORG },
      });
      resolve({ api: new CardsAPI(client), paths });
    });
  });
}

/** A dated card. No `columnId` and no `tags`, so name hydration makes no calls. */
function dated(cardId: string, dueDate: string): WireCard {
  return { cardId, name: `Card ${cardId}`, widgetCommonId: BOARD, dueDate };
}

/** An undated card: Favro omits the key, so this fixture must too. */
function undated(cardId: string): WireCard {
  return { cardId, name: `Card ${cardId}`, widgetCommonId: BOARD };
}

const originalConfigDir = process.env.FAVRO_CONFIG_DIR;
let tmpDir: string;

beforeEach(async () => {
  // The name cache is a real file — give each test its own, so a run never
  // reads or clobbers the developer's own ~/.favro cache.
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-duedate-test-'));
  process.env.FAVRO_CONFIG_DIR = tmpDir;
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise((done) => s.close(() => done(null)))));
  if (originalConfigDir === undefined) delete process.env.FAVRO_CONFIG_DIR;
  else process.env.FAVRO_CONFIG_DIR = originalConfigDir;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('the measured shape of dueDate (#132)', () => {
  it('is a full ISO timestamp, and is NOT date-only', () => {
    // Guards the fixture itself. Every *other* date in this repo is date-only
    // because someone assumed it; this one was copied off the wire. If a future
    // edit "tidies" it to `2023-07-27`, the file stops recording a measurement
    // and starts recording an assumption again — which is the exact failure
    // #132 was opened to end.
    expect(OBSERVED_DUE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(OBSERVED_DUE_DATE).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(OBSERVED_DUE_DATE_2).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // The time part carries a real local day boundary and is not always
    // midnight — so it cannot be dropped as noise.
    expect(OBSERVED_DUE_DATE.slice(10)).not.toBe(OBSERVED_DUE_DATE_2.slice(10));
  });

  it('survives the LIST path byte-identically — the path that feeds batch smart', async () => {
    const { api } = await startServer([dated(OBSERVED_CARD_ID, OBSERVED_DUE_DATE)]);

    const [card] = await api.listCards({ boardId: BOARD });

    expect(card.dueDate).toBe(OBSERVED_DUE_DATE);
  });

  it('survives the SINGLE-CARD path byte-identically', async () => {
    const { api } = await startServer([dated(OBSERVED_CARD_ID, OBSERVED_DUE_DATE)]);

    const card = await api.getCard(OBSERVED_CARD_ID);

    expect(card.dueDate).toBe(OBSERVED_DUE_DATE);
  });

  it('the two paths agree, as they did on the wire', async () => {
    const { api, paths } = await startServer([dated(OBSERVED_CARD_ID, OBSERVED_DUE_DATE)]);

    const [listed] = await api.listCards({ boardId: BOARD });
    const fetched = await api.getCard(OBSERVED_CARD_ID);

    expect(listed.dueDate).toBe(fetched.dueDate);
    // Both paths were really exercised — a shared cache answering twice would
    // make the agreement vacuous.
    expect(paths).toContain('/api/v1/cards');
    expect(paths).toContain(`/api/v1/cards/${OBSERVED_CARD_ID}`);
  });

  it('an undated card arrives with the key absent, not null', async () => {
    const { api } = await startServer([undated('c-undated')]);

    const [card] = await api.listCards({ boardId: BOARD });

    expect(Object.prototype.hasOwnProperty.call(card, 'dueDate')).toBe(false);
    expect(card.dueDate).toBeUndefined();
  });
});

describe('isOverdue on the measured shape, off a real socket (#132)', () => {
  it('classifies a past full-ISO due date as overdue', async () => {
    // The verbatim observed string. It is in the past and stays there, so this
    // asserts on the measurement itself rather than on a date composed here.
    const { api } = await startServer([dated(OBSERVED_CARD_ID, OBSERVED_DUE_DATE)]);

    const [card] = await api.listCards({ boardId: BOARD });

    expect(isOverdue(card)).toBe(true);
  });

  it('does not call a future full-ISO due date overdue', async () => {
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const { api } = await startServer([dated('c-future', future)]);

    const [card] = await api.listCards({ boardId: BOARD });

    expect(isOverdue(card)).toBe(false);
  });

  it('an undated card is never overdue', async () => {
    const { api } = await startServer([undated('c-undated')]);

    const [card] = await api.listCards({ boardId: BOARD });

    expect(isOverdue(card)).toBe(false);
  });

  it('the overdue set is non-empty on a mixed board — the filter is not a no-op', async () => {
    // The pre-#89 `batch smart` copy split on `-` and read `27T07:00:00.000Z`
    // as NaN, so this set was EMPTY for every card Favro actually sends. An
    // empty result here would mean that silent no-op is back.
    const { api } = await startServer([
      dated('c-past-1', OBSERVED_DUE_DATE),
      dated('c-past-2', OBSERVED_DUE_DATE_2),
      dated('c-future', new Date(Date.now() + 30 * 86_400_000).toISOString()),
      undated('c-undated'),
    ]);

    const cards = await api.listCards({ boardId: BOARD });

    expect(cards.filter(isOverdue).map((c) => c.cardId)).toEqual(['c-past-1', 'c-past-2']);
  });
});
