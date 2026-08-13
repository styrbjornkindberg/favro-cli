/**
 * `cards link` / `cards unlink` / `cards claim` / `cards resolve` / `cards retag`
 * driven through `buildProgram()` against a `node:http` Favro stand-in — the CLI
 * half of issue #63.
 *
 * What is covered here is that these commands route through the SHARED dispatch
 * table rather than calling `CardsAPI` beside it. That is not a wiring detail:
 * the direct path had no pre-read, so a reverse-edge write reached Favro and
 * came back as an opaque `403 Dependency already exists`, and it had no
 * compensation log, so a two-step failure left the first step standing.
 *
 * So the assertions are about what the wire RECEIVED and what the caller
 * OBSERVED. A mocked `CardsAPI` could not tell a refusal that stopped before the
 * write from one that wrote and got a 403 — the wire can.
 */
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import type { TrackerMapping } from '../lib/tracker-config';
import { tempConfigDir } from '../test-support/config-dir';

// The only seam: the CLI builds its own client from real credentials, and this
// points that client at the stand-in. Everything below the factory — the
// dispatch table, the compensation log, `CardsAPI`, axios — is real.
let injected: FavroHttpClient | undefined;
jest.mock('../lib/client-factory', () => ({
  __esModule: true,
  createFavroClient: jest.fn(async () => {
    if (!injected) throw new Error('API key not configured. Run `favro auth login`.');
    return injected;
  }),
  default: jest.fn(async () => injected),
}));

// Set before the CLI is loaded. NOT because `config.ts` freezes anything —
// #65 is the issue that made `configDir()` resolve per call, and `config.ts:43`
// says so. The reason is the tree being required: a module that reads the
// config during its own import would read it too early for a `beforeEach` to
// steer, and the scope lock would come from the developer's own
// `~/.favro/config.json`.
tempConfigDir('favro-cli-intents-config-');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildProgram } = require('../cli') as typeof import('../cli');
// `tracker-config` imports `config`, so it must be loaded AFTER the line above
// sets FAVRO_CONFIG_DIR — a value import here would be hoisted above it and
// freeze the config dir to the developer's real `~/.favro` (issue #65).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderTrackerBlock } = require('../lib/tracker-config') as typeof import('../lib/tracker-config');

const ORG = 'org-1';
const BOARD = 'board-a';
const TODO = 'col-todo';
const DOING = 'col-doing';
const DONE = 'col-done';
const ALICE = 'aaaaaaaaaaaaaaaaa';
const CARD = '00000000000000000000cc01';
const FAR = '00000000000000000000cc02';
/** A card no correct run ever touches — the bait for a reintroduced graph walk. */
const THIRD = '00000000000000000000cc03';

const BOARDS = [
  {
    widgetCommonId: BOARD,
    name: 'Board A',
    collectionIds: ['coll-a'],
    columns: [
      { columnId: TODO, name: 'To Do', position: 0 },
      { columnId: DOING, name: 'Doing', position: 1 },
      { columnId: DONE, name: 'Done', position: 2 },
    ],
  },
];

const TAGS = [
  { tagId: 'tag-bug', name: 'bug' },
  { tagId: 'tag-enhancement', name: 'enhancement' },
  { tagId: 'tag-needs-triage', name: 'needs-triage' },
  { tagId: 'tag-ready-for-agent', name: 'ready-for-agent' },
  // A workspace tag that is NOT a triage role, which is the shape #164 is about:
  // `retag` refuses it and used to justify the refusal by calling the name
  // unknown. Modelled here so the refusal can be tested against a tag that
  // resolves — the live one does, to `ZLAszhmCsDpuNGG66`.
  { tagId: 'tag-wayfinder-map', name: 'wayfinder:map' },
];

interface Received { method: string; url: string; path: string; body?: any }
interface StoredCard {
  cardId: string;
  cardCommonId: string;
  name: string;
  widgetCommonId?: string;
  columnId?: string;
  tags: string[];
  assignments: Array<{ userId: string }>;
  createdAt: string;
}
interface Edge { near: string; far: string; isBefore: boolean }
interface Stand { received: Received[]; cards: Map<string, StoredCard>; edges: Edge[] }

/** Every server this file started, so a failed assertion cannot leak a listener. */
const running: http.Server[] = [];

