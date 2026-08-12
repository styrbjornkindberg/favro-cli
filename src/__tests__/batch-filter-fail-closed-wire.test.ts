/**
 * `batch move` / `batch assign` refuse a `--filter` they cannot settle, over a
 * `node:http` Favro stand-in — issue #138.
 *
 * WHY THE WIRE, AND NOT A MOCKED `CardsAPI`
 * The claim under test is "no bulk write was ATTEMPTED". A mocked `CardsAPI`
 * can only say a method was not called; it cannot tell a write that never left
 * the process from one the SUT sent down some other path — a `TxCards` facade,
 * a second client, a retry. The stand-in records every request it receives, so
 * "the server saw no PUT and no POST" is the whole claim, checked where it is
 * actually true or false. `dispatch-tx-wire.test.ts` states the same rule.
 *
 * WHAT WAS WRONG
 * `parseFilterExpression` was a third `--filter` grammar, on the two commands
 * whose entire purpose is to change many cards at once. It split on `:`,
 * substring-matched tags and assignees, and read an unknown field as
 * `() => false` — commented "match nothing (safe default)". So
 * `batch move --filter "tagg:bug"` printed "No cards match the filter(s)" and
 * exited 0, and a typo was indistinguishable from an empty result on a command
 * the user believes just ran.
 *
 * The positive controls at the bottom are load-bearing: without them every
 * "no PUT reached the wire" assertion below would also pass on a command that
 * is simply broken.
 */
import * as http from 'http';
import * as fs from 'fs/promises';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
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
tempConfigDir('favro-batch-filter-config-');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildProgram } = require('../cli') as typeof import('../cli');

const ORG = 'org-1';
const BOARD = 'board-a';
const TODO = 'col-todo';
const DONE = 'col-done';
const ALICE = 'aaaaaaaaaaaaaaaaa';

/** A second board with NO columns — a `--to-board` whose vocabulary is empty. */
const OTHER_BOARD = 'board-b';

const BOARDS = [
  {
    widgetCommonId: BOARD,
    name: 'Board A',
    collectionIds: ['coll-a'],
    columns: [
      { columnId: TODO, name: 'To Do', position: 0 },
      { columnId: DONE, name: 'Done', position: 1 },
    ],
  },
  { widgetCommonId: OTHER_BOARD, name: 'Board B', collectionIds: ['coll-a'], columns: [] },
];

/**
 * `bug` and `debug` both exist on purpose — see the substring control (#84).
 * `needs review` holds a SPACE, which real Favro tags routinely do: it is what
 * makes `tag:${label}` string-splicing observable, since `tag:needs review` is
 * a parse error rather than that tag.
 */
const TAGS = [
  { tagId: 'tag-bug', name: 'bug' },
  { tagId: 'tag-debug', name: 'debug' },
  { tagId: 'tag-review', name: 'needs review' },
];

const USERS = [{ userId: ALICE, name: 'alice', email: 'alice@example.com' }];

interface Received { method: string; path: string; body?: any }

interface StoredCard {
  cardId: string;
  cardCommonId: string;
  name: string;
  widgetCommonId: string;
  columnId: string;
  tags: string[];
  assignments: Array<{ userId: string }>;
  createdAt: string;
}

interface Stand {
  received: Received[];
  cards: Map<string, StoredCard>;
}

/** Every server this file started, so a failed assertion cannot leak a listener. */
const running: http.Server[] = [];

function card(id: string, over: Partial<StoredCard> = {}): StoredCard {
  return {
    cardId: id,
    cardCommonId: `ccid-${id}`,
    name: `Card ${id}`,
    widgetCommonId: BOARD,
    columnId: TODO,
    tags: ['tag-bug'],
    assignments: [],
    createdAt: '2026-01-01',
    ...over,
  };
}

