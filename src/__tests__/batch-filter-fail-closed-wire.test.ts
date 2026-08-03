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
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';

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
const CONFIG_DIR = fsSync.mkdtempSync(path.join(os.tmpdir(), 'favro-batch-filter-config-'));
fsSync.writeFileSync(path.join(CONFIG_DIR, 'config.json'), '{}');
process.env.FAVRO_CONFIG_DIR = CONFIG_DIR;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildProgram } = require('../cli') as typeof import('../cli');

const ORG = 'org-1';
const BOARD = 'board-a';
const TODO = 'col-todo';
const DONE = 'col-done';
const ALICE = 'aaaaaaaaaaaaaaaaa';

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
];

/** `bug` and `debug` both exist on purpose — see the substring control (#84). */
const TAGS = [
  { tagId: 'tag-bug', name: 'bug' },
  { tagId: 'tag-debug', name: 'debug' },
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
  await fs.rm(path.join(CONFIG_DIR, 'name-cache.json'), { force: true });
});

afterAll(async () => {
  await fs.rm(CONFIG_DIR, { recursive: true, force: true });
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
