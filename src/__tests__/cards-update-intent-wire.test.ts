/**
 * `cards update` through the `update` intent, against a `node:http` Favro
 * stand-in — #108, step 3 of the sequence in #92.
 *
 * WHY THIS SUITE EXISTS, AND WHY IT IS BEHAVIOURAL RATHER THAN A RATCHET.
 *
 * The defect it closes is an ORDER: `cards update <card> --dry-run` returned from
 * its preview before `checkScope`, so under a lock a dry run previewed a write the
 * real run refuses. `dry-run-scope-order-wire.test.ts` already carries a textual
 * ratchet for exactly that class — and it could not see this one, in two
 * independent ways, both measured against `766250e`:
 *
 *   1. It scans `src/commands` only. `cards update` lives in `src/cli.ts`, so the
 *      subject was never read. (Measured: adding `cli.ts` to that scan still
 *      reports zero gaps, for reason 2.)
 *   2. Its window is one `.command(` registration, and it pairs the FIRST guard in
 *      that window with the FIRST preview. `cards update` is one registration
 *      holding THREE write paths, and the `--from-csv` path's guard (correctly
 *      ordered, #103) sits above the single-card path's preview — so the broken
 *      path was shadowed by its own correct sibling. Measured: with the predicate
 *      relaxed to "every preview needs some guard above it", still zero gaps,
 *      because the CSV guard is above every later preview in the block.
 *
 * A line-order scan cannot tell three sibling branches apart; only control flow
 * can. So the check for THIS defect is the wire: what the socket received, and
 * what the caller saw. Making the scanner cleverer would have been the repo's own
 * dominant failure — a predicate that enumerates spellings instead of walking the
 * real surface, shipping green and blind.
 *
 * EVERY ORDERING ARM HAS ITS OPPOSITE POLARITY. "No preview was printed" is an
 * absence, and an absence asserted alone is unfalsifiable precisely in the case
 * the test exists for — a run that printed nothing because it crashed early
 * satisfies it. So each refusal arm is paired with an in-lock arm asserting that
 * the very same line IS printed, and with `writes()` on the socket, which is the
 * only thing that can tell "refused before writing" from "wrote and then failed".
 */
import * as http from 'http';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import { tempConfigDir } from '../test-support/config-dir';

// The only seam: the CLI builds its own client from real credentials, and this
// points that client at the stand. Everything below the factory — the dispatch
// table, `TxCards`, the compensation log, `CardsAPI`, axios — is real.
let injected: FavroHttpClient | undefined;
jest.mock('../lib/client-factory', () => ({
  __esModule: true,
  createFavroClient: jest.fn(async () => {
    if (!injected) throw new Error('API key not configured. Run `favro auth login`.');
    return injected;
  }),
  default: jest.fn(async () => injected),
}));

// Module scope, above the `require` below: a module that reads config during its
// own import would otherwise be pinned to the developer's real `~/.favro`, which
// on this repo carries a live scope lock (#65).
const CONFIG_DIR = tempConfigDir('favro-cli-update-intent-');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildProgram } = require('../cli') as typeof import('../cli');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { dispatch, MULTI_WRITE_CAP } = require('../lib/dispatch') as typeof import('../lib/dispatch');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { readConfig } = require('../lib/config') as typeof import('../lib/config');

const ORG = 'org-1';
const LOCKED_COLLECTION = 'coll-locked';
const IN_BOARD = 'board-inside';
const OUT_BOARD = 'board-outside';
const TODO = 'col-todo';
const DONE = 'col-done';
const ALICE = 'aaaaaaaaaaaaaaaaa';

/** A card on the locked board, and one outside it. Same shape, different board. */
const IN_CARD = '00000000000000000000cc01';
const OUT_CARD = '00000000000000000000cc02';
/** No `widgetCommonId` — what an assignment fork looks like. */
const FORK_CARD = '00000000000000000000cc03';

const LOCK = { scopeCollectionId: LOCKED_COLLECTION, scopeCollectionName: 'Locked' };

