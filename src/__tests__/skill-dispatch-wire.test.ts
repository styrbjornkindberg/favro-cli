/**
 * The skill engine over the shared dispatch table, driven against a `node:http`
 * Favro stand-in — issue #51.
 *
 * The criterion under test is that the CLI and the skill engine cannot drift
 * apart on guardrails, so what matters here is that a skill's write step lands
 * on the wire through the SAME table a commander action uses: same scope lock,
 * same compensation log, same three outcomes. The table is the seam, so it is
 * what these tests drive — not a mocked `CardsAPI`, and not commander parsing.
 *
 * Every assertion is about what the wire RECEIVED or what the caller OBSERVED.
 * The stand-in keeps real mutable state, so "the run unwound" is checked by
 * reading the cards back, never by counting calls: Favro answers 200 for writes
 * it does not perform, and a mock cannot tell those apart.
 */
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import { registerIntent, RefusalError } from '../lib/dispatch';
import { TxCards } from '../lib/tx-cards';
import { runSkill, SkillRunOptions } from '../lib/skill-engine';
import { SkillDefinition } from '../lib/skill-store';

const ORG = 'org-1';
const BOARD = 'board-a';
const OTHER_BOARD = 'board-b';
const TODO = 'col-todo';
const DOING = 'col-doing';

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
  client: FavroHttpClient;
  received: Received[];
  cards: Map<string, StoredCard>;
}

/** Every server this file started, so a failed assertion cannot leak a listener. */
const running: http.Server[] = [];

const BOARDS = [
  {
    widgetCommonId: BOARD,
    name: 'Board A',
    collectionIds: ['coll-a'],
    columns: [
      { columnId: TODO, name: 'To Do', position: 0 },
      { columnId: DOING, name: 'Doing', position: 1 },
    ],
  },
  {
    widgetCommonId: OTHER_BOARD,
    name: 'Board B',
    collectionIds: ['coll-b'],
    columns: [{ columnId: 'col-b-1', name: 'Inbox', position: 0 }],
  },
];

/** A wire-level refusal a test injects, decided per request. */
type FailHook = (r: Received) => { status: number; message: string } | undefined;

function startServer(opts: { fail?: FailHook } = {}): Promise<Stand> {
  const received: Received[] = [];
  const cards = new Map<string, StoredCard>();
  let created = 0;

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

      const injected = opts.fail?.(r);
      if (injected) return send(injected.status, { message: injected.message });

      const single = pathOnly.match(/^\/cards\/([^/]+)$/);
      if (single) {
        const stored = cards.get(single[1]);
        if (r.method === 'GET') {
          return stored ? send(200, { ...stored }) : send(403, { message: 'Access denied' });
        }
        if (r.method === 'DELETE') {
          if (!stored) return send(404, { message: 'Access denied' });
          cards.delete(single[1]);
          res.writeHead(204); res.end(); return;
        }
      }

      if (pathOnly === '/cards') {
        if (r.method === 'POST') {
          created += 1;
          const id = `new-card-${created}`;
          cards.set(id, {
            cardId: id,
            cardCommonId: `ccid-${id}`,
            name: r.body?.name ?? 'made',
            widgetCommonId: r.body?.widgetCommonId ?? BOARD,
            columnId: r.body?.columnId ?? TODO,
            tags: [],
            assignments: [],
            createdAt: '2026-01-01',
          });
          return send(200, { ...cards.get(id) });
        }
        return send(200, { entities: [...cards.values()].map((c) => ({ ...c })) });
      }

      if (pathOnly.startsWith('/widgets')) {
        // A by-id widget GET answers the bare entity; only the list is
        // enveloped. `assertScope` reads `collectionIds` off the former.
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
      resolve({
        client: new FavroHttpClient({
          baseURL: `http://127.0.0.1:${port}/api/v1`,
          auth: { organizationId: ORG },
        }),
        received,
        cards,
      });
    });
  });
}

const writes = (received: Received[]) => received.filter((r) => r.method !== 'GET');
const posts = (received: Received[]) => received.filter((r) => r.method === 'POST' && r.path === '/cards');

function skill(...steps: SkillDefinition['steps']): SkillDefinition {
  return { name: 'wire-probe', description: '', steps };
}