function startServer(): Promise<Stand> {
  const received: Received[] = [];
  const cards = new Map<string, StoredCard>([
    ['card-1', card('card-1')],
    // Tagged `debug`, not `bug`. A substring grammar writes to this one too.
    ['card-2', card('card-2', { tags: ['tag-debug'] })],
    ['card-3', card('card-3', { tags: ['tag-review'] })],
  ]);

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = req.url ?? '';
      const pathOnly = url.split('?')[0].replace('/api/v1', '');
      const r: Received = {
        method: req.method ?? '',
        path: pathOnly,
        body: raw ? JSON.parse(raw) : undefined,
      };
      received.push(r);

      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      // Cards carry tag NAMES on the read side, ids on the write side.
      const wire = (c: StoredCard) => ({
        ...c,
        tags: c.tags.map((id) => TAGS.find((t) => t.tagId === id)?.name ?? id),
      });

      const one = pathOnly.match(/^\/cards\/([^/]+)$/);
      if (one && r.method === 'PUT') {
        const found = cards.get(one[1]);
        if (!found) return send(404, { message: 'Card not found' });
        const next = { ...found, ...r.body };
        cards.set(one[1], next);
        return send(200, wire(next));
      }
      if (one && r.method === 'GET') {
        const found = cards.get(one[1]);
        return found ? send(200, wire(found)) : send(404, { message: 'Card not found' });
      }
      if (pathOnly === '/cards') {
        return send(200, { entities: [...cards.values()].map(wire) });
      }
      if (pathOnly.startsWith('/widgets')) {
        const byId = pathOnly.slice('/widgets'.length).replace(/^\//, '');
        if (byId) {
          const found = BOARDS.find((w) => w.widgetCommonId === byId);
          return found ? send(200, found) : send(404, { message: 'Widget not found' });
        }
        return send(200, { entities: BOARDS });
      }
      if (pathOnly === '/tags') return send(200, { entities: TAGS });
      if (pathOnly === '/users') return send(200, { entities: USERS });
      if (pathOnly.startsWith('/columns')) {
        return send(200, { entities: BOARDS[0].columns.map((c) => ({ ...c, widgetCommonId: BOARD })) });
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
        auth: { organizationId: ORG, token: 'test-token', email: 'test@example.com' },
      });
      resolve({ received, cards });
    });
  });
}

/**
 * THE assertion of this file: the server was asked to change nothing.
 *
 * Every method that can mutate, not just the one the command happens to use —
 * a rewrite that moved cards with `POST /cards` would otherwise slip through.
 */
const mutations = (received: Received[]) =>
  received.filter((r) => ['PUT', 'POST', 'DELETE', 'PATCH'].includes(r.method));

let exitSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;
let errSpy: jest.SpyInstance;

/** `batch …` as a user reaches it, with `process.exit` turned into a throw. */
const run = (...argv: string[]) =>
  buildProgram().parseAsync(['node', 'favro', 'batch', ...argv]);

/**
 * Run and hand back the exit code — `undefined` when the command returned
 * normally.
 *
 * Deliberately NOT `expect(run(…)).rejects`: that asserts the exit FIRST, and
 * a first failing assertion hides every one after it. The claim this file
 * exists for is "no write was attempted", and it has to be able to fail on its
 * own — a rewrite that refuses too late, after the PUTs are away, must go red
 * on the wire assertion and not merely on the exit code.
 */
async function exitCodeOf(...argv: string[]): Promise<number | undefined> {
  try {
    await run(...argv);
    return undefined;
  } catch (err) {
    const m = /^process\.exit\((\d+)\)$/.exec((err as Error).message);
    if (!m) throw err;
    return Number(m[1]);
  }
}

const said = () =>
  [...errSpy.mock.calls, ...logSpy.mock.calls].map((c) => c.map(String).join(' ')).join('\n');

beforeEach(() => {
  jest.clearAllMocks();
  injected = undefined;
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as any);
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise((done) => s.close(() => done(null)))));
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
  // The name cache persists across tests in this file; a stale `columns` or
  // `tags` record would let a later refusal be answered from an earlier fetch.
  //
  // `invalidateCache()`, NOT `fs.rm` of the file: `name-cache` memoises the
  // parsed file in a module global that only its own `writeFile` clears, so
  // deleting the file left the previous test's records being served from memory
  // and this cleanup did nothing at all.
  await invalidateCache();
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Each row is one shape of unresolvable filter, with the token the refusal must
 * name. `--yes` is passed throughout: the confirmation prompt is not what is
 * standing between the user and the write here, and a test that relied on it
 * would pass for the wrong reason.
 */