const BOARDS = [
  {
    widgetCommonId: IN_BOARD,
    name: 'Board Inside',
    collectionIds: [LOCKED_COLLECTION],
    columns: [
      { columnId: TODO, name: 'To Do', position: 0 },
      { columnId: DONE, name: 'Done', position: 1 },
    ],
  },
  {
    widgetCommonId: OUT_BOARD,
    name: 'Board Outside',
    collectionIds: ['coll-elsewhere'],
    columns: [
      { columnId: TODO, name: 'To Do', position: 0 },
      { columnId: DONE, name: 'Done', position: 1 },
    ],
  },
];

const TAGS = [
  { tagId: 'tag-bug', name: 'bug' },
  { tagId: 'tag-urgent', name: 'urgent' },
];

interface Received { method: string; url: string; path: string; body?: any }
interface StoredCard {
  cardId: string;
  cardCommonId: string;
  name: string;
  detailedDescription?: string;
  widgetCommonId?: string;
  columnId?: string;
  tags: string[];
  assignments: Array<{ userId: string }>;
}
interface Stand { received: Received[]; cards: Map<string, StoredCard> }

const running: http.Server[] = [];

const card = (overrides: Partial<StoredCard> & { cardId: string }): StoredCard => ({
  cardCommonId: `ccid-${overrides.cardId}`,
  name: 'Original name',
  detailedDescription: 'Original body',
  widgetCommonId: IN_BOARD,
  columnId: TODO,
  tags: [],
  assignments: [],
  ...overrides,
});

/**
 * @param failPut a PUT whose body this returns true for answers `403 Invalid
 *   column` and writes nothing. 403 rather than 5xx on purpose: `http-client`
 *   retries 5xx with exponential backoff, which would make a rollback arm take
 *   fifteen seconds to prove a point about ordering.
 */
function startServer(
  seed: { cards?: StoredCard[]; failPut?: (body: any) => boolean } = {},
): Promise<Stand> {
  const received: Received[] = [];
  const cards = new Map<string, StoredCard>(
    (seed.cards ?? [
      card({ cardId: IN_CARD }),
      card({ cardId: OUT_CARD, widgetCommonId: OUT_BOARD }),
      card({ cardId: FORK_CARD, widgetCommonId: undefined, columnId: undefined }),
    ]).map((c) => [c.cardId, c]),
  );

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

      const single = pathOnly.match(/^\/cards\/([^/]+)$/);
      if (single) {
        const id = single[1];
        const stored = cards.get(id);
        if (r.method === 'GET') {
          return stored ? send(200, { ...stored }) : send(403, { message: 'Access denied' });
        }
        if (r.method === 'PUT') {
          if (!stored) return send(403, { message: 'Access denied' });
          if (seed.failPut?.(r.body ?? {})) return send(403, { message: 'Invalid column' });
          const b = r.body ?? {};
          const next: StoredCard = {
            ...stored,
            tags: [...stored.tags],
            assignments: [...stored.assignments],
          };
          if (b.name !== undefined) next.name = b.name;
          // The honoured description field. `PUT {description}` is a measured
          // silent no-op, so this stand honours ONLY `detailedDescription` — which
          // is what makes the translation assertion below a real observation
          // rather than a restatement of the payload we sent.
          if (b.detailedDescription !== undefined) next.detailedDescription = b.detailedDescription;
          if (b.columnId !== undefined) next.columnId = b.columnId;
          for (const t of b.addTagIds ?? []) if (!next.tags.includes(t)) next.tags.push(t);
          for (const t of b.removeTagIds ?? []) next.tags = next.tags.filter((x) => x !== t);
          for (const u of b.addAssignmentIds ?? []) {
            if (!next.assignments.some((a) => a.userId === u)) next.assignments.push({ userId: u });
          }
          for (const u of b.removeAssignmentIds ?? []) {
            next.assignments = next.assignments.filter((a) => a.userId !== u);
          }
          cards.set(id, next);
          return send(200, { ...next });
        }
      }

      if (pathOnly === '/cards') {
        const query = new URLSearchParams(url.split('?')[1] ?? '');
        const commonId = query.get('cardCommonId');
        const widget = query.get('widgetCommonId');
        const entities = [...cards.values()].filter((c) => {
          if (widget && c.widgetCommonId !== widget) return false;
          if (commonId) return c.cardCommonId === commonId;
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
      if (pathOnly.startsWith('/tags')) return send(200, { entities: TAGS });
      if (pathOnly.startsWith('/users')) {
        return send(200, {
          entities: [{ userId: ALICE, name: 'Alice Ahlberg', email: 'alice@example.com' }],
        });
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
        auth: { organizationId: ORG },
      });
      resolve({ received, cards });
    });
  });
}

let exitSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;
let errSpy: jest.SpyInstance;
// `assertScope`'s `--force` warning goes to `console.warn`, not `console.error`.
// Left unspied it escapes into the reporter AND the `--force` arm below cannot see
// it — measured: that arm failed on a missing substring the code does print.
let warnSpy: jest.SpyInstance;

/** Write the scope config this test wants. `readConfig()` resolves per call (#65). */
const lock = (config: unknown) =>
  fsp.writeFile(path.join(CONFIG_DIR, 'config.json'), JSON.stringify(config));

/**
 * The command as a user reaches it. `--human`, because `said()` below merges
 * both streams and the `✓ Card updated: …` lines these arms read live on the
 * `human` formatter since #119 put `cards update` on `run()`.
 */
const run = (...argv: string[]) =>
  buildProgram().parseAsync(['node', 'favro', '--human', 'cards', ...argv]);

/**
 * `run`, handing back the exit code. It used to swallow a thrown
 * `process.exit(N)`; the runner sets `process.exitCode` and returns instead, so
 * there is nothing to throw and nothing to swallow.
 */
const attempt = async (...argv: string[]): Promise<number | undefined> => {
  process.exitCode = undefined;
  await run(...argv);
  const code = process.exitCode;
  process.exitCode = undefined;
  return code;
};

const said = () =>
  [...logSpy.mock.calls, ...errSpy.mock.calls, ...warnSpy.mock.calls].flat().map(String).join('\n');
const writes = (received: Received[]) => received.filter((r) => r.method !== 'GET');
const puts = (received: Received[]) => received.filter((r) => r.method === 'PUT');

beforeEach(async () => {
  jest.clearAllMocks();
  injected = undefined;
  await lock({});
  process.exitCode = undefined;
  exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit must not be called under run()');
  }) as any);
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise((done) => s.close(() => done(null)))));
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
  warnSpy.mockRestore();
});

// ─── the defect: the lock runs before the preview ─────────────────────────────

