/**
 * `cards get --include` — an empty facet and an UNREADABLE one must not read the
 * same (#153's four `cards-api.ts` debts).
 *
 * Each of the four facets used to be wrapped in `catch { /* best effort *​/ }`, so
 * a failed `/widgets`, `/collections`, `/dependencies` or `/comments` read handed
 * back a card quietly missing the facet the caller had ASKED for — indistinguishable
 * from "this card has no board / no links / no comments". That is this repo's
 * defining defect class (#116, #148, #149) on its most-used read path, and the
 * consumer is an agent with no memory of the failure.
 *
 * WHY THESE ARMS ARE SHAPED THIS WAY. A blanket failure injection cannot tell
 * propagation from swallowing, and it cannot tell a per-facet marker from a
 * per-card one: every assertion passes whichever the code does. So each arm fails
 * EXACTLY ONE facet by URL and asserts the other three came back HEALTHY in the
 * same payload. The four facets have four distinct paths, which is what makes that
 * possible on the wire rather than through a mock's call counter.
 *
 * And the whole point is asserted in BOTH POLARITIES, because "the marker is
 * absent" is unfalsifiable in exactly the case the test exists for: the
 * all-facets-answer arm pins `links: []` / `comments: []` with NO `unreachable`
 * key anywhere in the bytes, and each failure arm pins the marker naming that one
 * facet.
 *
 * TWO REFUSAL SHAPES, and the second is the one that matters. The default is an
 * injected 404, chosen to keep the retry ladder and `byBoard`'s name escalation out
 * of the way; but `favro-error.ts`'s header records that Favro answers **403** for
 * not-found, so the injected shape is not the one a real token without access
 * produces. The `PERMISSION` arm drives that shape at all four facets and pins what
 * was measured, including the one place the reason comes out wrong.
 *
 * The output asserted is what an AGENT RECEIVES — stdout off `buildProgram()`,
 * parsed back as JSON — not the API's return value. `cards get` is ADR-0002
 * migrated (`run(...)` on the runner, JSON by default), so the card IS the
 * machine payload and the marker rides on it: a single read has no envelope
 * (`read-shape.ts` rule 1), the same place `context`'s snapshot puts its own.
 */
import * as http from 'http';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import CardsAPI from '../lib/cards-api';
import { invalidateCache } from '../lib/name-cache';
import { tempConfigDir } from '../test-support/config-dir';

// The only seam: the CLI builds its own client from real credentials, and this
// points that client at the stand-in. Everything below it is the real thing.
let injected: FavroHttpClient | undefined;
jest.mock('../lib/client-factory', () => ({
  __esModule: true,
  createFavroClient: jest.fn(async () => {
    if (!injected) throw new Error('API key not configured. Run `favro auth login`.');
    return injected;
  }),
  default: jest.fn(async () => injected),
}));

// Set before the CLI tree is required, so nothing reads the developer's own
// `~/.favro` — neither the scope lock nor the persistent name cache.
tempConfigDir('favro-cards-get-holes-');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildProgram } = require('../cli') as typeof import('../cli');

const ORG = 'org-1';
const CARD = '117a0f59f4145c41747b32dc';
const COMMON = 'c0mm0n59f4145c41747b32dc';
const BOARD = 'board-a';
const COLLECTION = 'coll-a';

/** The four `--include` facets that cost a separate call. */
type Facet = 'board' | 'collection' | 'links' | 'comments';
const FACETS: readonly Facet[] = ['board', 'collection', 'links', 'comments'];

/**
 * The card `GET /cards/:id` answers with.
 *
 * No `columnId` and no `tags`, so `hydrateNames` makes ZERO extra calls and the
 * only requests on the wire are the card plus the facets under test. No
 * `dependencies` either: `normalizeCard` fills `links` from an inlined edge set,
 * which would skip the `/dependencies` read entirely.
 */
const CARD_BODY = {
  cardId: CARD,
  cardCommonId: COMMON,
  name: 'a card with facets',
  widgetCommonId: BOARD,
  collectionId: COLLECTION,
  createdAt: '2026-01-01T00:00:00Z',
};

