/**
 * `cards create --csv/--bulk` driven through `buildProgram()` against a
 * `node:http` Favro stand-in — the CLI half of issue #55.
 *
 * The intent-level transaction is covered in `dispatch-tx-wire.test.ts`. What is
 * covered HERE is the commander action's wiring TO that intent: the file is
 * parsed, the rows become an enumerated list, the list goes through `dispatch`
 * (not `CardsAPI`), and what the wire receives is what the file said.
 *
 * Every assertion is about the request bodies the stand-in received or the exit
 * code the caller observed. A mocked `CardsAPI` could not tell a create that
 * happened from one that did not — the wire can.
 */
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';

// The only seam: the CLI builds its own client from real credentials, and this
// points that client at the stand-in instead of favro.com. Everything below the
// factory — the dispatch table, the compensation log, `CardsAPI`, axios — is real.
let injected: FavroHttpClient | undefined;
jest.mock('../lib/client-factory', () => ({
  __esModule: true,
  createFavroClient: jest.fn(async () => {
    if (!injected) throw new Error('API key not configured. Run `favro auth login`.');
    return injected;
  }),
  default: jest.fn(async () => injected),
}));

// Set before the CLI is loaded, and hence the `require` below rather than an
// import. NOT because `config.ts` freezes anything — `configDir()` has resolved
// per call since #65 and says so at `config.ts:43`. The reason is the tree
// being required: a module that reads the config during its own import would
// read it too late to be steered by a `beforeEach`, and the scope lock would
// come from the developer's own `~/.favro/config.json`.
const CONFIG_DIR = fsSync.mkdtempSync(path.join(os.tmpdir(), 'favro-cli-bulk-config-'));
fsSync.writeFileSync(path.join(CONFIG_DIR, 'config.json'), '{}');
process.env.FAVRO_CONFIG_DIR = CONFIG_DIR;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildProgram } = require('../cli') as typeof import('../cli');

const ORG = 'org-1';
const BOARD = 'board-a';
const TODO = 'col-todo';

interface Received { method: string; path: string; body?: any }

interface Stand {
  received: Received[];
  cards: Map<string, any>;
}

/** Every server this file started, so a failed assertion cannot leak a listener. */
const running: http.Server[] = [];

const BOARDS = [
  {
    widgetCommonId: BOARD,
    name: 'Board A',
    collectionIds: ['coll-a'],
    columns: [{ columnId: TODO, name: 'To Do', position: 0 }],
  },
];

function startServer(): Promise<Stand> {
  const received: Received[] = [];
  const cards = new Map<string, any>();
  let created = 0;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = req.url ?? '';
      const pathOnly = url.split('?')[0].replace('/api/v1', '');
      const r: Received = { method: req.method ?? '', path: pathOnly, body: raw ? JSON.parse(raw) : undefined };
      received.push(r);

      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      if (pathOnly === '/cards' && r.method === 'POST') {
        created += 1;
        const cardId = `new-card-${created}`;
        const card = {
          cardId,
          cardCommonId: `ccid-${cardId}`,
          name: r.body?.name,
          widgetCommonId: r.body?.widgetCommonId,
          columnId: r.body?.columnId ?? TODO,
          parentCardId: r.body?.parentCardId,
          tags: [],
          assignments: [],
        };
        cards.set(cardId, card);
        return send(200, card);
      }

      const one = pathOnly.match(/^\/cards\/([^/]+)$/);
      if (one) {
        const [, id] = one;
        if (r.method === 'DELETE') {
          cards.delete(id);
          return send(200, {});
        }
        const found = cards.get(id);
        return found ? send(200, found) : send(404, { message: 'Card not found' });
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
        auth: { organizationId: ORG, token: 'test-token', email: 'test@example.com' },
      });
      resolve({ received, cards });
    });
  });
}

const posts = (received: Received[]) => received.filter((r) => r.method === 'POST' && r.path === '/cards');

let tmpDir: string;
let exitSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;
let errSpy: jest.SpyInstance;

/** Write a fixture into this test's own tmpdir and hand back its path. */
async function fixture(name: string, content: string): Promise<string> {
  const file = path.join(tmpDir, name);
  await fs.writeFile(file, content);
  return file;
}

/** `cards create` as a user reaches it, with `process.exit` turned into a throw. */
const run = (...argv: string[]) =>
  buildProgram().parseAsync(['node', 'favro', 'cards', 'create', ...argv]);