describe('cards update --dry-run takes the scope lock FIRST (#108)', () => {
  it('a card outside the lock refuses, prints no preview, and writes nothing', async () => {
    const { received } = await startServer();
    await lock(LOCK);

    const thrown = await attempt('update', OUT_CARD, '--name', 'New name', '--dry-run');

    expect(thrown).toBe(1);
    expect(said()).toContain('Scope violation');
    // The positive half of this pair is the next arm, which asserts this very
    // line IS printed — so the absence here is falsifiable rather than vacuous.
    expect(said()).not.toContain('[dry-run]');
    expect(said()).not.toContain('New name');
    // The load-bearing one. Only the socket can distinguish "refused before
    // writing" from "wrote and then reported a refusal".
    expect(writes(received)).toEqual([]);
  });

  it('a card INSIDE the lock still previews, and still writes nothing', async () => {
    const { received } = await startServer();
    await lock(LOCK);

    await run('update', IN_CARD, '--name', 'New name', '--dry-run');

    expect(said()).toContain('[dry-run]');
    expect(said()).toContain(`update card ${IN_CARD}`);
    expect(said()).toContain('New name');
    expect(said()).not.toContain('Scope violation');
    expect(writes(received)).toEqual([]);
  });

  it('with NO lock configured it previews, and writes nothing', async () => {
    const { received } = await startServer();

    await run('update', OUT_CARD, '--name', 'New name', '--dry-run');

    expect(said()).toContain('[dry-run]');
    expect(writes(received)).toEqual([]);
  });

  it('--force previews the out-of-lock card anyway, and says so', async () => {
    const { received } = await startServer();
    await lock(LOCK);

    // Passed for real rather than asserted about: #126 shipped a `--force` claim
    // that held only because no test ever passed the flag.
    await run('update', OUT_CARD, '--name', 'New name', '--dry-run', '--force');

    expect(said()).toContain('[dry-run]');
    expect(said()).toContain('--force was used');
    expect(writes(received)).toEqual([]);
  });

  it('a lock with NO scopeCollectionName still refuses — the gate keys on the id', async () => {
    // The name is optional in `FavroConfig` and every reader spells it
    // `scopeCollectionName ?? scopeCollectionId`, so a config carrying an id and
    // no name is a supported shape. A gate keyed on the NAME fails open for it,
    // which is the drift this arm exists to catch.
    const { received } = await startServer();
    await lock({ scopeCollectionId: LOCKED_COLLECTION });

    const thrown = await attempt('update', OUT_CARD, '--name', 'New name', '--dry-run');

    expect(thrown).toBe(1);
    expect(said()).toContain(LOCKED_COLLECTION);
    expect(said()).not.toContain('[dry-run]');
    expect(writes(received)).toEqual([]);
  });

  it('the REAL run refuses the same card, and issues no write', async () => {
    const { received } = await startServer();
    await lock(LOCK);

    const thrown = await attempt('update', OUT_CARD, '--name', 'New name', '--yes');

    expect(thrown).toBe(1);
    expect(said()).toContain('Scope violation');
    expect(writes(received)).toEqual([]);
  });

  it('a comment-only dry run takes the lock too — it dispatches nothing', async () => {
    // The comment is not an intent (no compensating write), so the table's own
    // guardrail never sees it. The CLI's hoisted check is the ONLY lock guarding a
    // comment-only invocation, which is why that check is not skipped when there
    // are no fields to dispatch. Gating it on `hasFields` reopens exactly this.
    const { received } = await startServer();
    await lock(LOCK);

    const thrown = await attempt('update', OUT_CARD, '--comment', 'ship it', '--dry-run');

    expect(thrown).toBe(1);
    expect(said()).toContain('Scope violation');
    expect(said()).not.toContain('[dry-run]');
    expect(writes(received)).toEqual([]);
  });
});

// ─── what the intent inherits by being on the one table ───────────────────────