const UNRESOLVABLE: Array<[label: string, filter: string, token: string]> = [
  ['an unknown field', 'tagg:bug', 'tagg'],
  ['an unknown bare token', 'typoo', 'typoo'],
  ['an unknown tag', 'tag:typoo', 'typoo'],
  ['an unknown status', 'status:Shipped', 'Shipped'],
  ['an unknown assignee', 'assignee:nobody', 'nobody'],
];

describe('batch move refuses a filter it cannot settle, and writes nothing', () => {
  test.each(UNRESOLVABLE)('%s', async (_label, filter, token) => {
    const stand = await startServer();

    const code = await exitCodeOf('move', '--board', BOARD, '--status', 'Done', '--filter', filter, '--yes');

    // First, and on its own: the server was asked to change nothing.
    expect(mutations(stand.received)).toEqual([]);
    expect(code).toBe(1);
    expect(said()).toContain(token);
    // The refusal must not be mistaken for an empty result.
    expect(said()).not.toContain('No cards match');
  });

  test('the refusal fires under --dry-run too', async () => {
    const stand = await startServer();

    const code = await exitCodeOf('move', '--board', BOARD, '--status', 'Done', '--filter', 'tag:typoo', '--dry-run');

    expect(mutations(stand.received)).toEqual([]);
    expect(code).toBe(1);
    expect(said()).toContain('typoo');
    // A dry run that cheerfully plans zero cards is the same lie, one step earlier.
    expect(said()).not.toContain('Dry-run preview');
  });
});

describe('batch assign refuses a filter it cannot settle, and writes nothing', () => {
  test.each(UNRESOLVABLE)('%s', async (_label, filter, token) => {
    const stand = await startServer();

    const code = await exitCodeOf('assign', '--board', BOARD, '--to', 'alice', '--filter', filter, '--yes');

    expect(mutations(stand.received)).toEqual([]);
    expect(code).toBe(1);
    expect(said()).toContain(token);
    expect(said()).not.toContain('No cards match');
  });

  test('the refusal fires under --dry-run too', async () => {
    const stand = await startServer();

    const code = await exitCodeOf('assign', '--board', BOARD, '--to', 'alice', '--filter', 'tag:typoo', '--dry-run');

    expect(mutations(stand.received)).toEqual([]);
    expect(code).toBe(1);
    expect(said()).not.toContain('Dry-run preview');
  });
});

describe('a refusal names candidates, so the user can act on it', () => {
  test('an unknown tag lists the org tags', async () => {
    await startServer();

    expect(await exitCodeOf('move', '--board', BOARD, '--status', 'Done', '--filter', 'tag:typoo', '--yes')).toBe(1);

    expect(said()).toContain('bug');
    expect(said()).toContain('debug');
  });

  test('an unknown field lists the fields a filter may name', async () => {
    await startServer();

    expect(await exitCodeOf('assign', '--board', BOARD, '--to', 'alice', '--filter', 'tagg:bug', '--yes')).toBe(1);

    expect(said()).toContain('Known fields');
    expect(said()).toContain('assignee');
  });
});

// ─── an EMPTY filter is the same fail-open, pointing the other way ───────────

/**
 * `--filter ""` is the widest possible blast radius, and #138 opened it.
 *
 * The deleted `parseFilterExpression("")` read the empty key as an unknown
 * field and matched NOTHING. Routing these commands through `applyFilters`
 * inverted that: an empty expression parses to a null AST, which matches EVERY
 * card. `favro batch move --board B --status Done --filter "$SPRINT" --yes`
 * with `SPRINT` unset moved the entire board and exited 0.
 *
 * `cards list` refused this all along — `resolveCardFilter` calls `refuseEmpty`
 * — so the fix is that same refusal in `applyFilters`, not a second one here.
 */
