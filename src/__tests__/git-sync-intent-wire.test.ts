/**
 * `git sync` and `dependencies delete-all` through the dispatch table, against a
 * `node:http` Favro stand-in — #109, step 4 of the sequence in #92.
 *
 * WHAT THIS SUITE IS FOR, AND WHAT IT MEASURED ON THE WAY.
 *
 * #109's body claimed `git sync` was BROKEN, not merely unguarded: that it wrote
 * `{status: 'Done'}` raw, and that a plain `PUT {status}` 200s and changes
 * nothing, so its success count may have been counting writes that never landed.
 * **That claim is false, and this file is where it is settled rather than
 * argued.** `git.ts` called `CardsAPI.updateCard`, which TRANSLATES `status` into
 * a `columnId` before anything reaches the wire (`cards-api.ts`, the
 * `payload.status !== undefined` branch), so the write always landed. The arms
 * below pin the wire bytes on the routed path — `{columnId}` and never `{status}`
 * — and pin that the card MOVED, by reading the stand's own store rather than the
 * response echo. If the translation were ever removed, the first arm goes red.
 *
 * A stand that echoes what it was sent cannot tell a landed write from a silent
 * one: it would confirm our own assumption against itself. So the stand here
 * honours `columnId` and ignores `status` outright — exactly as Favro is measured
 * to — and the assertions read the stored card back through `GET /cards/{id}`,
 * the surface `columnId` is actually measured on
 * (`docs/research/tracker-contract-favro-carriers.md` §1.3).
 *
 * The two REFUSAL arms are the other half of the ticket: a batch over
 * `MULTI_WRITE_CAP` must refuse as a whole rather than write the first twenty,
 * and `dependencies delete-all` must refuse rather than wipe. Both assert on
 * `writes()` — the only thing that can tell "refused before writing" from "wrote
 * and then reported a refusal".
 */
import * as http from 'http';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import { tempConfigDir } from '../test-support/config-dir';

// The only Favro seam: the CLI builds its own client from real credentials, and
// this points that client at the stand. Everything below the factory — the
// dispatch table, `TxCards`, the compensation log, `CardsAPI`, axios — is real.
let injected: FavroHttpClient | undefined;
jest.mock('../lib/client-factory', () => ({
  __esModule: true,
  createFavroClient: jest.fn(async () => {
    if (!injected) throw new Error('API key not configured. Run `favro auth login`.');
    return injected;
  }),
  default: jest.fn(async () => injected),
}));

// The git seam. `git sync` reads the repo, not the network, and this file is
// about what it then sends — so the branch analysis is stubbed and nothing else.
jest.mock('../lib/git-integration', () => {
  const real = jest.requireActual('../lib/git-integration');
  return {
    ...real,
    isGitRepo: jest.fn(() => true),
    readProjectConfig: jest.fn(() => ({ boardId: 'board-inside', branches: {} })),
    analyzeBranches: jest.fn(() => []),
  };
});

const CONFIG_DIR = tempConfigDir('favro-cli-109-wire-');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildProgram } = require('../cli') as typeof import('../cli');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const gitIntegration = require('../lib/git-integration') as typeof import('../lib/git-integration');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MULTI_WRITE_CAP } = require('../lib/dispatch') as typeof import('../lib/dispatch');

const ORG = 'org-1';
const LOCKED_COLLECTION = 'coll-locked';
const IN_BOARD = 'board-inside';
const OUT_BOARD = 'board-outside';
const TODO = 'col-todo';
const DOING = 'col-doing';
const DONE = 'col-done';

const LOCK = { scopeCollectionId: LOCKED_COLLECTION, scopeCollectionName: 'Locked' };

const BOARDS = [
  {
    widgetCommonId: IN_BOARD,
    name: 'Board Inside',
    collectionIds: [LOCKED_COLLECTION],
    columns: [
      { columnId: TODO, name: 'To Do', position: 0 },
      { columnId: DOING, name: 'In Progress', position: 1 },
      { columnId: DONE, name: 'Done', position: 2 },
    ],
  },
  {
    widgetCommonId: OUT_BOARD,
    name: 'Board Outside',
    collectionIds: ['coll-elsewhere'],
    columns: [
      { columnId: TODO, name: 'To Do', position: 0 },
      { columnId: DOING, name: 'In Progress', position: 1 },
      { columnId: DONE, name: 'Done', position: 2 },
    ],
  },
];