describe('the update intent inherits the table guardrails (#108)', () => {
  it('refuses an enumerated batch over the cap, naming the cap and the reason', async () => {
    const { received } = await startServer();
    const cards = Array.from({ length: MULTI_WRITE_CAP + 1 }, () => ({
      card: IN_CARD,
      name: 'x',
    }));

    await expect(
      dispatch('update', { cards }, { client: injected!, config: (await readConfig()) ?? {} }),
    ).rejects.toThrow(
      // The MESSAGE, not just the class: `rejects.toThrow()` with no argument
      // passes on any throw at all, including a TypeError from a mis-shaped arg.
      new RegExp(`Refusing to update ${MULTI_WRITE_CAP + 1} cards.*capped at ${MULTI_WRITE_CAP}`, 's'),
    );
    // A refusal is a PRE-write refusal: not one of the 21 was touched.
    expect(writes(received)).toEqual([]);
  });

  it('says the cap is not a page size, so a reader does not truncate and report success', async () => {
    await startServer();
    const cards = Array.from({ length: MULTI_WRITE_CAP + 1 }, () => ({ card: IN_CARD, name: 'x' }));

    await expect(
      dispatch('update', { cards }, { client: injected!, config: (await readConfig()) ?? {} }),
    ).rejects.toThrow(/not a page size/);
  });

  it('refuses an EMPTY enumerated batch rather than reporting a vacuous ok', async () => {
    await startServer();

    await expect(
      dispatch('update', { cards: [] }, { client: injected!, config: (await readConfig()) ?? {} }),
    ).rejects.toThrow(/Nothing to update: the enumerated card list is empty/);
  });

  it('refuses an entry naming no field rather than skipping it', async () => {
    // Skipping is the silent-wrong-answer shape: the run would report `ok` over a
    // card it never wrote, and the caller's own list is the only record of intent.
    const { received } = await startServer();

    await expect(
      dispatch(
        'update',
        { cards: [{ card: IN_CARD, name: 'ok' }, { card: OUT_CARD }] },
        { client: injected!, config: (await readConfig()) ?? {} },
      ),
    ).rejects.toThrow(/Nothing to update on .*: no field was given/);
    // Refused before ANY entry was written, including the well-formed first one.
    expect(writes(received)).toEqual([]);
  });

  it('a batch STRADDLING the lock refuses as a whole, before anything is written', async () => {
    // `board()` returns every entry's board, not the first. Taking the first would
    // let one in-scope entry smuggle the rest of the batch past the lock.
    const { received } = await startServer();
    await lock(LOCK);

    await expect(
      dispatch(
        'update',
        { cards: [{ card: IN_CARD, name: 'a' }, { card: OUT_CARD, name: 'b' }] },
        { client: injected!, config: (await readConfig()) ?? {} },
      ),
    ).rejects.toThrow(/Scope violation/);
    // The in-scope entry is NOT written. This is the assertion that fails if
    // `board()` ever returns only the first board.
    expect(writes(received)).toEqual([]);
  });

  it('a batch entirely inside the lock writes every entry', async () => {
    // The opposite polarity of the straddle arm: without it, "nothing was
    // written" would pass for an intent that can never write at all.
    const { received, cards } = await startServer();
    await lock(LOCK);

    const result = await dispatch('update', {
      cards: [{ card: IN_CARD, name: 'a' }],
    }, { client: injected!, config: (await readConfig()) ?? {} });

    expect(result.outcome).toBe('ok');
    expect(cards.get(IN_CARD)!.name).toBe('a');
    expect(writes(received)).not.toEqual([]);
  });

  it('refuses a boardless card (a fork) under a lock — --force does not rescue it', async () => {
    // A card with no `widgetCommonId` is a write the lock structurally cannot see.
    // `--force` is "I know this board is outside the lock"; here there is no board
    // to know anything about.
    const { received } = await startServer();
    await lock(LOCK);

    await expect(
      dispatch(
        'update',
        { card: FORK_CARD, name: 'New name' },
        { client: injected!, config: (await readConfig()) ?? {}, force: true },
      ),
    ).rejects.toThrow(/it writes, but it resolved no board/);
    expect(writes(received)).toEqual([]);
  });
});

// ─── the wire shapes, observed rather than restated ───────────────────────────