beforeEach(async () => {
  jest.clearAllMocks();
  injected = undefined;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-cli-bulk-test-'));
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
  await fs.rm(tmpDir, { recursive: true, force: true });
});

afterAll(async () => {
  await fs.rm(CONFIG_DIR, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('`cards create --csv` sends the file to the wire as one enumerated batch', () => {
  it('creates one card per row, in order, and reports the count', async () => {
    const stand = await startServer();
    const csv = await fixture(
      'tasks.csv',
      'name,description\nFirst,one\nSecond,two\nThird,three\n',
    );

    await run('--csv', csv, '--board', BOARD);

    expect(posts(stand.received).map((r) => r.body.name)).toEqual(['First', 'Second', 'Third']);
    expect(posts(stand.received)[0].body.widgetCommonId).toBe(BOARD);
    expect(stand.cards.size).toBe(3);
    expect(logSpy.mock.calls.flat().join('\n')).toContain('✓ Created 3 cards');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('a blank `parent` cell must not reach the wire as an empty parentCardId', () => {
  it('creates the batch with no parentCardId at all', async () => {
    const stand = await startServer();
    // `parseCSV` gives every declared header a key, so the blank cell on row 1
    // arrives as `''` — and `''` sent as `parentCardId` 403s the create. Since
    // `POST /cards` is atomic and the batch is one transaction, that one blank
    // cell would take the whole file down with an opaque error.
    const csv = await fixture('parents.csv', 'name,parent\nFirst,\nSecond,\n');

    await run('--csv', csv, '--board', BOARD);

    for (const p of posts(stand.received)) {
      expect(p.body).not.toHaveProperty('parentCardId');
    }
    expect(stand.cards.size).toBe(2);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('still sends a parent that the file actually named', async () => {
    const stand = await startServer();
    const csv = await fixture('parents2.csv', 'name,parent\nFirst,\nSecond,new-card-1\n');

    await run('--csv', csv, '--board', BOARD);

    const bodies = posts(stand.received).map((r) => r.body.parentCardId);
    expect(bodies).toEqual([undefined, 'new-card-1']);
  });
});

describe('the cap is a refusal, not a truncation', () => {
  it('an over-cap CSV exits non-zero having created nothing', async () => {
    const stand = await startServer();
    const rows = Array.from({ length: 21 }, (_, i) => `Card ${i + 1},body`).join('\n');
    const csv = await fixture('big.csv', `name,description\n${rows}\n`);

    await expect(run('--csv', csv, '--board', BOARD)).rejects.toThrow('process.exit(1)');

    // Not "the first 20 landed" — nothing did. A partial create reported as
    // success is exactly what the cap exists to prevent.
    expect(posts(stand.received)).toHaveLength(0);
    expect(stand.cards.size).toBe(0);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('--bulk JSON reaches the same intent', () => {
  it('a single JSON object is wrapped into a one-card batch', async () => {
    const stand = await startServer();
    const file = await fixture('one.json', JSON.stringify({ name: 'Solo', description: 'd' }));

    await run('--bulk', file, '--board', BOARD);

    expect(posts(stand.received).map((r) => r.body.name)).toEqual(['Solo']);
    expect(logSpy.mock.calls.flat().join('\n')).toContain('✓ Created 1 cards');
  });
});

describe('--dry-run goes through the same table, so it needs credentials', () => {
  it('previews every card and writes nothing', async () => {
    const stand = await startServer();
    const csv = await fixture('dry.csv', 'name\nFirst\nSecond\n');

    await run('--csv', csv, '--board', BOARD, '--dry-run');

    const printed = logSpy.mock.calls.flat().join('\n');
    expect(printed).toContain('[dry-run]');
    expect(printed).toContain('First');
    expect(printed).toContain('Second');
    expect(stand.received.filter((r) => r.method !== 'GET')).toHaveLength(0);
  });

  it('a dry run with no credentials exits non-zero instead of reading the file for free', async () => {
    // Deliberate: the preview is produced by the table, behind the scope lock, so
    // there is no file-only path where the cap and the lock could drift.
    const csv = await fixture('dry2.csv', 'name\nFirst\n');

    await expect(run('--csv', csv, '--board', BOARD, '--dry-run')).rejects.toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