describe('an empty --filter refuses rather than selecting the whole board', () => {
  const EMPTY: Array<[label: string, filter: string]> = [
    ['an unset shell variable', ''],
    ['whitespace only', '   '],
  ];

  test.each(EMPTY)('batch move refuses %s', async (_label, filter) => {
    const stand = await startServer();

    const code = await exitCodeOf('move', '--board', BOARD, '--status', 'Done', '--filter', filter, '--yes');

    expect(mutations(stand.received)).toEqual([]);
    expect(code).toBe(1);
    expect(said()).toContain('empty value');
    expect(said()).not.toContain('No cards match');
  });

  test.each(EMPTY)('batch assign refuses %s', async (_label, filter) => {
    const stand = await startServer();

    const code = await exitCodeOf('assign', '--board', BOARD, '--to', 'alice', '--filter', filter, '--yes');

    expect(mutations(stand.received)).toEqual([]);
    expect(code).toBe(1);
    expect(said()).toContain('empty value');
  });

  test('and under --dry-run, where the preview would have listed every card', async () => {
    const stand = await startServer();

    const code = await exitCodeOf('move', '--board', BOARD, '--status', 'Done', '--filter', '', '--dry-run');

    expect(mutations(stand.received)).toEqual([]);
    expect(code).toBe(1);
    expect(said()).not.toContain('Dry-run preview');
  });
});

// ─── `cards update --board --label` shares the seam, and must not splice ─────

/**
 * The third caller of the deleted `buildFilterFn`, and the one the #84 ratchet
 * called the WORSE one: `cards update --board <b> --label bug --status done`.
 *
 * `--label` is a tag NAME typed by a user, and a Favro tag routinely holds a
 * space or a colon. Spliced into a filter string as `tag:${label}` it stops
 * being a value and becomes grammar — `tag:needs review` is a parse error, and
 * `--label "bug OR tag:debug"` selects a WIDER set than the one label asked
 * for, on a command that writes. `resolveCardFilter` takes it as an AST node
 * for this exact reason (#84); this pins that it keeps doing so.
 */
describe('cards update --board --label treats the label as a value, not grammar', () => {
  const update = (...argv: string[]) =>
    buildProgram().parseAsync(['node', 'favro', 'cards', 'update', ...argv]);

  test('a tag whose name contains a space still matches its card', async () => {
    const stand = await startServer();

    await update('--board', BOARD, '--label', 'needs review', '--status', 'Done', '--yes');

    expect(mutations(stand.received).map((r) => r.path)).toEqual(['/cards/card-3']);
    expect(stand.cards.get('card-3')!.columnId).toBe(DONE);
  });

  test('an exact label writes only its own card, never the containing one', async () => {
    const stand = await startServer();

    await update('--board', BOARD, '--label', 'bug', '--status', 'Done', '--yes');

    expect(mutations(stand.received).map((r) => r.path)).toEqual(['/cards/card-1']);
    expect(stand.cards.get('card-2')!.columnId).toBe(TODO);
  });

  test('a label carrying query grammar refuses, and widens nothing', async () => {
    const stand = await startServer();

    let code: number | undefined;
    try {
      await update('--board', BOARD, '--label', 'bug OR tag:debug', '--status', 'Done', '--yes');
    } catch (err) {
      const m = /^process\.exit\((\d+)\)$/.exec((err as Error).message);
      if (!m) throw err;
      code = Number(m[1]);
    }

    expect(mutations(stand.received)).toEqual([]);
    expect(code).toBe(1);
  });
});

// ─── the TARGET status is a column too ───────────────────────────────────────

/**
 * `--filter "status:…"` has been settled since #138; the `--status` a `move`
 * WRITES was not, and it is the same closed vocabulary one flag over. Found by
 * running #150's `batch-smart` mutation at this sibling site.
 *
 * Measured against the built CLI before the fix: `batch move --board <b>
 * --status Frobnicated --dry-run` printed a plan for every card on the board and
 * exited 0, and without `--dry-run` it printed the same plan, then failed card by
 * card at the wire and rolled back. A dry run that plans a write which cannot
 * land is #150's lie wearing the other flag.
 *
 * WHY THESE ARMS DO NOT ASSERT ONLY "no PUT". `updateCard` settles the status
 * itself, so the per-card refusal ALSO reached no PUT and ALSO exited 1 and ALSO
 * named the token — deleting the guard below left every one of those assertions
 * green (verified by mutation). What separates the two is how far the command
 * got: the late refusal read the board and announced the move first. So these
 * arms assert the board was never read.
 */