describe('each field goes out in the spelling Favro honours (#108)', () => {
  it('--status becomes a columnId write, never {status}', async () => {
    // `PUT {status}` answers 200 and changes nothing. The stand honours only
    // `columnId`, so the card actually moving is the observation — not the payload.
    const { received, cards } = await startServer();

    await run('update', IN_CARD, '--status', 'Done', '--yes');

    expect(cards.get(IN_CARD)!.columnId).toBe(DONE);
    const written = puts(received).map((r) => r.body);
    // `widgetCommonId` rides along because Favro resolves `columnId` against it —
    // without it the move is denied with a 202 the stack reads as success (#162).
    expect(written).toEqual([{ columnId: DONE, widgetCommonId: IN_BOARD }]);
    for (const body of written) expect(body).not.toHaveProperty('status');
    expect(said()).toContain(`✓ Card updated: ${IN_CARD} (status)`);
  });

  it('--description becomes a detailedDescription write, never {description}', async () => {
    // Measured silent no-op (`cards-api.ts` `mapDescription`). The stand ignores
    // `description` outright, so a regression here leaves the body unchanged and
    // this arm fails on the stored value rather than on the payload shape alone.
    const { received, cards } = await startServer();

    await run('update', IN_CARD, '--description', 'A new body', '--yes');

    expect(cards.get(IN_CARD)!.detailedDescription).toBe('A new body');
    const written = puts(received).map((r) => r.body);
    expect(written).toEqual([{ detailedDescription: 'A new body' }]);
    for (const body of written) expect(body).not.toHaveProperty('description');
  });

  it('--name writes the name, and reports the field it wrote', async () => {
    const { cards } = await startServer();

    await run('update', IN_CARD, '--name', 'Renamed', '--yes');

    expect(cards.get(IN_CARD)!.name).toBe('Renamed');
    expect(said()).toContain(`✓ Card updated: ${IN_CARD} (name)`);
  });

  it('--tags resolves names to ids and diffs, never a whole-array tags write', async () => {
    // A whole-array `tags` PUT answers 200 and writes nothing; only
    // `addTagIds` / `removeTagIds` are honoured.
    const { received, cards } = await startServer();

    await run('update', IN_CARD, '--tags', ' bug , urgent ', '--yes');

    expect(cards.get(IN_CARD)!.tags.sort()).toEqual(['tag-bug', 'tag-urgent']);
    for (const body of puts(received).map((r) => r.body)) {
      expect(body).not.toHaveProperty('tags');
    }
    expect(said()).toContain('(tags)');
  });

  it('a whitespace-only --tags entry is dropped, not sent as a blank tag name', async () => {
    // What the trim in the CLI's `csv()` actually buys. Every downstream resolver
    // already trims — `tags-api.ts` trims its key before `foldName`, `hasIdShape`
    // trims before matching a shape, and `resolveAssignee` trims its value — so a
    // spaced-but-nonempty ` bug ` resolves correctly with or without it. Mutating
    // that `.map(trim)` away leaves all 3691 tests green, which is how a comment
    // claiming the trim stops a tag CREATION survived while being false.
    //
    // The one input that does depend on it: an entry that is nothing but spaces.
    // Without the trim, `filter(Boolean)` keeps `' '` — a non-empty string — and a
    // blank tag NAME reaches the resolver, where an unknown name on a write is a
    // tag creation. With it the entry becomes `''` and is dropped.
    const { received, cards } = await startServer();

    await run('update', IN_CARD, '--tags', 'bug, ,urgent', '--yes');

    expect(cards.get(IN_CARD)!.tags.sort()).toEqual(['tag-bug', 'tag-urgent']);
    for (const body of puts(received).map((r) => r.body)) {
      const added: string[] = (body as any).addTagIds ?? [];
      expect(added.filter((t) => t.trim() === '')).toEqual([]);
    }
  });

  it('--assignees resolves a name to a userId and ADDS it', async () => {
    const { received, cards } = await startServer();

    await run('update', IN_CARD, '--assignees', 'Alice Ahlberg', '--yes');

    expect(cards.get(IN_CARD)!.assignments).toEqual([{ userId: ALICE }]);
    for (const body of puts(received).map((r) => r.body)) {
      // `assignees` and `assignmentIds` are both silent no-ops on PUT.
      expect(body).not.toHaveProperty('assignees');
      expect(body).not.toHaveProperty('assignmentIds');
    }
  });

  it('--column is a second spelling of --status, resolved against the card own board', async () => {
    const { cards } = await startServer();

    await run('update', IN_CARD, '--column', 'Done', '--yes');

    expect(cards.get(IN_CARD)!.columnId).toBe(DONE);
    expect(said()).toContain('(status)');
  });

  it('--status and --column naming different columns refuses as ambiguous', async () => {
    const { received } = await startServer();

    const thrown = await attempt('update', IN_CARD, '--status', 'Done', '--column', 'To Do', '--yes');

    expect(thrown).toBe(1);
    expect(said()).toContain('two spellings of one field');
    expect(writes(received)).toEqual([]);
  });
});

// ─── the compensation log this path never had ─────────────────────────────────