function opts(stand: Stand, extra: Partial<SkillRunOptions> = {}): SkillRunOptions {
  return { client: stand.client, config: {}, yes: true, ...extra };
}

const originalConfigDir = process.env.FAVRO_CONFIG_DIR;
const originalTrackerDoc = process.env.FAVRO_TRACKER_DOC;
let tmpDir: string;

beforeAll(() => {
  // A step that fails after the run has already written, so the unwind has
  // something to undo. Registered here rather than named in the engine: the
  // engine looks the table up at call time and holds no list of its own.
  registerIntent({
    name: 'probe-skill-fail',
    summary: 'fails without writing anything',
    preview: () => ['fail'],
    board: async () => undefined,
    run: async () => { throw new Error('probe step failed'); },
  });
  // A DETERMINISTIC decline — the retry refuses identically. Registered as its
  // own probe because the real refusals (a reverse edge, a card off the tracker
  // board, a role outside the vocabulary) need wire state this stand-in does not
  // model; what the engine has to get right is the same either way.
  registerIntent({
    name: 'probe-refusal',
    summary: 'refuses without writing anything',
    preview: () => ['refuse'],
    board: async () => undefined,
    run: async () => { throw new RefusalError('probe refuses, and will refuse again'); },
  });
});

beforeEach(async () => {
  // The name cache is a real file — give each test its own, so a run never
  // reads or clobbers the developer's own ~/.favro cache.
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-skill-dispatch-test-'));
  process.env.FAVRO_CONFIG_DIR = tmpDir;
  process.env.FAVRO_TRACKER_DOC = path.join(tmpDir, 'no-tracker.md');
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise((done) => s.close(() => done(null)))));
  if (originalConfigDir === undefined) delete process.env.FAVRO_CONFIG_DIR;
  else process.env.FAVRO_CONFIG_DIR = originalConfigDir;
  if (originalTrackerDoc === undefined) delete process.env.FAVRO_TRACKER_DOC;
  else process.env.FAVRO_TRACKER_DOC = originalTrackerDoc;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('a skill write step goes through the shared table', () => {
  it('reaches the wire as the one create call the table makes', async () => {
    const stand = await startServer();

    const result = await runSkill(
      skill({ command: 'create', args: { name: 'Ship it', board: BOARD, status: 'Doing' } }),
      opts(stand),
    );

    expect(result.status).toBe('completed');
    expect(posts(stand.received)).toHaveLength(1);
    expect(posts(stand.received)[0].body.name).toBe('Ship it');
    expect(posts(stand.received)[0].body.columnId).toBe(DOING);
    expect([...stand.cards.values()].map((c) => c.name)).toEqual(['Ship it']);
  });

  it('calls an intent registered after the engine loaded — no closed list here', async () => {
    const stand = await startServer();
    // The registry grows ticket by ticket. The engine resolves the step name
    // against the table at call time, so this needs no engine change.
    registerIntent({
      name: 'probe-late-arrival',
      summary: 'registered long after the engine module loaded',
      preview: () => ['late'],
      board: async (a: any) => a.board,
      run: async (a: any, tx: TxCards) => ({ cardId: (await tx.create({ name: a.name, boardId: a.board })).cardId }),
    });

    const result = await runSkill(
      skill({ command: 'probe-late-arrival', args: { name: 'Late', board: BOARD } }),
      opts(stand),
    );

    expect(result.status).toBe('completed');
    expect([...stand.cards.values()].map((c) => c.name)).toEqual(['Late']);
  });

  it('a step naming nothing in the table refuses and writes nothing', async () => {
    const stand = await startServer();

    const result = await runSkill(skill({ command: 'claim-it-all' }), opts(stand));

    expect(result.status).toBe('failed');
    expect(result.steps[0].error).toContain('create');
    expect(writes(stand.received)).toHaveLength(0);
  });
});