interface Received { method: string; url: string; path: string; body?: any }
interface StoredCard {
  cardId: string;
  cardCommonId: string;
  name: string;
  widgetCommonId?: string;
  columnId?: string;
  dependencies?: Array<{ cardId: string; isBefore: boolean }>;
}
interface Stand { received: Received[]; cards: Map<string, StoredCard> }

const running: http.Server[] = [];

/**
 * A fresh organizationId per stand, so every arm starts on a COLD name cache.
 *
 * `name-cache.ts` partitions by organizationId and memoises the parsed file by
 * PATH, and only this process's own `writeFile` clears that memo — so deleting
 * the file between arms does not work, measured. The create arms below count
 * `/widgets` requests, and a warm partition would make that count a fact about
 * test order rather than about the code.
 */
let orgSeq = 0;

/**
 * A 24-hex `cardId`. The leading letters are not decoration: an all-DIGIT
 * reference is a sequentialId to `CardReferences`, so `000…001` goes out as
 * `?cardSequentialId=1` and never finds the card. Measured, on this stand.
 */
const cardId = (n: number) => `cafe${'0'.repeat(18)}${String(n).padStart(2, '0')}`;

const card = (overrides: Partial<StoredCard> & { cardId: string }): StoredCard => ({
  cardCommonId: `ccid-${overrides.cardId}`,
  name: `Card ${overrides.cardId}`,
  widgetCommonId: IN_BOARD,
  columnId: TODO,
  dependencies: [],
  ...overrides,
});

/**
 * @param deaf a PUT to a card in this set answers 200 and writes NOTHING — the
 *   silent-no-op shape the whole build exists to catch. It is how the negative
 *   polarity of "the write lands" is expressed on a socket.
 */
function startServer(seed: { cards: StoredCard[]; deaf?: Set<string> } ): Promise<Stand> {
  const received: Received[] = [];
  const cards = new Map<string, StoredCard>(seed.cards.map((c) => [c.cardId, c]));

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = req.url ?? '';
      const pathOnly = url.split('?')[0].replace('/api/v1', '');
      const r: Received = {
        method: req.method ?? '',
        url,
        path: pathOnly,
        body: raw ? JSON.parse(raw) : undefined,
      };
      received.push(r);
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      const deps = pathOnly.match(/^\/cards\/([^/]+)\/dependencies(?:\/([^/]+))?$/);
      if (deps) {
        const stored = cards.get(deps[1]);
        if (!stored) return send(403, { message: 'Access denied' });
        if (r.method === 'DELETE') {
          if (!deps[2]) {
            // The unbounded wipe the routing removes. Reachable on the wire, so
            // an arm can prove nothing reaches it any more.
            stored.dependencies = [];
            return send(204, {});
          }
          const before = stored.dependencies ?? [];
          stored.dependencies = before.filter((d) => d.cardId !== deps[2]);
          return before.length === stored.dependencies.length
            ? send(404, { message: 'Dependency not found' })
            : send(204, {});
        }
        if (r.method === 'GET') {
          return send(200, {
            cardId: stored.cardId,
            cardCommonId: stored.cardCommonId,
            dependencies: stored.dependencies ?? [],
          });
        }
        if (r.method === 'POST') {
          stored.dependencies = [
            ...(stored.dependencies ?? []),
            ...(r.body?.dependencies ?? []).map((d: any) => ({
              cardId: d.cardId,
              isBefore: Boolean(d.isBefore),
            })),
          ];
          return send(200, { dependencies: stored.dependencies });
        }
      }

      const single = pathOnly.match(/^\/cards\/([^/]+)$/);
      if (single) {
        const stored = cards.get(single[1]);
        if (r.method === 'GET') {
          return stored ? send(200, { ...stored }) : send(403, { message: 'Access denied' });
        }
        if (r.method === 'PUT') {
          if (!stored) return send(403, { message: 'Access denied' });
          // 200 and nothing written — Favro's own worst shape, on demand.
          if (seed.deaf?.has(single[1])) return send(200, { ...stored });
          const b = r.body ?? {};
          // `columnId` is honoured; `status` is IGNORED, exactly as Favro
          // ignores it on a write. A stand that honoured both could not tell a
          // translated write from an untranslated one.
          const next: StoredCard = { ...stored };
          if (b.columnId !== undefined) next.columnId = b.columnId;
          if (b.name !== undefined) next.name = b.name;
          cards.set(single[1], next);
          return send(200, { ...next });
        }
      }

      if (pathOnly === '/cards' && r.method === 'POST') {
        const made = card({
          cardId: `made-${cards.size}`,
          name: String(r.body?.name ?? ''),
          widgetCommonId: r.body?.widgetCommonId,
          columnId: r.body?.columnId ?? TODO,
        });
        cards.set(made.cardId, made);
        return send(200, { ...made });
      }

      if (pathOnly === '/cards') {
        const query = new URLSearchParams(url.split('?')[1] ?? '');
        const commonId = query.get('cardCommonId');
        const widget = query.get('widgetCommonId');
        // An UNFILTERED list answers nothing here, deliberately. Favro would
        // paginate the whole organisation; a stand that hands back every seeded
        // card instead turns a lookup by an id this route does not index into a
        // 22-way ambiguity refusal, which is a fact about the stand and not about
        // the code under test.
        if (!commonId && !widget) return send(200, { entities: [] });
        const entities = [...cards.values()].filter((c) => {
          if (widget && c.widgetCommonId !== widget) return false;
          // Either keyspace: a 24-hex reference is a `cardCommonId` OR a
          // `cardId` to Favro, and `CardReferences` sends the same query for both.
          if (commonId) return c.cardCommonId === commonId || c.cardId === commonId;
          return true;
        });
        return send(200, { entities: entities.map((c) => ({ ...c })) });
      }

      if (pathOnly.startsWith('/columns')) {
        const board = new URLSearchParams(url.split('?')[1] ?? '').get('widgetCommonId');
        const found = BOARDS.find((w) => w.widgetCommonId === board);
        return send(200, {
          entities: (found?.columns ?? []).map((c) => ({ ...c, widgetCommonId: board })),
        });
      }
      if (pathOnly.startsWith('/widgets')) {
        const byId = pathOnly.slice('/widgets'.length).replace(/^\//, '');
        if (byId) {
          const found = BOARDS.find((w) => w.widgetCommonId === byId);
          return found ? send(200, found) : send(404, { message: 'Widget not found' });
        }
        return send(200, { entities: BOARDS });
      }
      send(200, { entities: [] });
    });
  });
  running.push(server);

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      injected = new FavroHttpClient({
        baseURL: `http://127.0.0.1:${port}/api/v1`,
        auth: { organizationId: `${ORG}-${++orgSeq}` },
      });
      resolve({ received, cards });
    });
  });
}

let exitSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;
let errSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;

const lock = (config: unknown) =>
  fsp.writeFile(path.join(CONFIG_DIR, 'config.json'), JSON.stringify(config));

const run = (...argv: string[]) => buildProgram().parseAsync(['node', 'favro', ...argv]);

/**
 * The human path. `git sync` moved onto `run()` in #119, so its `✓ Updated N/N`
 * line lives on the `human` formatter and JSON is what an unflagged run gets.
 */
const runHuman = (...argv: string[]) => run('--human', ...argv);

/**
 * `git sync` no longer THROWS on a refusal — `run()` sets `process.exitCode` and
 * returns (ADR-0002). The unmigrated commands further down this file still exit
 * hard, which is why `attempt` stays.
 */
const exitCodeAfter = async (...argv: string[]): Promise<number | undefined> => {
  process.exitCode = undefined;
  await run(...argv);
  const code = process.exitCode;
  process.exitCode = undefined;
  return code;
};

const attempt = async (...argv: string[]): Promise<string | undefined> => {
  try {
    await run(...argv);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
};

const said = () =>
  [...logSpy.mock.calls, ...errSpy.mock.calls, ...warnSpy.mock.calls].flat().map(String).join('\n');
const writes = (received: Received[]) => received.filter((r) => r.method !== 'GET');
const branches = (rows: Array<{ branch: string; cardId?: string; status: string }>) =>
  (gitIntegration.analyzeBranches as jest.Mock).mockReturnValue(rows);

beforeEach(async () => {
  jest.clearAllMocks();
  injected = undefined;
  await lock({});
  (gitIntegration.isGitRepo as jest.Mock).mockReturnValue(true);
  (gitIntegration.readProjectConfig as jest.Mock).mockReturnValue({ boardId: IN_BOARD, branches: {} });
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as any);
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise((done) => s.close(() => done(null)))));
  jest.restoreAllMocks();
});

// ─── the write LANDS, and the column is where it landed ──────────────────────