/** Every server this file started, so a failed assertion cannot leak one. */
const running: http.Server[] = [];

/** How the named facet refuses. */
interface Refusal { status: number; message: string }

/**
 * The DEFAULT refusal: a **404 carrying a message outside `NOT_FOUND_MESSAGES`**,
 * chosen for two measured reasons and not for realism. `shouldRetry` retries every
 * 5xx four times with exponential backoff (~15s a facet), and `'Access denied'` IS
 * in that set, so `escalatableOnRead` sends `byBoard` off to a name lookup and the
 * reported reason becomes the lookup's rather than the facet's. The failure is
 * INJECTED, so this is not a claim about what Favro sends (ADR-0003) — and because
 * it is not, `PERMISSION` below covers the shape `favro-error.ts`'s own header says
 * Favro really answers.
 */
const NOT_FOUND: Refusal = { status: 404, message: 'facet unavailable' };

/**
 * The refusal Favro is MEASURED to send for a resource a key cannot see:
 * `favro-error.ts`'s header records that it answers 403 across several resources,
 * and `'Access denied'` is in its probed `NOT_FOUND_MESSAGES` set. So this — not
 * the 404 above — is the shape a token without board, collection or comment access
 * actually produces, and the arm that drives it is what keeps the marker honest on
 * the path real users take.
 */
const PERMISSION: Refusal = { status: 403, message: 'Access denied' };

/**
 * A Favro stand-in that answers every facet, except the ONE named — which
 * refuses with `refusal`.
 */
function startServer(fail?: Facet, refusal: Refusal = NOT_FOUND): Promise<{ urls: string[] }> {
  const urls: string[] = [];
  const server = http.createServer((req, res) => {
    req.on('data', () => { /* no bodies on this path */ });
    req.on('end', () => {
      const url = req.url ?? '';
      urls.push(url);
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const refuse = (): void => send(refusal.status, { message: refusal.message });
      const pathOnly = url.split('?')[0].replace(/^\/api\/v1/, '');

      if (pathOnly === `/cards/${CARD}/dependencies`) {
        return fail === 'links' ? refuse() : send(200, { dependencies: [] });
      }
      if (pathOnly === `/cards/${CARD}`) return send(200, CARD_BODY);
      if (pathOnly === `/widgets/${BOARD}`) {
        return fail === 'board'
          ? refuse()
          : send(200, { widgetCommonId: BOARD, name: 'Board A', collectionIds: [COLLECTION] });
      }
      if (pathOnly === `/collections/${COLLECTION}`) {
        return fail === 'collection'
          ? refuse()
          : send(200, { collectionId: COLLECTION, name: 'Collection A' });
      }
      if (pathOnly === '/comments') {
        return fail === 'comments' ? refuse() : send(200, { entities: [] });
      }
      // Anything else is a call this test did not expect; the assertions on
      // `urls` are what make that visible.
      send(200, { entities: [] });
    });
  });
  running.push(server);

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      injected = new FavroHttpClient({
        baseURL: `http://127.0.0.1:${port}/api/v1`,
        auth: { organizationId: ORG, token: 'test-token', email: 'test@example.com' },
      });
      resolve({ urls });
    });
  });
}

let logSpy: jest.SpyInstance;
let errSpy: jest.SpyInstance;

beforeEach(() => {
  invalidateCache();
  process.exitCode = undefined;
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise((done) => s.close(() => done(null)))));
  injected = undefined;
  logSpy.mockRestore();
  errSpy.mockRestore();
  process.exitCode = undefined;
});

interface Payload {
  cardId?: string;
  board?: { name?: string };
  collection?: { name?: string };
  links?: unknown[];
  comments?: unknown[];
  unreachable?: Array<{ id: string; reason: string }>;
}

/**
 * Run `favro cards get <card> --include board,collection,links,comments` and hand
 * back the raw stdout line plus its parse — the bytes an agent reads, and nothing
 * reconstructed from the API's return value.
 */