describe('batch move refuses a target --status it cannot settle', () => {
  const fetchedCards = (received: Received[]) =>
    received.filter((r) => r.method === 'GET' && r.path.startsWith('/cards'));

  test('and writes nothing, having never read the board', async () => {
    const stand = await startServer();

    const code = await exitCodeOf('move', '--board', BOARD, '--status', 'Frobnicated', '--yes');

    expect(mutations(stand.received)).toEqual([]);
    expect(fetchedCards(stand.received)).toEqual([]);
    expect(code).toBe(1);
    expect(said()).toContain('Frobnicated');
    expect(said()).toContain('To Do');
    expect(said()).not.toContain('No cards match');
    // Not the per-card failure the wire used to answer, after the announcement.
    expect(said()).not.toContain('rolled back');
    expect(said()).not.toContain('Moving');
  });

  test('under --dry-run too, where it used to print a full plan and exit 0', async () => {
    const stand = await startServer();

    const code = await exitCodeOf('move', '--board', BOARD, '--status', 'Frobnicated', '--dry-run');

    expect(mutations(stand.received)).toEqual([]);
    expect(code).toBe(1);
    expect(said()).toContain('Frobnicated');
    expect(said()).not.toContain('Dry-run preview');
  });

  test('a --to-board move settles the status against the DESTINATION board', async () => {
    const stand = await startServer();

    // `Done` is a column on `board-a`. `board-b` has none, so a move THERE with
    // `--status Done` must refuse — `updateCard` resolves the target status
    // against the board the card lands on, so settling it against the source
    // would let a write through that the wire then rejects per card.
    const code = await exitCodeOf(
      'move', '--board', BOARD, '--to-board', OTHER_BOARD, '--status', 'Done', '--yes',
    );

    expect(mutations(stand.received)).toEqual([]);
    expect(fetchedCards(stand.received)).toEqual([]);
    expect(code).toBe(1);
    expect(said()).toContain('Done');
    expect(said()).not.toContain('rolled back');
    expect(said()).not.toContain('Moving');
  });

  test('and a --status the DESTINATION does have still goes through', async () => {
    const stand = await startServer();

    // The control for the arm above: `board-b` having no columns is what makes
    // that refusal, not `--to-board` refusing everything it is handed.
    await run('move', '--board', BOARD, '--status', 'Done', '--filter', 'tag:bug', '--yes');

    expect(mutations(stand.received).map((r) => r.path)).toEqual(['/cards/card-1']);
    expect(stand.cards.get('card-1')!.columnId).toBe(DONE);
  });
});

// ─── the controls: without these, every assertion above is vacuous ───────────

describe('a filter the vocabulary accepts still performs the write', () => {
  test('batch move writes exactly the matching card', async () => {
    const stand = await startServer();

    await run('move', '--board', BOARD, '--status', 'Done', '--filter', 'tag:bug', '--yes');

    const wrote = mutations(stand.received);
    expect(wrote.map((r) => r.path)).toEqual(['/cards/card-1']);
    expect(stand.cards.get('card-1')!.columnId).toBe(DONE);
    // …and NOT the `debug` card. The old grammar substring-matched, so `bug`
    // hit `debug` too — populated and wrong, which is worse than empty (#84).
    expect(stand.cards.get('card-2')!.columnId).toBe(TODO);
  });

  test('batch assign writes exactly the matching card', async () => {
    const stand = await startServer();

    await run('assign', '--board', BOARD, '--to', 'alice', '--filter', 'tag:bug', '--yes');

    expect(mutations(stand.received).map((r) => r.path)).toEqual(['/cards/card-1']);
    expect(stand.cards.get('card-2')!.assignments).toEqual([]);
  });
});