describe('the scope lock guards a skill run exactly as it guards the CLI', () => {
  it('an out-of-scope board refuses the step, and no write is built', async () => {
    const stand = await startServer();

    const result = await runSkill(
      skill({ command: 'create', args: { name: 'x', board: OTHER_BOARD } }),
      opts(stand, { config: { scopeCollectionId: 'coll-a', scopeCollectionName: 'Collection A' } }),
    );

    expect(result.status).toBe('failed');
    expect(result.steps[0].error).toContain('Scope violation');
    expect(writes(stand.received)).toHaveLength(0);
  });

  it('--force is the lock\'s only escape hatch, and it lets the write through', async () => {
    const stand = await startServer();

    const result = await runSkill(
      skill({ command: 'create', args: { name: 'x', board: OTHER_BOARD } }),
      opts(stand, { config: { scopeCollectionId: 'coll-a' }, force: true }),
    );

    expect(result.status).toBe('completed');
    expect(posts(stand.received)).toHaveLength(1);
  });
});

describe('the run is ONE transaction — one log, threaded through every step', () => {
  it('a failure in step 2 undoes what step 1 wrote', async () => {
    const stand = await startServer();

    const result = await runSkill(
      skill(
        { command: 'create', args: { name: 'first', board: BOARD } },
        { command: 'probe-skill-fail' },
      ),
      opts(stand),
    );

    expect(result.status).toBe('failed');
    expect(result.rollback?.outcome).toBe('rolled-back');
    expect(result.rollback?.orphans).toEqual([]);
    // An ordinary in-process failure carries no wire classification, so the
    // rolled-back-is-retryable reading stands. The discriminator for #66.
    expect(result.rollback?.retryable).toBe(true);
    // What a caller can see afterwards: the card step 1 made is gone.
    expect(stand.cards.size).toBe(0);
    expect(stand.received.some((r) => r.method === 'DELETE' && r.path === '/cards/new-card-1')).toBe(true);
  });

  it('a scope refusal in step 2 also undoes step 1 — a refusal is not a free pass', async () => {
    const stand = await startServer();

    // The refusal throws before the table's own unwind, so this is the case the
    // run-level end-of-transaction unwind exists for.
    const result = await runSkill(
      skill(
        { command: 'create', args: { name: 'first', board: BOARD } },
        { command: 'create', args: { name: 'second', board: OTHER_BOARD } },
      ),
      opts(stand, { config: { scopeCollectionId: 'coll-a' } }),
    );

    expect(result.status).toBe('failed');
    expect(result.rollback?.outcome).toBe('rolled-back');
    expect(stand.cards.size).toBe(0);
  });

  it('continueOnError cannot outlive a rollback — the run stops once it is undone', async () => {
    const stand = await startServer();

    const result = await runSkill(
      skill(
        { command: 'create', args: { name: 'first', board: BOARD } },
        { command: 'probe-skill-fail', continueOnError: true },
        { command: 'create', args: { name: 'third', board: BOARD } },
      ),
      opts(stand),
    );

    expect(result.steps).toHaveLength(2);
    expect(stand.cards.size).toBe(0);
    expect(posts(stand.received)).toHaveLength(1);
  });

  it('a refusal in step 2 surfaces as the refusal, and step 1 is still undone', async () => {
    // Under a threaded log the table must NOT swallow the refusal into a
    // `rolled-back / retryable` result — the depth it compares against is the
    // one this invocation started at, not zero. The run still unwinds, because
    // the engine owns the log and knows when the run is over.
    const stand = await startServer();

    const result = await runSkill(
      skill(
        { command: 'create', args: { name: 'first', board: BOARD } },
        { command: 'probe-refusal' },
      ),
      opts(stand),
    );

    expect(result.status).toBe('failed');
    expect(result.steps[1].error).toBe('probe refuses, and will refuse again');
    expect(result.rollback?.outcome).toBe('rolled-back');
    // Undone, and still not worth repeating: the refusal that ended the run is
    // deterministic, so re-running the whole skill refuses at step 2 again (#66).
    // This is the END-OF-RUN unwind path — the engine's own, not the table's.
    expect(result.rollback?.retryable).toBe(false);
    // Step 1's card is gone, exactly once.
    expect(stand.cards.size).toBe(0);
    expect(stand.received.filter((r) => r.method === 'DELETE')).toHaveLength(1);
  });

  it('a deterministic WIRE refusal in step 2 undoes step 1 and is NOT retryable', async () => {
    // The other path into `rollback`: the table unwound this one itself and the
    // engine carries its verdict rather than re-deriving one. `403 "Invalid
    // column"` is a bad-input rejection, so the identical run is refused
    // identically — an agent told "safe to retry" loops on it.
    const stand = await startServer({
      fail: (r) =>
        r.method === 'POST' && r.path === '/cards' && r.body?.name === 'second'
          ? { status: 403, message: 'Invalid column' }
          : undefined,
    });

    const result = await runSkill(
      skill(
        { command: 'create', args: { name: 'first', board: BOARD } },
        { command: 'create', args: { name: 'second', board: BOARD } },
      ),
      opts(stand),
    );

    expect(result.status).toBe('failed');
    expect(result.rollback?.outcome).toBe('rolled-back');
    expect(result.rollback?.retryable).toBe(false);
    // Read back: step 1's card really is gone from the wire.
    expect(stand.cards.size).toBe(0);
    expect(stand.received.filter((r) => r.method === 'DELETE')).toHaveLength(1);
  });

  it('continueOnError cannot span a pending write — the run stops and unwinds', async () => {
    // The incoherence this closes: with a write already pending, continuing
    // would let step 3 WRITE and then have the end-of-run unwind revert it —
    // visible to every other Favro client in between, for nothing.
    const stand = await startServer();

    const result = await runSkill(
      skill(
        { command: 'create', args: { name: 'first', board: BOARD } },
        { command: 'create', args: { name: 'second', board: OTHER_BOARD }, continueOnError: true },
        { command: 'create', args: { name: 'third', board: BOARD } },
      ),
      opts(stand, { config: { scopeCollectionId: 'coll-a' } }),
    );

    // The scope refusal throws out of the table, so this is NOT the
    // StepDispatchFailure branch — it is the `continueOnError` one.
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1].error).toContain('Scope violation');
    expect(posts(stand.received)).toHaveLength(1);
    expect(stand.cards.size).toBe(0);
  });

  it('continueOnError still spans a failure that wrote nothing at all', async () => {
    // Nothing is pending, so there is no transaction to be incoherent about: the
    // read step failed on its own arguments and the run carries on.
    const stand = await startServer();

    const result = await runSkill(
      skill(
        { command: 'query', args: { board: BOARD }, continueOnError: true },
        { command: 'create', args: { name: 'second', board: BOARD } },
      ),
      opts(stand),
    );

    expect(result.steps.map((s) => s.status)).toEqual(['failed', 'success']);
    expect(result.status).toBe('partial');
    // The write stands: nothing unwound it, because nothing had to.
    expect([...stand.cards.values()].map((c) => c.name)).toEqual(['second']);
    expect(stand.received.filter((r) => r.method === 'DELETE')).toHaveLength(0);
  });

  it('a clean run leaves nothing to unwind', async () => {
    const stand = await startServer();

    const result = await runSkill(
      skill(
        { command: 'create', args: { name: 'first', board: BOARD } },
        { command: 'create', args: { name: 'second', board: BOARD } },
      ),
      opts(stand),
    );

    expect(result.status).toBe('completed');
    expect(result.rollback).toBeUndefined();
    expect(stand.cards.size).toBe(2);
    expect(writes(stand.received).filter((r) => r.method === 'DELETE')).toHaveLength(0);
  });
});

describe('--dry-run is a preview of the run, never its safety', () => {
  it('previews every step and makes no write at all', async () => {
    const stand = await startServer();

    const result = await runSkill(
      skill(
        { command: 'create', args: { name: 'first', board: BOARD } },
        { command: 'create', args: { name: 'second', board: BOARD } },
      ),
      opts(stand, { dryRun: true }),
    );

    expect(result.status).toBe('completed');
    expect(result.steps.map((s) => s.output)).toEqual([
      `[dry-run] create card "first" on board ${BOARD}`,
      `[dry-run] create card "second" on board ${BOARD}`,
    ]);
    expect(writes(stand.received)).toHaveLength(0);
  });

  it('still refuses an out-of-scope board — the lock runs before the preview', async () => {
    const stand = await startServer();

    const result = await runSkill(
      skill({ command: 'create', args: { name: 'x', board: OTHER_BOARD } }),
      opts(stand, { dryRun: true, config: { scopeCollectionId: 'coll-a' } }),
    );

    expect(result.status).toBe('failed');
    expect(result.steps[0].error).toContain('Scope violation');
  });
});