async function getCard(
  fail?: Facet,
  refusal?: Refusal,
): Promise<{ raw: string; payload: Payload; urls: string[] }> {
  const { urls } = await startServer(fail, refusal);
  // Cleared per invocation, not per test: one arm below runs this TWICE, and
  // reading the first matching line would have compared a payload to itself.
  logSpy.mockClear();
  errSpy.mockClear();
  await buildProgram().parseAsync([
    'node', 'favro', 'cards', 'get', CARD, '--include', 'board,collection,links,comments',
  ]);
  const raw = logSpy.mock.calls.map((c) => String(c[0])).find((line) => line.includes('"cardId"'));
  if (raw === undefined) {
    throw new Error(`no card on stdout — stderr said: ${errSpy.mock.calls.map((c) => String(c[0])).join(' | ')}`);
  }
  return { raw, payload: JSON.parse(raw) as Payload, urls };
}

/** The exact reason `unreachableReason` derives from the injected refusal. */
const REASON = 'Favro failed with status 404: "facet unavailable".';

describe('cards get --include: an empty facet and an unreadable one are distinguishable', () => {
  it('all four facets answer: empty is EMPTY, and no marker is emitted', async () => {
    const { raw, payload } = await getCard();

    expect(payload.cardId).toBe(CARD);
    // The empty polarity, stated as values rather than as an absence: a card
    // with no dependencies and no comments answers `[]` for both.
    expect(payload.links).toEqual([]);
    expect(payload.comments).toEqual([]);
    expect(payload.board?.name).toBe('Board A');
    expect(payload.collection?.name).toBe('Collection A');
    // Absent, not `unreachable: []` — an empty array reads as a hole to any
    // truthiness check (`read-shape.ts` rule 3).
    expect('unreachable' in payload).toBe(false);
    expect(raw).not.toContain('unreachable');
    expect(process.exitCode).toBeUndefined();
  });

  it.each(FACETS)('%s unreadable: the marker names it and NOTHING else', async (broken) => {
    const { payload } = await getCard(broken);

    // ONE hole, naming the facet that failed. `toEqual` on the whole array, so a
    // marker that also named a healthy facet fails here.
    expect(payload.unreachable).toEqual([{ id: broken, reason: REASON }]);

    // …and the other three came back HEALTHY in the same payload. This is the
    // arm a blanket failure injection cannot have: it is what proves the marker
    // is per-facet rather than per-card, and that one dead facet does not take
    // the live ones down with it.
    const healthy: Record<Facet, () => void> = {
      board: () => expect(payload.board?.name).toBe('Board A'),
      collection: () => expect(payload.collection?.name).toBe('Collection A'),
      links: () => expect(payload.links).toEqual([]),
      comments: () => expect(payload.comments).toEqual([]),
    };
    for (const facet of FACETS) {
      if (facet !== broken) healthy[facet]();
    }

    // A partial read is still a successful read: the card that WAS fetched is
    // returned, and the marker is how the caller learns what is missing.
    expect(payload.cardId).toBe(CARD);
    expect(process.exitCode).toBeUndefined();
  });

  it('an unreadable facet is ABSENT from the payload, never a manufactured empty', async () => {
    // The half a hole marker cannot carry on its own. `links: []` would be a
    // false statement about the card, and `query-parser.ts`'s `linksOf` reads it
    // as "no dependencies" — `links` absent falls through to the raw
    // `dependencies` the card GET carried, which is the truthful answer.
    const dead = await getCard('links');
    expect('links' in dead.payload).toBe(false);
    // The KEY, not the word: `"links"` also appears as the marker's own `id`,
    // which is the whole point of the arm above.
    expect(dead.raw).not.toContain('"links":');

    const alive = await getCard();
    expect(alive.payload.links).toEqual([]);
    expect(alive.raw).toContain('"links":[]');
  });

  it.each(FACETS)('%s: the unreached facet is off the OBJECT too, not only off the bytes', async (broken) => {
    // `JSON.stringify` drops a key whose value is `undefined`, so the stdout arms
    // above cannot tell "absent" from "present and undefined". `Object.keys` can,
    // and `query-parser.ts`'s `knownFields` reads exactly that — a facet the read
    // could not reach must not become a filterable field name either.
    //
    // Run at ALL FOUR sites: the guard is written once per facet, so an arm that
    // only exercised one would leave three assignments free to regress.
    await startServer(broken);
    const dead = await new CardsAPI(injected!).getCard(CARD, { include: [broken] });

    expect(Object.keys(dead)).not.toContain(broken);
    expect(dead.unreachable).toEqual([{ id: broken, reason: REASON }]);

    // The polarity: a facet that ANSWERED does become a key, `[]` included.
    await startServer();
    const read = await new CardsAPI(injected!).getCard(CARD, { include: [broken] });
    expect(Object.keys(read)).toContain(broken);
    expect(read[broken]).not.toBeUndefined();
    expect('unreachable' in read).toBe(false);
  });

  it.each(FACETS)('%s: a 403 — what Favro really sends — is a hole naming it too', async (broken) => {
    // The 404 above is injected, not observed. THIS is the observed shape:
    // `favro-error.ts`'s header records Favro answering 403 for not-found across
    // several resources, and `'Access denied'` is in its probed
    // `NOT_FOUND_MESSAGES`, so a token without access to the board, the collection
    // or the comments produces this and not a 404. Measured in review of #153,
    // because the marker being right on the injected failure says nothing about
    // the one production actually hits.
    const { payload } = await getCard(broken, PERMISSION);

    // What holds at all four: ONE hole, and its `id` is the facet. That is the
    // whole claim of #153 — an agent can tell WHICH facet it is missing.
    expect(payload.unreachable).toHaveLength(1);
    expect(payload.unreachable?.[0].id).toBe(broken);
    expect(Object.keys(payload)).not.toContain(broken);
    expect(payload.cardId).toBe(CARD);
    expect(process.exitCode).toBeUndefined();

    // The REASON, and the one asymmetry it has. Three facets are plain
    // `client.get`s, so the reason is the classified 403 verbatim.
    //
    // `board` is not: `BoardsAPI.getBoard` routes through `byBoard`, which reads
    // `escalatableOnRead` on the 403 and retries the id as a NAME — so the reason
    // that lands is `resolveBoardId`'s refusal about a board name, for a value
    // that was never a name but the `widgetCommonId` the card itself carried.
    // It also costs an extra `/widgets?limit=100` listing.
    //
    // Pinned rather than fixed: `byBoard` is shared by `boards get <boardId>`,
    // which has always answered the same way, so the misattribution predates this
    // change and lives in a file this branch does not own. Pinned so a fix there
    // comes back HERE — the id is what an agent branches on and it is correct
    // either way, but the wording tells a caller "no such board" when the truth is
    // "your key cannot see it".
    const reason = payload.unreachable?.[0].reason ?? '';
    if (broken === 'board') {
      expect(reason).toContain(`No board named "${BOARD}"`);
      expect(reason).not.toContain('Access denied');
    } else {
      expect(reason).toBe('Favro said "Access denied" — the resource is missing or not visible to your key.');
    }
  });

  it('the four facets are four separate reads, so one failure is one hole', async () => {
    // The seam the per-facet arms rest on. If two facets ever shared a call, an
    // arm above would be asserting something the wire cannot express.
    const { urls } = await getCard();
    const paths = urls.map((u) => u.split('?')[0].replace('/api/v1', ''));
    expect(paths).toContain(`/cards/${CARD}`);
    expect(paths).toContain(`/cards/${CARD}/dependencies`);
    expect(paths).toContain(`/widgets/${BOARD}`);
    expect(paths).toContain(`/collections/${COLLECTION}`);
    expect(paths).toContain('/comments');
    // `hydrateNames` has nothing to hydrate on this card, so five calls is the
    // whole read — a sixth would mean an unexpected fetch is in play and the
    // failure injection above is not hitting what it thinks it is.
    expect(paths).toHaveLength(5);
  });
});