const card = (overrides: Partial<StoredCard> & { cardId: string }): StoredCard => ({
  cardCommonId: `ccid-${overrides.cardId}`,
  name: 'A card',
  widgetCommonId: BOARD,
  columnId: TODO,
  tags: [],
  assignments: [],
  createdAt: '2026-01-01',
  ...overrides,
});

function startServer(seed: { edges?: Edge[]; cards?: StoredCard[] } = {}): Promise<Stand> {
  const received: Received[] = [];
  const cards = new Map<string, StoredCard>(
    (seed.cards ?? [card({ cardId: CARD }), card({ cardId: FAR, name: 'Far card' })]).map((c) => [c.cardId, c]),
  );
  const edges: Edge[] = [...(seed.edges ?? [])];

  /** Both views of the edge set for one card, exactly as Favro mirrors them. */
  const depsOf = (id: string) => [
    ...edges.filter((e) => e.near === id).map((e) => ({ cardId: e.far, isBefore: e.isBefore })),
    ...edges.filter((e) => e.far === id).map((e) => ({ cardId: e.near, isBefore: !e.isBefore })),
  ];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = req.url ?? '';
      const pathOnly = url.split('?')[0].replace('/api/v1', '');
      const r: Received = { method: req.method ?? '', url, path: pathOnly, body: raw ? JSON.parse(raw) : undefined };
      received.push(r);
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      const dep = pathOnly.match(/^\/cards\/([^/]+)\/dependencies(?:\/([^/]+))?$/);
      if (dep) {
        const [, near, far] = dep;
        if (r.method === 'GET') return send(200, { dependencies: depsOf(near) });
        if (r.method === 'POST') {
          for (const e of r.body?.dependencies ?? []) {
            // Direction is not part of edge identity: a duplicate, a flipped
            // write and both from the mirror end all answer this same 403.
            const exists = edges.some(
              (x) => (x.near === near && x.far === e.cardId) || (x.near === e.cardId && x.far === near),
            );
            if (exists) return send(403, { message: 'Dependency already exists' });
            edges.push({ near, far: e.cardId, isBefore: e.isBefore === true });
          }
          return send(200, { dependencies: depsOf(near) });
        }
        if (r.method === 'DELETE') {
          const before = edges.length;
          for (let i = edges.length - 1; i >= 0; i -= 1) {
            const e = edges[i];
            if ((e.near === near && e.far === far) || (e.near === far && e.far === near)) edges.splice(i, 1);
          }
          if (edges.length === before) return send(404, { message: 'Dependency not found' });
          res.writeHead(204); res.end(); return;
        }
      }

      const single = pathOnly.match(/^\/cards\/([^/]+)$/);
      if (single) {
        const id = single[1];
        const stored = cards.get(id);
        if (r.method === 'GET') return stored ? send(200, { ...stored }) : send(403, { message: 'Access denied' });
        if (r.method === 'PUT') {
          if (!stored) return send(403, { message: 'Access denied' });
          const b = r.body ?? {};
          const next: StoredCard = { ...stored, tags: [...stored.tags], assignments: [...stored.assignments] };
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
        return send(200, { entities: (found?.columns ?? []).map((c) => ({ ...c, widgetCommonId: board })) });
      }
      if (pathOnly.startsWith('/widgets')) {
        // A by-id widget GET answers the BARE entity; only the list answers an
        // envelope. `assertScope` reads `collectionIds` off the former.
        const byId = pathOnly.slice('/widgets'.length).replace(/^\//, '');
        if (byId) {
          const found = BOARDS.find((w) => w.widgetCommonId === byId);
          return found ? send(200, found) : send(404, { message: 'Widget not found' });
        }
        return send(200, { entities: BOARDS });
      }
      if (pathOnly.startsWith('/tags')) return send(200, { entities: TAGS });
      if (pathOnly.startsWith('/users')) {
        return send(200, { entities: [{ userId: ALICE, name: 'Alice Ahlberg', email: 'alice@example.com' }] });
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
      resolve({ received, cards, edges });
    });
  });
}

const originalTrackerDoc = process.env.FAVRO_TRACKER_DOC;
let tmpDir: string;
let exitSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;
let errSpy: jest.SpyInstance;