describe('git sync writes a column move that actually lands', () => {
  it('moves the card, and the card is measured to have moved', async () => {
    const A = cardId(1);
    const B = cardId(2);
    const { received, cards } = await startServer({
      cards: [card({ cardId: A }), card({ cardId: B })],
    });
    branches([
      { branch: 'feature/a', cardId: A, status: 'merged' },
      { branch: 'feature/b', cardId: B, status: 'open' },
    ]);

    await runHuman('git', 'sync', '--yes');

    // THE MEASUREMENT. Not "the PUT answered 200" — the stand's own stored card,
    // which is what a following `GET /cards/{id}` returns and the only surface
    // `columnId` is measured on.
    expect(cards.get(A)!.columnId).toBe(DONE);
    expect(cards.get(B)!.columnId).toBe(DOING);
    expect(said()).toContain('✓ Updated 2/2 cards.');
  });

  it('sends {columnId} and never {status} — the translation is on the wire', async () => {
    // The ticket's central claim was that this path sent `{status}` raw. It did
    // not: `CardsAPI.updateCard` translated it, and the routed `moveColumn` sends
    // the column outright. Either way the bytes are the same, and this is where
    // that is a measurement rather than a reading of the source.
    const A = cardId(1);
    const { received } = await startServer({ cards: [card({ cardId: A })] });
    branches([{ branch: 'feature/a', cardId: A, status: 'merged' }]);

    await run('git', 'sync', '--yes');

    const puts = writes(received).filter((r) => r.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].body).toEqual({ columnId: DONE });
    expect(puts[0].body).not.toHaveProperty('status');
  });

  it('a PUT that 200s and moves nothing is reported as NOT landed, and unwinds', async () => {
    // The polarity that makes the arm above falsifiable. Favro answers 200 to
    // writes it does not perform; `moveColumn` re-reads the card and refuses to
    // call that a move. Before #109 this path counted the 200 as a success.
    const A = cardId(1);
    const { cards } = await startServer({ cards: [card({ cardId: A })], deaf: new Set([A]) });
    branches([{ branch: 'feature/a', cardId: A, status: 'merged' }]);

    expect(await exitCodeAfter('git', 'sync', '--yes')).toBe(1);
    expect(cards.get(A)!.columnId).toBe(TODO);
    expect(said()).toContain('did not land there');
    expect(said()).not.toContain('✓ Updated');
  });

  it('a card that cannot be read aborts the pass and NAMES the branch that pointed at it', async () => {
    // The abort is right — the pass is one transaction, and a card that cannot be
    // read cannot be scope-checked — but `board()` runs outside the table's try,
    // so the wire's own bare `404 Not Found` was all the user got: no card, no
    // branch, no next step. A refusal that does not name the fix is half a
    // refusal, and only the socket arm can tell "named it" from "aborted".
    const A = cardId(1);
    const { received } = await startServer({ cards: [card({ cardId: A })] });
    branches([
      { branch: 'feature/a', cardId: A, status: 'merged' },
      { branch: 'feature/gone', cardId: cardId(99), status: 'merged' },
    ]);

    expect(await exitCodeAfter('git', 'sync', '--yes')).toBe(1);
    expect(writes(received)).toEqual([]);
    expect(said()).toContain('feature/gone');
    expect(said()).toContain('.favro.json');
    expect(said()).toContain('NOTHING was written');
  });

  it('a SCOPE refusal keeps its own message — the abort wrapper is narrow', async () => {
    // The polarity that stops the wrapper swallowing precise refusals: every
    // `RefusalError` already names its own fix, so rewrapping one would replace it
    // with a guess about card reads.
    const A = cardId(1);
    await startServer({ cards: [card({ cardId: A, widgetCommonId: OUT_BOARD })] });
    await lock(LOCK);
    branches([{ branch: 'feature/a', cardId: A, status: 'merged' }]);

    await attempt('git', 'sync', '--yes');

    expect(said()).toContain('Scope violation');
    expect(said()).not.toContain('.favro.json');
  });

  it('a failure on the second card moves the FIRST one back', async () => {
    // One transaction, not a loop with a success counter. The old path printed
    // "✓ Updated 1/2 cards." and left the first move standing.
    const A = cardId(1);
    const B = cardId(2);
    const { cards } = await startServer({
      cards: [card({ cardId: A }), card({ cardId: B })],
      deaf: new Set([B]),
    });
    branches([
      { branch: 'feature/a', cardId: A, status: 'merged' },
      { branch: 'feature/b', cardId: B, status: 'merged' },
    ]);

    expect(await exitCodeAfter('git', 'sync', '--yes')).toBe(1);
    expect(cards.get(A)!.columnId).toBe(TODO);
    expect(said()).toContain('Rolled back');
  });
});

