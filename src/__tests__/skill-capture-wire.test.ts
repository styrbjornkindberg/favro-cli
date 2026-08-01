/**
 * `as:` capture and `{{name.field}}` chaining, driven against a `node:http`
 * Favro stand-in — issue #56.
 *
 * A chain is only real if the value step 2 sends to the wire is the value step 1
 * got BACK from the wire. So nothing here asserts on an internal variable map:
 * every test reads the request bodies the stand-in received, or the cards it
 * holds afterwards. A mocked `CardsAPI` could not tell a chained id from a
 * hard-coded one — the wire can.
 *
 * The engine still owns no rollback logic: the run's one `CompensationLog` is
 * threaded through the table, and the tests below check a chain that fails
 * mid-way unwinds as a whole.
 */
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import { registerIntent, RefusalError } from '../lib/dispatch';
import { TxCards } from '../lib/tx-cards';
import { interpolate, runSkill, SkillRunOptions } from '../lib/skill-engine';
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

function startServer(): Promise<Stand> {
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
        // A by-id widget GET answers the bare entity; only the list is enveloped.
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

function skill(...steps: SkillDefinition['steps']): SkillDefinition {
  return { name: 'capture-probe', description: '', steps };
}

function opts(stand: Stand, extra: Partial<SkillRunOptions> = {}): SkillRunOptions {
  return { client: stand.client, config: {}, yes: true, ...extra };
}

const originalConfigDir = process.env.FAVRO_CONFIG_DIR;
const originalTrackerDoc = process.env.FAVRO_TRACKER_DOC;
let tmpDir: string;

beforeAll(() => {
  // Echoes one argument straight back as the step's structured result, so a
  // chain test can assert on exactly what the previous step captured.
  registerIntent<{ echo: string }, { echoed: string }>({
    name: 'probe-capture-echo',
    summary: 'returns its argument, writing nothing',
    preview: (a) => [`echo ${a.echo}`],
    board: async () => undefined,
    run: async (a) => ({ echoed: a.echo }),
  });
  // A deterministic decline — the same call refuses again. Used to check a chain
  // that refuses mid-way still unwinds the writes before it, and still reports
  // the refusal rather than a retryable rollback.
  registerIntent({
    name: 'probe-capture-refusal',
    summary: 'refuses without writing anything',
    preview: () => ['refuse'],
    board: async () => undefined,
    run: async () => { throw new RefusalError('probe refuses, and will refuse again'); },
  });
  // Renames a card by id, so a chained `{{made.cardId}}` is observable as a
  // write landing on the exact card the earlier step created.
  registerIntent<{ card: string; name: string }, { cardId: string }>({
    name: 'probe-capture-rename',
    summary: 'renames a card by id',
    preview: (a) => [`rename ${a.card}`],
    board: async () => undefined,
    run: async (a, tx: TxCards) => {
      const card = await tx.getCard(a.card);
      return { cardId: card.cardId };
    },
  });
});

beforeEach(async () => {
  // The name cache is a real file — give each test its own.
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-skill-capture-test-'));
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

describe('`as:` captures a step result as structured data', () => {
  it('a later step sends the captured id to the wire, not a literal', async () => {
    const stand = await startServer();

    const result = await runSkill(
      skill(
        { command: 'create', args: { name: 'first', board: BOARD }, as: 'made' },
        { command: 'probe-capture-rename', args: { card: '{{made.cardId}}', name: 'x' } },
      ),
      opts(stand),
    );

    expect(result.status).toBe('completed');
    // The proof is on the wire: step 2 read back the exact card step 1 created.
    expect(stand.received.some((r) => r.method === 'GET' && r.path === '/cards/new-card-1')).toBe(true);
  });

  it('captures a field the wire supplied, not one the skill spelled out', async () => {
    const stand = await startServer();

    const result = await runSkill(
      skill(
        { command: 'create', args: { name: 'first', board: BOARD }, as: 'made' },
        { command: 'probe-capture-echo', args: { echo: '{{made.cardCommonId}}' } },
      ),
      opts(stand),
    );

    expect(result.status).toBe('completed');
    // `ccid-new-card-1` exists nowhere in the skill — only the stand-in minted it.
    expect(JSON.parse(result.steps[1].output!)).toEqual({ echoed: 'ccid-new-card-1' });
  });

  it('a step without `as:` captures nothing, and the reference stays literal', async () => {
    const stand = await startServer();

    const result = await runSkill(
      skill(
        { command: 'create', args: { name: 'first', board: BOARD } },
        { command: 'probe-capture-echo', args: { echo: '{{made.cardId}}' } },
      ),
      opts(stand),
    );

    expect(JSON.parse(result.steps[1].output!)).toEqual({ echoed: '{{made.cardId}}' });
  });

  it('two captures stay separate — a chain can reach back past the last step', async () => {
    const stand = await startServer();

    const result = await runSkill(
      skill(
        { command: 'create', args: { name: 'first', board: BOARD }, as: 'a' },
        { command: 'create', args: { name: 'second', board: BOARD }, as: 'b' },
        { command: 'probe-capture-echo', args: { echo: '{{a.name}}/{{b.name}}' } },
      ),
      opts(stand),
    );

    expect(JSON.parse(result.steps[2].output!)).toEqual({ echoed: 'first/second' });
  });

  it('a capture only lands once the step succeeded', async () => {
    const stand = await startServer();

    const result = await runSkill(
      skill(
        { command: 'query', args: { board: BOARD }, continueOnError: true, as: 'q' },
        { command: 'probe-capture-echo', args: { echo: '{{q.matches}}' } },
      ),
      opts(stand),
    );

    // Step 1 failed on its own arguments (no `query`), so `q` was never set and
    // its reference is a literal rather than a stale or half-built object.
    expect(result.steps[0].status).toBe('failed');
    expect(JSON.parse(result.steps[1].output!)).toEqual({ echoed: '{{q.matches}}' });
  });
});

describe('a chain reference that cannot resolve fails loudly', () => {
  it('a missing field on a real capture stops the run instead of sending the literal', async () => {
    const stand = await startServer();

    const result = await runSkill(
      skill(
        { command: 'create', args: { name: 'first', board: BOARD }, as: 'made' },
        { command: 'probe-capture-echo', args: { echo: '{{made.nope}}' } },
      ),
      opts(stand),
    );

    expect(result.status).toBe('failed');
    expect(result.steps[1].error).toContain('carries no nope');
    // And the run is one transaction, so step 1's card is gone.
    expect(stand.cards.size).toBe(0);
    expect(result.rollback?.outcome).toBe('rolled-back');
  });

  it('a capture referenced whole, not by field, refuses rather than blobbing JSON', async () => {
    const stand = await startServer();

    const result = await runSkill(
      skill(
        { command: 'create', args: { name: 'first', board: BOARD }, as: 'made' },
        { command: 'probe-capture-echo', args: { echo: '{{made.tags}}' } },
      ),
      opts(stand),
    );

    expect(result.steps[1].error).toContain('resolves to an array');
    expect(stand.cards.size).toBe(0);
  });

  it('a capture name no reference could ever match is refused before any write', async () => {
    const stand = await startServer();

    await expect(
      runSkill(
        skill({ command: 'create', args: { name: 'first', board: BOARD }, as: 'my-cap' }),
        opts(stand),
      ),
    ).rejects.toThrow('Invalid capture name "my-cap"');

    expect(writes(stand.received)).toHaveLength(0);
  });
});

describe('chaining does not weaken the run-is-one-transaction contract', () => {
  it('a refusal after two chained writes reports the refusal and undoes both', async () => {
    const stand = await startServer();

    const result = await runSkill(
      skill(
        { command: 'create', args: { name: 'first', board: BOARD }, as: 'a' },
        { command: 'create', args: { name: 'second', board: BOARD }, as: 'b' },
        { command: 'probe-capture-refusal', args: { card: '{{b.cardId}}' } },
      ),
      opts(stand),
    );

    // What this proves is the OBSERVABLE end state of a refusal on step 3 of a
    // chain: the refusal's own message survives, the run is `failed`, and both
    // earlier creates are gone from the wire. It does NOT distinguish the
    // refusal-throws path from a depth-compared-against-a-constant mutation —
    // at skill level both are identical (same message, same `rolled-back`, same
    // two DELETEs; the only differing field, `DispatchResult.retryable`, is not
    // carried by `SkillRunResult`). The guard on depth-at-entry vs a constant
    // lives in `dispatch-tx-wire.test.ts` — do not read this test as covering it.
    expect(result.steps[2].error).toBe('probe refuses, and will refuse again');
    expect(result.status).toBe('failed');
    expect(result.rollback?.outcome).toBe('rolled-back');
    expect(stand.cards.size).toBe(0);
    expect(stand.received.filter((r) => r.method === 'DELETE')).toHaveLength(2);
  });

  it('a throw from the confirm block still unwinds the writes before it', async () => {
    const stand = await startServer();

    // The reason `confirm` and `onBeforeStep` sit INSIDE the per-step try: the
    // confirm block interpolates the args to build its prompt, and interpolation
    // can throw. Outside the try that throw escaped `runSkill` entirely, so the
    // end-of-run unwind never ran and step 1's card stayed behind.
    const result = await runSkill(
      skill(
        { command: 'create', args: { name: 'first', board: BOARD }, as: 'made' },
        { command: 'probe-capture-echo', args: { echo: '{{made.nope}}' }, confirm: true },
      ),
      opts(stand),
    );

    expect(result.steps[1].error).toContain('carries no nope');
    expect(result.status).toBe('failed');
    expect(result.rollback?.outcome).toBe('rolled-back');
    expect(stand.cards.size).toBe(0);
    expect(stand.received.filter((r) => r.method === 'DELETE')).toHaveLength(1);
  });

  it('a scope refusal on a chained board undoes the chain', async () => {
    const stand = await startServer();

    const result = await runSkill(
      skill(
        { command: 'probe-capture-echo', args: { echo: OTHER_BOARD }, as: 'pick' },
        { command: 'create', args: { name: 'first', board: BOARD } },
        { command: 'create', args: { name: 'second', board: '{{pick.echoed}}' } },
      ),
      opts(stand, { config: { scopeCollectionId: 'coll-a' } }),
    );

    // The chained value reached the scope lock as a real board id.
    expect(result.steps[2].error).toContain('Scope violation');
    expect(stand.cards.size).toBe(0);
  });
});

describe('--dry-run previews a chain without inventing what it never fetched', () => {
  it('an unresolved chain reference previews as the literal, and nothing is written', async () => {
    const stand = await startServer();

    const result = await runSkill(
      skill(
        { command: 'create', args: { name: 'first', board: BOARD }, as: 'made' },
        { command: 'create', args: { name: 'child', board: BOARD, parent: '{{made.cardId}}' } },
      ),
      opts(stand, { dryRun: true }),
    );

    expect(result.status).toBe('completed');
    expect(result.steps[1].output).toContain('{{made.cardId}}');
    expect(writes(stand.received)).toHaveLength(0);
  });
});

describe('the deleted `audit` step stays deleted', () => {
  it('an `audit` step is an unknown command, and no code path revives it', async () => {
    const stand = await startServer();

    const result = await runSkill(skill({ command: 'audit', args: { board: BOARD } }), opts(stand));

    expect(result.status).toBe('failed');
    expect(result.steps[0].error).toContain('Unknown skill command: "audit"');
    expect(writes(stand.received)).toHaveLength(0);
  });
});

describe('interpolate keeps variables and captures apart', () => {
  it('a flat variable key holding a dot still wins over a capture walk', () => {
    expect(interpolate('{{scope.board}}', { 'scope.board': 'flat' }, { scope: { board: 'walked' } }))
      .toBe('flat');
  });

  it('an undotted name is a variable, never a capture', () => {
    expect(interpolate('{{made}}', {}, { made: { cardId: 'c1' } })).toBe('{{made}}');
  });

  it('a prototype member name is an unknown head, and stays literal', () => {
    // `name in captures` walks `Object.prototype`, so these dozen names would be
    // read as chain references and THROW, where every other unknown head is left
    // standing. Same rule for all of them: unknown head, literal.
    expect(interpolate('{{constructor.name}}', {}, {})).toBe('{{constructor.name}}');
    expect(interpolate('{{toString.x}}', {}, { made: { cardId: 'c1' } })).toBe('{{toString.x}}');
    expect(interpolate('{{unrelated.x}}', {}, {})).toBe('{{unrelated.x}}');
  });
});