/** Designate a tracker the way `tracker init` does — a pasted block in a doc. */
async function useTracker(): Promise<TrackerMapping> {
  const mapping: TrackerMapping = {
    collectionId: 'coll-a',
    boardId: BOARD,
    columns: { active: DOING, done: DONE },
  };
  const doc = path.join(tmpDir, 'issue-tracker.md');
  await fs.writeFile(doc, renderTrackerBlock(mapping));
  process.env.FAVRO_TRACKER_DOC = doc;
  return mapping;
}

/** The command as a user reaches it, with `process.exit` turned into a throw. */
const run = (...argv: string[]) => buildProgram().parseAsync(['node', 'favro', 'cards', ...argv]);

/**
 * The human path. #119 moved `cards link`/`unlink`/`move` onto `run()`, so the
 * `✓ …` lines live on their `human` formatters and JSON is what an unflagged
 * invocation gets (ADR-0002).
 */
const runHuman = (...argv: string[]) =>
  buildProgram().parseAsync(['node', 'favro', '--human', 'cards', ...argv]);

/** `run()` sets `process.exitCode` and returns; it never rejects. */
const exitCodeAfter = async (...argv: string[]): Promise<number | undefined> => {
  process.exitCode = undefined;
  await run(...argv);
  const code = process.exitCode;
  process.exitCode = undefined;
  return code;
};