// ─── the cap ─────────────────────────────────────────────────────────────────

describe('git sync refuses above the multi-write cap', () => {
  it(`${MULTI_WRITE_CAP + 1} tracked branches refuse, naming the cap, with nothing written`, async () => {
    const many = Array.from({ length: MULTI_WRITE_CAP + 1 }, (_, i) => cardId(i + 1));
    const { received, cards } = await startServer({ cards: many.map((id) => card({ cardId: id })) });
    branches(many.map((id, i) => ({ branch: `feature/${i}`, cardId: id, status: 'merged' })));

    expect(await exitCodeAfter('git', 'sync', '--yes')).toBe(1);
    expect(said()).toContain(`capped at ${MULTI_WRITE_CAP}`);
    expect(said()).toContain('not a page size');
    expect(writes(received)).toEqual([]);
    for (const id of many) expect(cards.get(id)!.columnId).toBe(TODO);
  });

  it(`exactly ${MULTI_WRITE_CAP} is fine — the cap refuses ABOVE it, not at it`, async () => {
    const many = Array.from({ length: MULTI_WRITE_CAP }, (_, i) => cardId(i + 1));
    const { cards } = await startServer({ cards: many.map((id) => card({ cardId: id })) });
    branches(many.map((id, i) => ({ branch: `feature/${i}`, cardId: id, status: 'merged' })));

    await run('git', 'sync', '--yes');

    for (const id of many) expect(cards.get(id)!.columnId).toBe(DONE);
  });

  it('the refusal costs nothing — the cap is checked before the first request', async () => {
    const many = Array.from({ length: MULTI_WRITE_CAP + 1 }, (_, i) => cardId(i + 1));
    const { received } = await startServer({ cards: many.map((id) => card({ cardId: id })) });
    branches(many.map((id, i) => ({ branch: `feature/${i}`, cardId: id, status: 'merged' })));

    await attempt('git', 'sync', '--yes');

    expect(received).toEqual([]);
  });
});

// ─── the scope lock, taken inside the intent ─────────────────────────────────

describe('git sync takes the lock inside the intent', () => {
  it('one card outside the lock refuses the WHOLE pass, before any write', async () => {
    const A = cardId(1);
    const B = cardId(2);
    const { received, cards } = await startServer({
      cards: [card({ cardId: A }), card({ cardId: B, widgetCommonId: OUT_BOARD })],
    });
    await lock(LOCK);
    branches([
      { branch: 'feature/a', cardId: A, status: 'merged' },
      { branch: 'feature/b', cardId: B, status: 'merged' },
    ]);

    expect(await exitCodeAfter('git', 'sync', '--yes')).toBe(1);
    expect(said()).toContain('Scope violation');
    expect(writes(received)).toEqual([]);
    expect(cards.get(A)!.columnId).toBe(TODO);
  });

  it('and the same pass INSIDE the lock still writes — the refusal is falsifiable', async () => {
    const A = cardId(1);
    const { cards } = await startServer({ cards: [card({ cardId: A })] });
    await lock(LOCK);
    branches([{ branch: 'feature/a', cardId: A, status: 'merged' }]);

    await run('git', 'sync', '--yes');

    expect(said()).not.toContain('Scope violation');
    expect(cards.get(A)!.columnId).toBe(DONE);
  });
});

// ─── dependencies delete-all: bounded, and no longer one blind DELETE ────────

