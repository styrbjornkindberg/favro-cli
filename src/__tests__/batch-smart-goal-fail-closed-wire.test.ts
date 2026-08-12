/**
 * `batch-smart` refuses a goal it cannot settle, and resolves a board NAME
 * before the scope lock — issue #150.
 *
 * WHY THE WIRE, AND NOT A MOCKED `CardsAPI`
 * The claim under test is "no bulk write was ATTEMPTED". A mocked `CardsAPI`
 * can only say a method was not called; it cannot tell a write that never left
 * the process from one the SUT sent down some other path. The stand-in records
 * every request it receives, so "the server saw no PUT and no POST" is the
 * whole claim, checked where it is actually true or false.
 * `batch-filter-fail-closed-wire.test.ts` states the same rule and this file
 * copies its shape deliberately.
 *
 * WHAT WAS WRONG
 * `buildCardFilter` recognised `all`, `overdue`, `blocked`, `unassigned` and
 * `assigned`, and read ANY other word as `card.status === word`. So
 * `--goal "move all frobnicated cards to Done" --yes` printed "No cards match
 * the goal" and exited 0 — a typo indistinguishable from an empty result, on a
 * command whose whole purpose is to change many cards at once, with the confirm
 * skippable. And `checkScope(board, …)` got the raw argument, so a board NAME
 * 404'd into "Scope check failed: Board … not found" — a refusal naming the
 * wrong problem (#82), on a command that resolves the same name happily one
 * line later when it lists the cards.
 *
 * THE TWO ARMS THAT MUST NOT COLLAPSE
 * An unrecognised word and a recognised word that legitimately matched nothing
 * are two different outcomes. `refuses an unrecognised goal word` and
 * `a recognised filter matching zero cards still REPORTS zero` below are that
 * pair; if a change makes both go the same way, the fix is not real.
 *
 * The positive controls at the bottom are load-bearing: without them every
 * "no PUT reached the wire" assertion here would also pass on a command that is
 * simply broken.
 */
import * as http from 'http';
import * as path from 'path';
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
const CONFIG_DIR = tempConfigDir('favro-batch-smart-config-');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildProgram } = require('../cli') as typeof import('../cli');

const ORG = 'org-1';
const BOARD = 'board-a';
const BOARD_NAME = 'Board A';
const TODO = 'col-todo';
const PROGRESS = 'col-progress';
const DONE = 'col-done';
const ALICE = 'aaaaaaaaaaaaaaaaa';

/**
 * `In Progress` holds a SPACE and a CAPITAL, which is what makes the goal
 * grammar's lowercasing observable: the filter compares against `card.status`,
 * so a token settled to a differently-cased column must come back as the
 * column's OWN spelling or it matches no card at all.
 */
interface StandColumn { columnId: string; name: string; position: number }

const DEFAULT_COLUMNS: StandColumn[] = [
  { columnId: TODO, name: 'To Do', position: 0 },
  { columnId: PROGRESS, name: 'In Progress', position: 1 },
  { columnId: DONE, name: 'Done', position: 2 },
];

const boardsWith = (columns: StandColumn[]) => [
  { widgetCommonId: BOARD, name: BOARD_NAME, collectionIds: ['coll-a'], columns },
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
  dueDate?: string;
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
    tags: [],
    assignments: [],
    createdAt: '2026-01-01',
    ...over,
  };
}

/**
 * @param columns The board's own columns. Overridden by the tests that need the
 *   board's spelling, or the absence of a `Done` column, to be observable —
 *   every arm above rests on the default three.
 */