const said = () => [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n');
const writes = (received: Received[]) => received.filter((r) => r.method !== 'GET');
// Reads matter too: the pre-read's BOUNDEDNESS is the contract that replaced the
// deleted cycle walk, and a `writes()`-only suite cannot see a walk come back.
const reads = (received: Received[]) => received.filter((r) => r.method === 'GET');
/** The one `--json` blob among the lines a command printed. */
const jsonSaid = () => {
  const blob = logSpy.mock.calls.flat().map(String).find((l) => l.trimStart().startsWith('{'));
  if (blob === undefined) throw new Error(`No JSON was printed. Output was:\n${said()}`);
  return blob;
};

beforeEach(async () => {
  jest.clearAllMocks();
  injected = undefined;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-cli-intents-'));
  // Nothing designated unless a test asks for it, so no read reaches the
  // developer's real `docs/agents/issue-tracker.md`.
  process.env.FAVRO_TRACKER_DOC = path.join(tmpDir, 'no-tracker.md');
  exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit must not be called under run()');
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
  if (originalTrackerDoc === undefined) delete process.env.FAVRO_TRACKER_DOC;
  else process.env.FAVRO_TRACKER_DOC = originalTrackerDoc;
});

// ─────────────────────────────────────────────────────────────────────────────

describe('`cards link` writes the edge through the intent, not beside it', () => {
  it('--type depends-on records the target as the blocker', async () => {
    const stand = await startServer();

    await run('link', CARD, FAR, '--type', 'depends-on', '-y');

    // `depends-on` means the target comes before this card, so the edge is
    // written from this card with isBefore true.
    expect(writes(stand.received).map((r) => [r.method, r.path])).toEqual([
      ['POST', `/cards/${CARD}/dependencies`],
    ]);
    expect(writes(stand.received)[0].body).toEqual({ dependencies: [{ cardId: FAR, isBefore: true }] });
    expect(stand.edges).toEqual([{ near: CARD, far: FAR, isBefore: true }]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('--type blocks writes the same edge from the other end', async () => {
    const stand = await startServer();

    await run('link', CARD, FAR, '--type', 'blocks', '-y');

    // One intent, two spellings: "A blocks B" is the edge stored on B.
    expect(writes(stand.received)[0].path).toBe(`/cards/${FAR}/dependencies`);
    expect(writes(stand.received)[0].body).toEqual({ dependencies: [{ cardId: CARD, isBefore: true }] });
    expect(stand.edges).toEqual([{ near: FAR, far: CARD, isBefore: true }]);
  });

  it('refuses a reverse-edge write WITHOUT sending it, and names the live direction', async () => {
    // The whole point of #63: the old direct path sent this and surfaced
    // Favro's opaque `403 Dependency already exists`, which is not success and
    // does not say which direction is actually stored.
    const stand = await startServer({ edges: [{ near: CARD, far: FAR, isBefore: false }] });

    expect(await exitCodeAfter('link', CARD, FAR, '--type', 'depends-on', '-y')).toBe(1);

    expect(writes(stand.received)).toEqual([]);
    expect(stand.edges).toEqual([{ near: CARD, far: FAR, isBefore: false }]);
    expect(said()).toContain('REVERSE edge');
    expect(said()).toContain('delete-then-add');
  });

  it('an edge already there is reported, not rewritten', async () => {
    const stand = await startServer({ edges: [{ near: CARD, far: FAR, isBefore: true }] });

    await runHuman('link', CARD, FAR, '--type', 'depends-on', '-y');

    expect(writes(stand.received)).toEqual([]);
    expect(said()).toContain('Already linked');
    expect(process.exitCode).toBeUndefined();
  });

  it('the pre-read is ONE bounded GET on ONE card — it does not walk the graph', async () => {
    // The standing guard for #53's `wouldCreateCycle` deletion. That BFS was
    // unbounded (derived N), followed `depends-on` only and swallowed every read
    // failure; what replaced it is a single mirrored read that settles BOTH
    // directions. So the assertion is a count, not a shape: any reintroduced
    // walk reads a second card's edge set and this goes red.
    //
    // The seed gives the far card an onward edge, so a walk would have somewhere
    // to go.
    const stand = await startServer({
      cards: [card({ cardId: CARD }), card({ cardId: FAR }), card({ cardId: THIRD })],
      edges: [{ near: FAR, far: THIRD, isBefore: true }],
    });

    await run('link', CARD, FAR, '--type', 'depends-on', '-y');

    const edgeReads = reads(stand.received).filter((r) => r.path.endsWith('/dependencies'));
    expect(edgeReads.map((r) => r.path)).toEqual([`/cards/${CARD}/dependencies`]);
    // And nothing read the third card at all — not its edges, not the card.
    expect(reads(stand.received).filter((r) => r.path.includes(THIRD))).toEqual([]);
  });

  it('reports the created edge with ✓ Linked, in the refs the caller typed', async () => {
    const stand = await startServer();

    await runHuman('link', CARD, FAR, '--type', 'depends-on', '-y');

    expect(said()).toContain(`✓ Linked card ${CARD} → ${FAR}`);
    expect(stand.edges).toHaveLength(1);
  });

  it('the machine default prints {created, card, blockedBy} — our contract, not Favro\'s link object', async () => {
    // BREAKING vs the pre-#63 shape, deliberately: the machine output used to be
    // whatever `api.linkCard` handed back, which put the wire's own entity into
    // our output contract. It is now the intent's answer. The leaf `--json`
    // itself left with #119 — JSON is the default and `--human` is the way out.
    await startServer();

    await run('link', CARD, FAR, '--type', 'depends-on', '-y');

    expect(JSON.parse(jsonSaid())).toEqual({ created: true, card: CARD, blockedBy: FAR });
    // And NOTHING ahead of it: a live smoke run measured the pre-#119 shape
    // putting `✓ Linked …` on stdout in front of the JSON, so the documented
    // default did not parse.
    expect(said()).not.toContain('✓');
  });

  it('a card that does not exist is refused by the pre-read, before any write', async () => {
    // What is left of the deleted 404 tests. The commands' own `404` arm is now
    // largely unreachable — a 403/404 from the POST is classified inside
    // `dispatch` and comes back as a DispatchResult — so the only route to "no
    // such card" is the pre-read, and 403 is Favro's not-found for cards.
    // Pinning the behaviour that is now correct: nothing is sent, exit is 1.
    const stand = await startServer({ cards: [card({ cardId: FAR })] });

    expect(await exitCodeAfter('link', CARD, FAR, '--type', 'depends-on', '-y')).toBe(1);

    expect(writes(stand.received)).toEqual([]);
    expect(stand.edges).toEqual([]);
    expect(said()).toContain(CARD);
  });

  it('--dry-run previews the write without sending it', async () => {
    const stand = await startServer();

    await run('link', CARD, FAR, '--type', 'depends-on', '-y', '--dry-run');

    expect(writes(stand.received)).toEqual([]);
    expect(stand.edges).toEqual([]);
    expect(said()).toContain('[dry-run]');
  });
});

describe('`cards unlink` goes through remove-blocking-edge', () => {
  it('removes whichever way round the edge points', async () => {
    const stand = await startServer({ edges: [{ near: FAR, far: CARD, isBefore: false }] });

    await runHuman('unlink', CARD, FAR, '-y');

    expect(writes(stand.received).map((r) => r.method)).toEqual(['DELETE']);
    expect(stand.edges).toEqual([]);
    expect(said()).toContain(`✓ Unlinked card ${CARD} from ${FAR}`);
  });

  it('the machine default prints {removed, isBefore}', async () => {
    // Same deliberate break as `link`'s: the intent's answer, not the raw
    // wire response the direct `api` path used to echo.
    await startServer({ edges: [{ near: FAR, far: CARD, isBefore: false }] });

    await run('unlink', CARD, FAR, '-y');

    expect(JSON.parse(jsonSaid())).toEqual(expect.objectContaining({ removed: true }));
  });

  it('no edge to remove is reported, not sent as a DELETE that 404s', async () => {
    // The direct path DELETEd unconditionally and turned Favro's 404 into
    // "Card or link not found" — indistinguishable from a bad card id.
    const stand = await startServer();

    await runHuman('unlink', CARD, FAR, '-y');

    expect(writes(stand.received)).toEqual([]);
    expect(said()).toContain('No edge between');
    expect(process.exitCode).toBeUndefined();
  });
});

describe('`cards claim` reaches the claim intent, not a hand-rolled update', () => {
  it('adds the assignee and moves the card to the mapped active column', async () => {
    await useTracker();
    const stand = await startServer();

    await run('claim', CARD, '--assignee', 'alice@example.com');

    // ADDS the assignee — a whole-array write would unassign everyone else,
    // and `assignees` is a silent no-op on this wire either way.
    const bodies = writes(stand.received).map((r) => r.body);
    expect(bodies).toContainEqual(expect.objectContaining({ addAssignmentIds: [ALICE] }));
    expect(stand.cards.get(CARD)!.assignments).toEqual([{ userId: ALICE }]);
    expect(stand.cards.get(CARD)!.columnId).toBe(DOING);
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses a card that is not on the tracker board, writing nothing', async () => {
    await useTracker();
    // A fork: an assignment entity with no board and no column. It cannot be
    // moved to a column it does not have, which is why the rule is load-bearing.
    const fork = card({ cardId: CARD, widgetCommonId: undefined, columnId: undefined });
    const stand = await startServer({ cards: [fork] });

    expect(await exitCodeAfter('claim', CARD, '--assignee', 'alice@example.com')).toBe(1);

    expect(writes(stand.received)).toEqual([]);
    expect(said()).toContain('not on the tracker board');
  });
});

describe('`cards resolve` moves to the mapped done column', () => {
  it('writes the done columnId and nothing else', async () => {
    await useTracker();
    const stand = await startServer();

    await run('resolve', CARD);

    expect(writes(stand.received).map((r) => r.method)).toEqual(['PUT']);
    expect(writes(stand.received)[0].body).toEqual(expect.objectContaining({ columnId: DONE }));
    expect(stand.cards.get(CARD)!.columnId).toBe(DONE);
  });
});

describe('the three new commands confirm before writing, like every sibling write', () => {
  // `confirmAction` short-circuits under NODE_ENV=test, so the tests above never
  // meet the prompt. That is exactly why it needs pinning HERE: `claim`,
  // `resolve` and `retag` shipped writing straight through, with no `-y` to pass
  // because there was no prompt to skip, while `link`, `unlink`, `move` and
  // `update` all prompt. Silent asymmetry on the three commands the help topic
  // teaches first.
  const safety = require('../lib/safety') as typeof import('../lib/safety');

  it.each([
    ['claim', [CARD]],
    ['resolve', [CARD]],
    ['retag', [CARD, '--state', 'ready-for-agent']],
  ])('`cards %s` asks, and a "no" writes nothing', async (cmd, argv) => {
    await useTracker();
    const stand = await startServer({ cards: [card({ cardId: CARD, tags: ['tag-bug', 'tag-needs-triage'] })] });
    const asked = jest.spyOn(safety, 'confirmAction').mockResolvedValue(false);

    try {
      // A decline is exit 0 — under `run()`, the code nobody set. It was a
      // literal `process.exit(0)` until #119, which is what the
      // `rejects.toThrow('process.exit(0)')` this replaces was reading.
      await runHuman(cmd, ...(argv as string[]));
      expect(process.exitCode).toBeUndefined();
      expect(asked).toHaveBeenCalled();
      expect(writes(stand.received)).toEqual([]);
      expect(said()).toContain('Aborted.');
    } finally {
      asked.mockRestore();
    }
  });

  it.each(['claim', 'resolve', 'retag'])('`cards %s` takes -y to skip the prompt', (cmd) => {
    const found = buildProgram()
      .commands.find((c) => c.name() === 'cards')!
      .commands.find((c) => c.name() === cmd)!;
    expect(found.options.map((o) => o.long)).toContain('--yes');
    expect(found.options.find((o) => o.long === '--yes')!.short).toBe('-y');
  });

  it('--dry-run does not ask — previewing is not writing', async () => {
    await useTracker();
    await startServer();
    const asked = jest.spyOn(safety, 'confirmAction');

    try {
      await run('resolve', CARD, '--dry-run');
      expect(asked).not.toHaveBeenCalled();
    } finally {
      asked.mockRestore();
    }
  });
});

describe('`cards retag` enforces the triage vocabulary before the wire', () => {
  it('swaps the roles and leaves tags outside the two axes alone', async () => {
    const stand = await startServer({
      cards: [card({ cardId: CARD, tags: ['tag-bug', 'tag-needs-triage'] })],
    });

    await run('retag', CARD, '--state', 'ready-for-agent');

    const put = writes(stand.received).find((r) => r.method === 'PUT');
    expect(put!.body.addTagIds).toEqual(['tag-ready-for-agent']);
    expect(put!.body.removeTagIds).toEqual(['tag-needs-triage']);
    // The category the card already carried stays: this is a role swap, not a
    // whole-array replacement.
    expect(stand.cards.get(CARD)!.tags.sort()).toEqual(['tag-bug', 'tag-ready-for-agent']);
  });

  it('an unknown role never reaches the wire — an unknown name there is a tag CREATION', async () => {
    const stand = await startServer({ cards: [card({ cardId: CARD, tags: ['tag-bug'] })] });

    expect(await exitCodeAfter('retag', CARD, '--state', 'in-progress')).toBe(1);

    expect(writes(stand.received)).toEqual([]);
    expect(said()).toContain('is not a state role');
  });

  it('the refusal is about the ROLE LIST and never calls the name unknown (#164)', async () => {
    // Measured live, 2026-08-13: `cards retag <card> --category "wayfinder:map"`
    // refused with *"an unknown name on a tag write is a tag creation, not a
    // match"* — for a tag `tags get` resolves to `ZLAszhmCsDpuNGG66` one command
    // earlier. The refusal was right, its stated reason was not, and a live run
    // read it as "the tag does not exist" and abandoned the workflow.
    //
    // `wayfinder:map` is in this stand's TAGS, so it EXISTS here too: the axis
    // refuses names that are not roles, and `settleAxis` looks nothing up, so it
    // is in no position to say anything about existence either way.
    const stand = await startServer({ cards: [card({ cardId: CARD, tags: ['tag-bug'] })] });

    expect(await exitCodeAfter('retag', CARD, '--category', 'wayfinder:map')).toBe(1);
    expect(writes(stand.received)).toEqual([]);

    // Read off the envelope rather than the raw stream: the message rides inside
    // the JSON refusal, so its own quoting is escaped there.
    const message = JSON.parse(said()).error.message as string;
    expect(message).toContain('"wayfinder:map" is not a category role');
    expect(message).not.toMatch(/unknown name/i);
    expect(message).not.toMatch(/tag creation/i);
    // And the remedy it points at instead — pinned because a refusal that names
    // a command the CLI does not have is this repo's remembered defect.
    expect(message).toContain("'cards update <card> --tags");
  });

  it('the remedy that refusal prints does write a non-role tag, by name', async () => {
    // The other half: the message is only true if `cards update --tags` really
    // writes a pre-existing tag by name. Measured live on the same tag — exit 0,
    // `tagIds` gained `ZLAszhmCsDpuNGG66`, no duplicate minted — and modelled
    // here so a regression on the update path reddens the retag message too.
    const stand = await startServer({ cards: [card({ cardId: CARD, tags: ['tag-bug'] })] });

    await run('update', CARD, '--tags', 'bug,wayfinder:map', '--yes');

    const put = writes(stand.received).find((r) => r.method === 'PUT');
    expect(put!.body.addTagIds).toEqual(['tag-wayfinder-map']);
    expect(stand.cards.get(CARD)!.tags.sort()).toEqual(['tag-bug', 'tag-wayfinder-map']);
  });
});