describe('dependencies delete-all refuses above the cap rather than wiping', () => {
  const withEdges = (count: number) => {
    const subject = cardId(90);
    const far = Array.from({ length: count }, (_, i) => cardId(i + 1));
    return {
      subject,
      far,
      cards: [
        card({
          cardId: subject,
          dependencies: far.map((id) => ({ cardId: id, isBefore: true })),
        }),
        ...far.map((id) => card({ cardId: id })),
      ],
    };
  };

  it(`${MULTI_WRITE_CAP + 1} edges refuse, naming the cap, and nothing is deleted`, async () => {
    const { subject, cards: seed } = withEdges(MULTI_WRITE_CAP + 1);
    const { received, cards } = await startServer({ cards: seed });

    const thrown = await attempt('dependencies', 'delete-all', subject, '--yes');

    expect(thrown).toBe('process.exit(1)');
    expect(said()).toContain(`capped at ${MULTI_WRITE_CAP}`);
    expect(said()).toContain('dependency edges');
    // The load-bearing one: the unbounded `DELETE /cards/{id}/dependencies` is
    // still reachable on this stand, so an empty write list is evidence the
    // command no longer goes near it.
    expect(writes(received)).toEqual([]);
    expect(cards.get(subject)!.dependencies).toHaveLength(MULTI_WRITE_CAP + 1);
  });

  it('under the cap it removes them ONE AT A TIME, never through the bulk DELETE', async () => {
    const { subject, cards: seed } = withEdges(3);
    const { received, cards } = await startServer({ cards: seed });

    await run('dependencies', 'delete-all', subject, '--yes');

    expect(cards.get(subject)!.dependencies).toEqual([]);
    const deletes = writes(received).filter((r) => r.method === 'DELETE');
    expect(deletes).toHaveLength(3);
    // Per-edge, so each one has an inverse. The bulk path takes no far card.
    expect(deletes.every((d) => /\/dependencies\/[^/]+$/.test(d.path))).toBe(true);
    expect(said()).toContain('Removed 3 dependencies');
  });

  it('a card with no edges writes nothing at all', async () => {
    const subject = cardId(90);
    const { received } = await startServer({ cards: [card({ cardId: subject })] });

    await run('dependencies', 'delete-all', subject, '--yes');

    expect(writes(received)).toEqual([]);
    expect(said()).toContain('no dependencies');
  });
});

// ─── cards create settles its board before the lock sees it ──────────────────

describe('cards create --board <name> under a lock (#82, closed in #109)', () => {
  const lists = (received: Received[]) => received.filter((r) => r.path === '/widgets');

  it('the lock is handed the settled id, never the name', async () => {
    // The `create` intent used to pass its board argument through unresolved, and
    // `assertScope` GETs `/widgets/<id>` — handed "Board Inside" it 404s into
    // "Board … not found", a refusal naming the wrong problem. Asserted on the
    // socket, because only the URL can tell a settled id from a name.
    const { received, cards } = await startServer({ cards: [] });
    await lock(LOCK);

    await run('cards', 'create', 'A new card', '--board', 'Board Inside', '--yes');

    expect(received.map((r) => r.path)).toContain(`/widgets/${IN_BOARD}`);
    expect(received.filter((r) => r.path.includes('Board Inside'))).toEqual([]);
    expect([...cards.values()].map((c) => c.name)).toContain('A new card');
  });

  it('settling twice costs ONE board list — `createCard` shares the cache', async () => {
    // THE MEASUREMENT behind "no extra request on the real create": `board()`
    // settles the name, then `createCard`'s own `boardIdOf` settles it again, and
    // `resolveNameToId` reads a memoised disk cache between them. Each stand gets a
    // fresh `organizationId`, so this counts a COLD start — see the note on `orgSeq`.
    // Deleting the cache file would NOT work: the memo outlives it.
    const { received } = await startServer({ cards: [] });
    await lock(LOCK);

    await run('cards', 'create', 'A new card', '--board', 'Board Inside', '--yes');

    expect(lists(received)).toHaveLength(1);
  });

  it('a board ID still settles, and still costs one list — no shape shortcut', async () => {
    // `looksLikeName` is NOT used to skip the settle, and this arm is why: it is
    // deliberately weak — a one-word board name ("Backlog") is shape-identical to
    // an id — so gating on it would pass such a name through unresolved and
    // reopen #82 for exactly the names most likely to be typed.
    const { received, cards } = await startServer({ cards: [] });
    await lock(LOCK);

    await run('cards', 'create', 'A new card', '--board', IN_BOARD, '--yes');

    expect(lists(received)).toHaveLength(1);
    expect([...cards.values()].map((c) => c.name)).toContain('A new card');
  });

  it('an UNLOCKED --dry-run now costs one board list where it cost none', async () => {
    // The price of moving the settling inside the intent, MEASURED rather than
    // claimed: `board()` runs before the `dryRun` return, so a preview that made
    // no request now makes one. It is the #102/#104/#135 pricing rule and this
    // arm is where the exception is recorded — the alternative was leaving #82
    // open on `cards create`.
    const { received } = await startServer({ cards: [] });

    await run('cards', 'create', 'A new card', '--board', 'Board Inside', '--dry-run');

    expect(lists(received)).toHaveLength(1);
    expect(writes(received)).toEqual([]);
    expect(said()).toContain('[dry-run]');
  });
});