function startServer(columns: StandColumn[] = DEFAULT_COLUMNS): Promise<Stand> {
  const BOARDS = boardsWith(columns);
  const received: Received[] = [];
  // Two in `To Do`, one already in `Done`, NONE overdue and NONE in
  // `In Progress` — the last two are what the zero-match arms rest on.
  const cards = new Map<string, StoredCard>([
    ['card-1', card('card-1')],
    ['card-2', card('card-2')],
    ['card-3', card('card-3', { columnId: DONE })],
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

      // Cards carry the column NAME under `status` on the read side.
      const wire = (c: StoredCard) => ({
        ...c,
        status: BOARDS[0].columns.find((col) => col.columnId === c.columnId)?.name,
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
 * Every method that can mutate, not just the one the command happens to use.
 */
const mutations = (received: Received[]) =>
  received.filter((r) => ['PUT', 'POST', 'DELETE', 'PATCH'].includes(r.method));

let exitSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;
let errSpy: jest.SpyInstance;
/**
 * The FIRST code `process.exit` was called with — which is the only one a real
 * process would ever act on.
 *
 * The spy has to throw, or execution runs on past the exit; but `batch-smart`
 * wraps its whole body in a `try` whose `catch` calls `logError(…)` and exits 1,
 * so a thrown `exit(0)` comes back out as `exit(1)`. Reading the LAST code would
 * report every clean zero-match report as a failure and every arm below would
 * pass for the wrong reason.
 */
let firstExit: number | undefined;

/** `batch-smart …` as a user reaches it, with `process.exit` turned into a throw. */
const run = (...argv: string[]) =>
  buildProgram().parseAsync(['node', 'favro', 'batch-smart', ...argv]);

/**
 * Run and hand back the exit code — `undefined` when the command returned
 * normally.
 *
 * Deliberately NOT `expect(run(…)).rejects`: that asserts the exit FIRST, and a
 * first failing assertion hides every one after it. The claim this file exists
 * for is "no write was attempted", and it has to be able to fail on its own — a
 * rewrite that refuses too late, after the PUTs are away, must go red on the
 * wire assertion and not merely on the exit code.
 */
async function exitCodeOf(...argv: string[]): Promise<number | undefined> {
  try {
    await run(...argv);
    return firstExit;
  } catch (err) {
    if (firstExit !== undefined) return firstExit;
    throw err;
  }
}

const said = () =>
  [...errSpy.mock.calls, ...logSpy.mock.calls].map((c) => c.map(String).join(' ')).join('\n');

/**
 * The refusal must NAME the offending word — case-insensitively, because it
 * cannot echo the user's own casing.
 *
 * `parseGoal` lowercases the whole goal before any of its four regexes run, so
 * by the time a token reaches the column vocabulary the capitals are gone and
 * `Shipped` is refused as `"shipped"`. Asserted loosely here rather than papered
 * over: see the case wart pinned at the bottom of this file.
 */
const namedTheWord = (token: string) => expect(said().toLowerCase()).toContain(token.toLowerCase());

beforeEach(() => {
  jest.clearAllMocks();
  injected = undefined;
  firstExit = undefined;
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    firstExit ??= code ?? 0;
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
  // `boards` record would let a later refusal be answered from an earlier fetch.
  //
  // `invalidateCache()`, NOT `fs.rm` of the file. `name-cache` memoises the
  // parsed file in a module global that only its own `writeFile` clears, so
  // deleting the file leaves the previous test's columns being served from
  // memory — measured: the two boards below whose columns differ from the
  // default three got answered from each other's fetch, and every arm in this
  // file that shares one column list would have gone on passing without ever
  // hitting the stand. `invalidateCache()` truncates through `writeFile`, which
  // is what drops the memo.
  await invalidateCache();
});

// ─── ARM ONE: an unrecognised goal word refuses ──────────────────────────────

/**
 * Each row is one goal whose column vocabulary does not settle, with the token
 * the refusal must name. `--yes` is passed throughout: the confirmation prompt
 * is not what stands between the user and the write here, and a test that
 * relied on it would pass for the wrong reason.
 */
const UNRESOLVABLE: Array<[label: string, goal: string, token: string]> = [
  ['a typo where a filter keyword was meant', 'move all frobnicated cards to Done', 'frobnicated'],
  ['a column that does not exist', 'move all Shipped cards to Done', 'Shipped'],
  ['an unresolvable token in an AND chain', 'move all overdue and frobnicated cards to Done', 'frobnicated'],
  ['a target column that does not exist', 'move all cards to Shipped', 'Shipped'],
  ['an unresolvable filter on close', 'close all frobnicated cards', 'frobnicated'],
  ['an unresolvable filter on unassign', 'unassign all frobnicated cards', 'frobnicated'],
  ['an unresolvable filter on assign', 'assign all frobnicated cards to alice', 'frobnicated'],
];

describe('batch-smart refuses a goal word it cannot settle, and writes nothing', () => {
  test.each(UNRESOLVABLE)('%s', async (_label, goal, token) => {
    const stand = await startServer();

    const code = await exitCodeOf(BOARD, '--goal', goal, '--yes');

    // First, and on its own: the server was asked to change nothing.
    expect(mutations(stand.received)).toEqual([]);
    expect(code).toBe(1);
    namedTheWord(token);
    // THE defect: the refusal must not be mistaken for an empty result.
    expect(said()).not.toContain('No cards match');
  });

  test.each(UNRESOLVABLE)('%s — under --dry-run too', async (_label, goal, token) => {
    const stand = await startServer();

    const code = await exitCodeOf(BOARD, '--goal', goal, '--dry-run');

    expect(mutations(stand.received)).toEqual([]);
    expect(code).toBe(1);
    namedTheWord(token);
    // A dry run that cheerfully plans zero cards is the same lie, one step earlier.
    expect(said()).not.toContain('Dry-run mode');
    expect(said()).not.toContain('Preview (');
  });

  test('the refusal names the board its columns, so the user can act on it', async () => {
    await startServer();

    expect(await exitCodeOf(BOARD, '--goal', 'move all frobnicated cards to Done', '--yes')).toBe(1);

    expect(said()).toContain('To Do');
    expect(said()).toContain('In Progress');
    expect(said()).toContain('Done');
  });

  /**
   * BOTH POLARITIES, because an absence assertion on its own cannot show that
   * its needle exists.
   *
   * `not.toContain('"success": 0')` was the whole of this arm, and a string this
   * command never emits under any input would have satisfied it forever. The arm
   * below drives the one path that really does print those bytes — a goal the
   * command fully understood, answering zero — so the absence above is a
   * measured difference between two reachable outputs rather than a claim about
   * a string nobody has seen. Proven by mutation: dropping the filter's column
   * names from `ParsedGoal.columnNames` restores the #150 fail-open, this pair
   * goes red on the refusal arm, and the zero-match arm stays green.
   */
  test('and it refuses under --json, emitting no summary at all', async () => {
    const stand = await startServer();

    const code = await exitCodeOf(BOARD, '--goal', 'move all frobnicated cards to Done', '--yes', '--json');

    expect(mutations(stand.received)).toEqual([]);
    expect(code).toBe(1);
    namedTheWord('frobnicated');
    // Not the zero summary the arm below proves this command really can print.
    expect(said()).not.toContain('"success": 0');
    expect(said()).not.toContain('"total": 0');
  });

  test('the zero-match --json summary the refusal must not be mistaken for', async () => {
    const stand = await startServer();

    // `overdue` is a KEYWORD and no card on this stand is overdue: understood,
    // matched nothing. These are the exact bytes the arm above asserts are absent.
    const code = await exitCodeOf(BOARD, '--goal', 'move all overdue cards to Done', '--yes', '--json');

    expect(mutations(stand.received)).toEqual([]);
    expect(code).toBe(0);
    expect(said()).toContain('"success": 0');
    expect(said()).toContain('"total": 0');
  });
});

// ─── ARM TWO: a RECOGNISED goal that matches nothing still reports zero ──────

/**
 * The other half of the pair, and the one that stops the fix from being "refuse
 * whenever the result is empty".
 *
 * `overdue` is a keyword and `In Progress` is a real column on this board;
 * neither matches a single card here. That is a legitimate empty answer to a
 * question the command fully understood, and it must stay an empty answer:
 * exit 0, "No cards match the goal", no refusal. If these tests and the
 * unresolvable ones above ever agree, the fix has collapsed the two outcomes
 * back into one and #150 is open again.
 */
describe('a goal that resolves but matches zero cards REPORTS zero', () => {
  const ZERO_MATCH: Array<[label: string, goal: string]> = [
    ['a keyword filter no card satisfies', 'move all overdue cards to Done'],
    ['a real column holding no cards', 'move all In Progress cards to Done'],
    ['a real column, differently cased', 'move all in progress cards to Done'],
    ['every match already in the target state', 'move all Done cards to Done'],
  ];

  test.each(ZERO_MATCH)('%s', async (_label, goal) => {
    const stand = await startServer();

    const code = await exitCodeOf(BOARD, '--goal', goal, '--yes');

    expect(mutations(stand.received)).toEqual([]);
    // THE separating assertion: this is a REPORT, not a refusal.
    expect(said()).toContain('No cards match');
    expect(code).toBe(0);
  });
});

// ─── DEFECT TWO: a board NAME resolves before the scope lock ─────────────────

/**
 * `checkScope` GETs `/widgets/<id>`. Handed the raw `<board>` argument it 404s
 * on a NAME, and the user is told the scope check failed rather than that the
 * board could not be resolved — #82's bug, one command over. The command
 * resolves that same name happily when it lists the cards, so before this fix
 * `batch-smart "Board A"` worked with no lock configured and died with the
 * wrong message the moment one was.
 */
describe('a board NAME reaches the scope lock resolved', () => {
  const lock = async (scopeCollectionId?: string) =>
    fs.writeFile(
      path.join(CONFIG_DIR, 'config.json'),
      JSON.stringify(scopeCollectionId ? { scopeCollectionId, scopeCollectionName: 'Coll A' } : {}),
    );

  afterEach(() => lock(undefined));

  test('a board NAME inside the locked collection is allowed through', async () => {
    await lock('coll-a');
    const stand = await startServer();

    const code = await exitCodeOf(BOARD_NAME, '--goal', 'move all To Do cards to Done', '--yes');

    expect(said()).not.toContain('Scope check failed');
    expect(said()).not.toContain('Scope violation');
    expect(code).toBeUndefined();
    // The write went through, which is the only proof the lock did not eat it.
    expect(stand.cards.get('card-1')?.columnId).toBe(DONE);
  });

  test('a board NAME outside the locked collection refuses as a SCOPE violation', async () => {
    await lock('coll-elsewhere');
    const stand = await startServer();

    const code = await exitCodeOf(BOARD_NAME, '--goal', 'move all To Do cards to Done', '--yes');

    expect(mutations(stand.received)).toEqual([]);
    expect(code).toBe(1);
    expect(said()).toContain('Scope violation');
    // Not a 404 wearing the scope check's name.
    expect(said()).not.toContain('Scope check failed');
  });

  test('an unresolvable board names the board, not the scope check', async () => {
    await lock('coll-a');
    const stand = await startServer();

    const code = await exitCodeOf('No Such Board', '--goal', 'move all To Do cards to Done', '--yes');

    expect(mutations(stand.received)).toEqual([]);
    expect(code).toBe(1);
    expect(said()).toContain('No Such Board');
    expect(said()).not.toContain('Scope check failed');
  });
});

// ─── POSITIVE CONTROLS ──────────────────────────────────────────────────────

/**
 * Without these, every "no PUT reached the wire" assertion above would also
 * pass on a `batch-smart` that had simply stopped working.
 */
describe('positive controls — the command still writes when the goal settles', () => {
  test('a keyword filter moves the cards it matched', async () => {
    const stand = await startServer();

    const code = await exitCodeOf(BOARD, '--goal', 'unassign all cards', '--yes');

    // Nothing is assigned on this stand, so this is the "understood, matched
    // nothing" path for a NON-column goal: zero, reported, exit 0.
    expect(code).toBe(0);
    expect(said()).toContain('No cards match');
    expect(mutations(stand.received)).toEqual([]);
  });

  test('a real column filter moves exactly the cards in it', async () => {
    const stand = await startServer();

    const code = await exitCodeOf(BOARD, '--goal', 'move all To Do cards to In Progress', '--yes');

    expect(code).toBeUndefined();
    expect(stand.cards.get('card-1')?.columnId).toBe(PROGRESS);
    expect(stand.cards.get('card-2')?.columnId).toBe(PROGRESS);
    // `card-3` was in Done and never matched.
    expect(stand.cards.get('card-3')?.columnId).toBe(DONE);
  });

  test('a lowercase multi-word column still matches the board spelling', async () => {
    const stand = await startServer();

    // `move all to do cards to done` — every token lowercased, as a user types
    // English. Before #150 the filter compared the typed token against
    // `card.status` directly, so this only worked by lowercase coincidence; it
    // now goes through the column's own spelling.
    const code = await exitCodeOf(BOARD, '--goal', 'move all to do cards to done', '--yes');

    expect(code).toBeUndefined();
    expect(stand.cards.get('card-1')?.columnId).toBe(DONE);
  });

  test('assign settles the user AND the column before it writes', async () => {
    const stand = await startServer();

    const code = await exitCodeOf(BOARD, '--goal', 'assign all To Do cards to alice', '--yes');

    expect(code).toBeUndefined();
    const writes = mutations(stand.received);
    expect(writes.length).toBeGreaterThan(0);
    // The userId, never the typed name — `card.assignees` holds ids (#59).
    expect(JSON.stringify(writes.map((w) => w.body))).toContain(ALICE);
    expect(JSON.stringify(writes.map((w) => w.body))).not.toContain('"alice"');
  });
});

// ─── THE BOARD OWNS THE SPELLING ─────────────────────────────────────────────

/**
 * The arms above all run on a board whose columns are spelled exactly as an
 * English goal would type them — `Done`, `To Do` — so every one of them passes
 * on a `batch-smart` that ignored the settled vocabulary and went back to
 * guessing. Mutation testing said so: `columns?.get('done') ?? 'Done'` →
 * `'Done'`, `columns?.get(typedTarget) ?? toTitleCase(typedTarget)` →
 * `toTitleCase(typedTarget)`, and dropping `settledColumns` from the second
 * `parseGoal` call outright all survived all 85 tests.
 *
 * These boards are spelled so that the guess and the board disagree.
 *
 * WHAT IS AND IS NOT AT STAKE. `resolveColumnId` folds case, so a guess that is
 * merely mis-cased still reaches the right column and the PUT is unaffected —
 * measured, not assumed. What the guess gets wrong is everything the user is
 * SHOWN: the goal line, the preview, the per-card summary, and the rollback
 * `previousState`. On a bulk write behind a skippable confirm, the preview is
 * the only thing the user gets to check, so it has to name the column the board
 * actually has.
 */
describe('the board owns the column spelling, not the goal grammar', () => {
  const SHOUTY = [
    { columnId: TODO, name: 'To Do', position: 0 },
    { columnId: DONE, name: 'DONE', position: 1 },
  ];
  const NO_DONE = [
    { columnId: TODO, name: 'To Do', position: 0 },
    { columnId: 'col-qa', name: 'QA', position: 1 },
    { columnId: DONE, name: 'Complete', position: 2 },
  ];

  test('close names the board\'s own done column, not the word "Done"', async () => {
    const stand = await startServer(SHOUTY);

    const code = await exitCodeOf(BOARD, '--goal', 'close all cards', '--yes');

    expect(code).toBeUndefined();
    // The board says `DONE`. Nothing may quietly substitute `Done` for it.
    expect(said()).toContain('DONE (closed)');
    expect(said()).not.toContain('Done (closed)');
    // And the write still landed, so this is not passing on a broken command.
    expect(stand.cards.get('card-1')?.columnId).toBe(DONE);
  });

  test('close on a board with no done column REFUSES, before the preview', async () => {
    const stand = await startServer(NO_DONE);

    const code = await exitCodeOf(BOARD, '--goal', 'close all cards', '--yes');

    // Before #150 this previewed all three cards, promised the write, then
    // failed per card at the wire with the same message and rolled back.
    expect(mutations(stand.received)).toEqual([]);
    expect(code).toBe(1);
    namedTheWord('done');
    expect(said()).toContain('Complete');
    expect(said()).not.toContain('Preview (');
  });

  test('move names the board\'s own target column, not a title-cased guess', async () => {
    const stand = await startServer(NO_DONE);

    // `QA` is not what `toTitleCase` makes of `qa`, which is `Qa`.
    const code = await exitCodeOf(BOARD, '--goal', 'move all To Do cards to qa', '--yes');

    expect(code).toBeUndefined();
    expect(said()).toContain('status: QA');
    expect(said()).not.toContain('status: Qa');
    expect(stand.cards.get('card-1')?.columnId).toBe('col-qa');
  });

  test('a columnId in the filter matches the cards in that column', async () => {
    const stand = await startServer();

    // `resolveColumnId` takes an id as readily as a name, so `col-todo` settles
    // — to the column's NAME, which is what `card.status` carries. Comparing the
    // typed token against `card.status` instead, as every version of this before
    // the settle did, matches nothing and reports zero.
    const code = await exitCodeOf(BOARD, '--goal', `move all ${TODO} cards to Done`, '--yes');

    expect(code).toBeUndefined();
    expect(said()).not.toContain('No cards match');
    expect(stand.cards.get('card-1')?.columnId).toBe(DONE);
    expect(stand.cards.get('card-2')?.columnId).toBe(DONE);
  });

  test('close skips a card already in the done column, by that column\'s name', async () => {
    // `Done ` — a trailing space, which people really do leave in a column name.
    // It FOLDS to `done`, so `resolveColumnId('done')` finds it, but it does not
    // equal `'done'`: the already-in-target skip has to compare against the
    // settled name and not the literal word, or `card-3` is written again for no
    // reason. The only observable is the wire, since the redundant PUT would put
    // the card back where it already was.
    const stand = await startServer([
      { columnId: TODO, name: 'To Do', position: 0 },
      { columnId: DONE, name: 'Done ', position: 1 },
    ]);

    const code = await exitCodeOf(BOARD, '--goal', 'close all cards', '--yes');

    expect(code).toBeUndefined();
    const written = mutations(stand.received).map((r) => r.path);
    expect(written).toEqual(['/cards/card-1', '/cards/card-2']);
    expect(written).not.toContain('/cards/card-3');
  });

  test('a bare "the" narrows nothing and is not looked up as a column', async () => {
    const stand = await startServer();

    // `move all the cards to Done` — English, and `the` names no column. It has
    // to stay a non-filter, or the refusal path swallows a valid goal.
    const code = await exitCodeOf(BOARD, '--goal', 'move all the cards to Done', '--yes');

    expect(code).toBeUndefined();
    namedTheWord('Done');
    expect(stand.cards.get('card-1')?.columnId).toBe(DONE);
    expect(stand.cards.get('card-2')?.columnId).toBe(DONE);
  });
});

// ─── THE CASE WART, pinned rather than papered over ──────────────────────────

/**
 * `parseGoal` lowercases the whole goal before any of its four regexes run, so a
 * refusal cannot echo the capitals the user typed: `Shipped` comes back as
 * `"shipped"`.
 *
 * Recorded as a test rather than left to be rediscovered, because it is the ONE
 * way this refusal falls short of `cards list --filter "status:Shipped"`, which
 * quotes the token verbatim. It is cosmetic — the board's real columns are listed
 * alongside, so the user can still act — and un-lowercasing `parseGoal` is a
 * rewrite of a file #110 deletes. If this test ever goes red because the token is
 * now quoted verbatim, that is an improvement: delete the test.
 */
test('the refusal names the offending word LOWERCASED, not as typed', async () => {
  await startServer();

  expect(await exitCodeOf(BOARD, '--goal', 'move all Shipped cards to Done', '--yes')).toBe(1);

  expect(said()).toContain('"shipped"');
  expect(said()).not.toContain('"Shipped"');
});