describe('a part-way failure unwinds the fields already written (#108)', () => {
  it('restores the name when the column move that follows it fails', async () => {
    // This is the whole point of routing through the table. The old path sent ONE
    // PUT carrying every key: it landed whole or failed whole, Favro did not say
    // which, and a partial write had no record and no inverse.
    //
    // `status` is applied LAST by the intent, and it is the field whose primitive
    // confirms its own write, so it is the realistic failure point.
    const { received, cards } = await startServer({
      failPut: (body) => body.columnId !== undefined,
    });

    const result = await dispatch(
      'update',
      { card: IN_CARD, name: 'Renamed', status: 'Done' },
      { client: injected!, config: (await readConfig()) ?? {} },
    );

    expect(result.outcome).toBe('rolled-back');
    // The world is genuinely back where it started — asserted on the stand's own
    // state, not merely on the outcome string the code chose to report.
    expect(cards.get(IN_CARD)!.name).toBe('Original name');
    expect(cards.get(IN_CARD)!.columnId).toBe(TODO);
    // And the restore was a real WRITE, observed on the socket. Without this, a
    // rollback that did nothing while the forward write had also silently done
    // nothing would satisfy the assertions above.
    expect(puts(received).map((r) => r.body)).toEqual([
      { name: 'Renamed' },
      { columnId: DONE, widgetCommonId: IN_BOARD },
      { name: 'Original name' },
    ]);
    // The wire named the failure (403), so the same call fails the same way.
    expect(result.retryable).toBe(false);
  });

  it('leaves a successful chain alone — the opposite polarity of the unwind', async () => {
    // Without this arm, "the name is back to Original name" would pass for an
    // intent whose forward name write never happened at all.
    const { cards } = await startServer();

    const result = await dispatch(
      'update',
      { card: IN_CARD, name: 'Renamed', status: 'Done' },
      { client: injected!, config: (await readConfig()) ?? {} },
    );

    expect(result.outcome).toBe('ok');
    expect(cards.get(IN_CARD)!.name).toBe('Renamed');
    expect(cards.get(IN_CARD)!.columnId).toBe(DONE);
    expect(result.value).toEqual({ cardId: IN_CARD, wrote: ['name', 'status'] });
  });

  it('a failure on ROW 2 unwinds row 1 — the multi-card unwind (#110)', async () => {
    // The behaviour `cards update --from-csv` now headlines: "a failure on row 12
    // unwinds rows 1-11 rather than leaving them standing". Every other arm in
    // this describe dispatches ONE card, so all of them pass for an intent that
    // compensates within an entry and abandons the entries before it — which is
    // exactly what `BulkTransaction` did, and what #110 deleted it for. Review
    // found this pinned nowhere: `cli-cards-batch.test.ts`'s deleted
    // "atomically rolls back on failure" arm was the only one, and it did not
    // move with the behaviour.
    //
    // Asserted on the PUT SEQUENCE, not on `outcome`. `rolled-back` is a string
    // the code chooses; the third PUT is the compensating write actually going
    // out, on a card the failing entry never touched.
    const SECOND = '00000000000000000000cc04';
    const { received, cards } = await startServer({
      cards: [card({ cardId: IN_CARD }), card({ cardId: SECOND })],
      failPut: (body) => body.name === 'BOOM',
    });

    const result = await dispatch(
      'update',
      { cards: [{ card: IN_CARD, name: 'WROTE-FIRST' }, { card: SECOND, name: 'BOOM' }] },
      { client: injected!, config: (await readConfig()) ?? {} },
    );

    expect(result.outcome).toBe('rolled-back');
    expect(puts(received).map((r) => r.body)).toEqual([
      { name: 'WROTE-FIRST' },
      { name: 'BOOM' },
      { name: 'Original name' },
    ]);
    // The stand's own state, so "unwound" is not just the log's opinion.
    expect(cards.get(IN_CARD)!.name).toBe('Original name');
    expect(cards.get(SECOND)!.name).toBe('Original name');
  });

  it('reports the failure through the CLI as a refusal, not as success', async () => {
    // ADR-0002: exit 1 and something a reader can act on. A `rolled-back` that
    // printed the success line would be the expensive direction.
    const { received } = await startServer({ failPut: (body) => body.columnId !== undefined });

    const thrown = await attempt('update', IN_CARD, '--name', 'Renamed', '--status', 'Done', '--yes');

    expect(thrown).toBe(1);
    expect(said()).toContain('update failed');
    expect(said()).toContain('Rolled back');
    expect(said()).not.toContain('✓ Card updated');
    // The restoring PUT went out, so "Rolled back" is an observation.
    expect(puts(received).map((r) => r.body)).toContainEqual({ name: 'Original name' });
  });
});
