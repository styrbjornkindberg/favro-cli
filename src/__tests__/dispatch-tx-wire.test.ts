/**
 * The dispatch table over a `node:http` Favro stand-in — issues #50 and #51.
 *
 * This is THE seam. The table is by construction the single place the CLI
 * commander actions and the skill engine meet, so driving an intent through it
 * exercises the whole stack minus commander parsing: resolver detection, error
 * classification, the tx write facade, the compensation log, compare-before-
 * restore, and the scope lock.
 *
 * Every assertion below is about what the wire RECEIVED or what the caller
 * OBSERVED. None is about how we got there. That distinction is load-bearing
 * here: Favro answers 200 for writes it does not perform, so a mock asserting
 * our own outgoing shape cannot tell a real write from a silent no-op — and
 * three tests in this repo pinned exactly that bug before they were corrected.
 *
 * The stand-in keeps real mutable state, so a rollback is checked by reading the
 * card back, not by counting calls.
 */
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import {
  dispatch,
  registerIntent,
  intentNames,
  UnknownIntentError,
  DispatchContext,
  MULTI_CREATE_CAP,
  ReadResult,
  RefusalError,
} from '../lib/dispatch';
import { Card } from '../lib/cards-api';
import { CompensationLog, TxCards } from '../lib/tx-cards';
import { ScopeError } from '../lib/safety';
import { TrackerMapping, renderTrackerBlock } from '../lib/tracker-config';

const ORG = 'org-1';
const BOARD = 'board-a';
const OTHER_BOARD = 'board-b';
const TODO = 'col-todo';
const DOING = 'col-doing';
const DONE = 'col-done';
const ALICE = 'aaaaaaaaaaaaaaaaa';
const BOB = 'bbbbbbbbbbbbbbbbb';
const TAG_BUG = 'tag-bug';
const TAG_P1 = 'tag-p1';
const TAG_ENHANCEMENT = 'tag-enhancement';
const TAG_TRIAGE = 'tag-needs-triage';
const TAG_AGENT = 'tag-ready-for-agent';
const TAG_MAP = 'tag-wayfinder-map';
const CARD = '00000000000000000000cc01';
const FAR = '00000000000000000000cc02';

/** The two boards, with their columns inlined exactly as `GET /widgets` does. */
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
  {
    widgetCommonId: OTHER_BOARD,
    name: 'Board B',
    collectionIds: ['coll-b'],
    columns: [{ columnId: 'col-b-1', name: 'Inbox', position: 0 }],
  },
];

/** The org's tags: the two triage axes, plus two outside the vocabulary. */
const TAGS = [
  { tagId: TAG_BUG, name: 'bug' },
  { tagId: TAG_ENHANCEMENT, name: 'enhancement' },
  { tagId: TAG_TRIAGE, name: 'needs-triage' },
  { tagId: TAG_AGENT, name: 'ready-for-agent' },
  { tagId: TAG_MAP, name: 'wayfinder:map' },
  { tagId: TAG_P1, name: 'P1' },
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
  detailedDescription?: string;
  parentCardId?: string;
}

interface Edge { near: string; far: string; isBefore: boolean }

/** A wire-level failure a test injects, keyed by how many times it has matched. */
type FailHook = (r: Received, seen: number) => { status: number; message: string } | undefined;

/**
 * A concurrent editor, modelled where a real one lives: on the far side of the
 * wire, between our write and our detecting read. Deliberately NOT a hook on
 * `DispatchContext` — the facade must not grow a test-only seam, or "compare
 * before restore" would be verifiable only through a door production cannot
 * open. `wrote` counts mutating requests already applied, so a test can edit
 * after a specific one.
 */
type ConcurrentEdit = (state: { cards: Map<string, StoredCard>; edges: Edge[] }, wrote: number) => void;

interface Stand {
  client: FavroHttpClient;
  received: Received[];
  cards: Map<string, StoredCard>;
  edges: Edge[];
}

/** Every server this file started, so a failed assertion cannot leak a listener. */
const running: http.Server[] = [];

function card(overrides: Partial<StoredCard> & { cardId: string }): StoredCard {
  return {
    cardCommonId: `ccid-${overrides.cardId}`,
    name: 'A card',
    widgetCommonId: BOARD,
    columnId: TODO,
    tags: [],
    assignments: [],
    createdAt: '2026-01-01',
    ...overrides,
  };
}

function startServer(opts: { fail?: FailHook; afterWrite?: ConcurrentEdit } = {}): Promise<Stand> {
  const received: Received[] = [];
  const cards = new Map<string, StoredCard>([
    [CARD, card({ cardId: CARD })],
    [FAR, card({ cardId: FAR, name: 'Far card' })],
  ]);
  const edges: Edge[] = [];
  let failSeen = 0;
  let created = 0;
  let wrote = 0;

  /** Applied after a mutating request lands, so the next read sees the edit. */
  const concurrently = () => {
    wrote += 1;
    opts.afterWrite?.({ cards, edges }, wrote);
  };

  /** Both views of the edge set for one card, exactly as Favro mirrors them. */
  const depsOf = (id: string) => [
    ...edges.filter((e) => e.near === id).map((e) => ({ cardId: e.far, isBefore: e.isBefore })),
    ...edges.filter((e) => e.far === id).map((e) => ({ cardId: e.near, isBefore: !e.isBefore })),
  ];

  const wire = (c: StoredCard) => ({ ...c });

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

      const injected = opts.fail?.(r, failSeen);
      if (injected) {
        failSeen += 1;
        send(injected.status, { message: injected.message });
        return;
      }

      // ── dependencies ──────────────────────────────────────────────────────
      const dep = pathOnly.match(/^\/cards\/([^/]+)\/dependencies(?:\/([^/]+))?$/);
      if (dep) {
        const [, near, far] = dep;
        if (r.method === 'GET') return send(200, { dependencies: depsOf(near) });
        if (r.method === 'POST') {
          for (const e of r.body?.dependencies ?? []) {
            const exists = edges.some(
              (x) => (x.near === near && x.far === e.cardId) || (x.near === e.cardId && x.far === near),
            );
            // Direction is not part of edge identity: a duplicate, a flipped
            // write and both from the mirror end all answer this same 403.
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

      // ── single card ───────────────────────────────────────────────────────
      const single = pathOnly.match(/^\/cards\/([^/]+)$/);
      if (single) {
        const id = single[1];
        const stored = cards.get(id);
        if (r.method === 'GET') {
          return stored ? send(200, wire(stored)) : send(403, { message: 'Access denied' });
        }
        if (r.method === 'DELETE') {
          if (!stored) return send(404, { message: 'Access denied' });
          cards.delete(id);
          res.writeHead(204); res.end(); return;
        }
        if (r.method === 'PUT') {
          if (!stored) return send(403, { message: 'Access denied' });
          const b = r.body ?? {};
          const next: StoredCard = { ...stored, tags: [...stored.tags], assignments: [...stored.assignments] };
          if (b.name !== undefined) next.name = b.name;
          if (b.detailedDescription !== undefined) next.detailedDescription = b.detailedDescription;
          if (b.columnId !== undefined) next.columnId = b.columnId;
          if (b.widgetCommonId !== undefined) next.widgetCommonId = b.widgetCommonId;
          for (const id2 of b.addTagIds ?? []) if (!next.tags.includes(id2)) next.tags.push(id2);
          for (const id2 of b.removeTagIds ?? []) next.tags = next.tags.filter((t) => t !== id2);
          for (const u of b.addAssignmentIds ?? []) {
            if (!next.assignments.some((a) => a.userId === u)) next.assignments.push({ userId: u });
          }
          for (const u of b.removeAssignmentIds ?? []) {
            next.assignments = next.assignments.filter((a) => a.userId !== u);
          }
          cards.set(id, next);
          concurrently();
          return send(200, wire(next));
        }
      }

      // ── create / list ─────────────────────────────────────────────────────
      if (pathOnly === '/cards') {
        if (r.method === 'POST') {
          created += 1;
          const id = `new-card-${created}`;
          const made = card({
            cardId: id,
            name: r.body?.name ?? 'made',
            widgetCommonId: r.body?.widgetCommonId ?? BOARD,
            columnId: r.body?.columnId ?? TODO,
            tags: [],
            detailedDescription: r.body?.detailedDescription,
            parentCardId: r.body?.parentCardId,
          });
          cards.set(id, made);
          return send(200, wire(made));
        }
        const query = new URLSearchParams(url.split('?')[1] ?? '');
        const commonId = query.get('cardCommonId');
        const seq = query.get('cardSequentialId');
        const widget = query.get('widgetCommonId');
        const entities = [...cards.values()].filter((c) => {
          // `widgetCommonId` narrows a card that lives on several boards — the
          // whole point of threading a board into a resolution.
          if (widget && c.widgetCommonId !== widget) return false;
          if (commonId) return c.cardCommonId === commonId;
          if (seq) return false;
          return true;
        });
        return send(200, { entities: entities.map(wire) });
      }

      // ── directories ───────────────────────────────────────────────────────
      if (pathOnly.startsWith('/columns')) {
        // `verifyTrackerMapping` asks this one, per call, by board.
        const board = new URLSearchParams(url.split('?')[1] ?? '').get('widgetCommonId');
        const found = BOARDS.find((w) => w.widgetCommonId === board);
        return send(200, {
          entities: (found?.columns ?? []).map((c) => ({ ...c, widgetCommonId: board })),
        });
      }
      if (pathOnly.startsWith('/widgets')) {
        // A by-id widget GET answers the bare entity; only the list answers an
        // `entities` envelope. `assertScope` reads `collectionIds` off the
        // former, so serving the envelope for both would make the lock
        // unenforceable against a board that is genuinely in scope.
        const byId = pathOnly.slice('/widgets'.length).replace(/^\//, '');
        if (byId) {
          const found = BOARDS.find((w) => w.widgetCommonId === byId);
          return found ? send(200, found) : send(404, { message: 'Widget not found' });
        }
        return send(200, { entities: BOARDS });
      }
      if (pathOnly.startsWith('/tags')) {
        return send(200, { entities: TAGS });
      }
      if (pathOnly.startsWith('/users')) {
        return send(200, {
          entities: [
            { userId: ALICE, name: 'Alice Ahlberg', email: 'alice@example.com' },
            { userId: BOB, name: 'Bob Berg', email: 'bob@example.com' },
          ],
        });
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
        edges,
      });
    });
  });
}

const writes = (received: Received[]) => received.filter((r) => r.method !== 'GET');
const puts = (received: Received[]) => received.filter((r) => r.method === 'PUT');

const originalConfigDir = process.env.FAVRO_CONFIG_DIR;
const originalTrackerDoc = process.env.FAVRO_TRACKER_DOC;
let tmpDir: string;

/**
 * Designate a tracker the way `tracker init` does — a pasted block in the repo
 * doc — and point the CLI at it. Written per test into that test's own tmpdir,
 * so nothing reads the developer's real `docs/agents/issue-tracker.md`.
 */
async function useTracker(columns?: TrackerMapping['columns']): Promise<TrackerMapping> {
  const mapping: TrackerMapping = {
    collectionId: 'coll-a',
    boardId: BOARD,
    columns: columns ?? { active: DOING, done: DONE },
  };
  const doc = path.join(tmpDir, 'issue-tracker.md');
  await fs.writeFile(doc, renderTrackerBlock(mapping));
  process.env.FAVRO_TRACKER_DOC = doc;
  return mapping;
}

/** No scope lock configured — the table's guardrail is exercised separately. */
function ctx(stand: Stand, extra: Partial<DispatchContext> = {}): DispatchContext {
  return { client: stand.client, config: {}, ...extra };
}

beforeAll(() => {
  // Probe intents: the facade ops whose production intents land in #53/#54/#55
  // still have to be observable through this seam today, and the registry is
  // extensible by construction — that is what #53–#56 build on.
  registerIntent({
    name: 'probe-move',
    summary: 'move a card, optionally failing afterwards',
    preview: (a: any) => [`move ${a.card} to "${a.to}"`],
    board: async (a: any, tx: TxCards) => (await tx.getCard(a.card)).boardId,
    run: async (a: any, tx: TxCards) => {
      const moved = await tx.moveColumn(a.card, a.to);
      if (a.thenFail) throw new Error('probe failure after the move');
      return { columnId: moved.columnId };
    },
  });
  registerIntent({
    name: 'probe-tags',
    summary: 'replace tags, optionally failing afterwards',
    preview: (a: any) => [`set tags on ${a.card} to ${a.tags.join(', ')}`],
    board: async (a: any, tx: TxCards) => (await tx.getCard(a.card)).boardId,
    run: async (a: any, tx: TxCards) => {
      await tx.setTags(a.card, a.tags);
      if (a.thenFail) throw new Error('probe failure after the tag write');
      return {};
    },
  });
  registerIntent({
    name: 'probe-assignees',
    summary: 'replace assignees, optionally failing afterwards',
    preview: (a: any) => [`set assignees on ${a.card} to ${a.assignees.join(', ')}`],
    board: async (a: any, tx: TxCards) => (await tx.getCard(a.card)).boardId,
    run: async (a: any, tx: TxCards) => {
      await tx.setAssignees(a.card, a.assignees);
      if (a.thenFail) throw new Error('probe failure after the assignee write');
      return {};
    },
  });
  registerIntent({
    name: 'probe-chain',
    summary: 'two reversible ops in one invocation, then a failure',
    preview: (a: any) => [`move ${a.card}`, `tag ${a.card}`],
    board: async (a: any, tx: TxCards) => (await tx.getCard(a.card)).boardId,
    run: async (a: any, tx: TxCards) => {
      await tx.moveColumn(a.card, a.to);
      await tx.setTags(a.card, a.tags);
      throw new Error('probe failure after two ops');
    },
  });
  registerIntent({
    name: 'probe-fail',
    summary: 'fails without writing anything',
    preview: () => ['fail'],
    board: async () => undefined,
    run: async () => { throw new Error('probe failed immediately'); },
  });
});

beforeEach(async () => {
  // The name cache is a real file — give each test its own, so a run never
  // reads or clobbers the developer's own ~/.favro cache.
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-dispatch-test-'));
  process.env.FAVRO_CONFIG_DIR = tmpDir;
  // Point the tracker doc somewhere that does not exist, so nothing reads the
  // developer's repo doc.
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

describe('the table is the single home for every write intent', () => {
  it('the seven intents named by the spec are all registered', () => {
    // All seven. Frontier-listing was cut (subsumed by `--filter`) and
    // list-children folded into `read`, so there is no eighth.
    for (const name of [
      'create',
      'read',
      'claim',
      'resolve',
      'add-blocking-edge',
      'remove-blocking-edge',
      'retag',
    ]) {
      expect(intentNames()).toContain(name);
    }
  });

  it('an unknown intent refuses with the table contents, and writes nothing', async () => {
    const stand = await startServer();
    await expect(dispatch('claim-it-all', {}, ctx(stand))).rejects.toThrow(UnknownIntentError);
    expect(writes(stand.received)).toHaveLength(0);
  });

  it('create returns ok with the card the wire actually made', async () => {
    const stand = await startServer();
    const result = await dispatch<{ cardId: string }>(
      'create',
      { name: 'Ship it', board: BOARD, status: 'Doing' },
      ctx(stand),
    );

    expect(result.outcome).toBe('ok');
    expect(result.value?.cardId).toBe('new-card-1');
    const posts = writes(stand.received).filter((r) => r.path === '/cards');
    expect(posts).toHaveLength(1);
    expect(posts[0].body.columnId).toBe(DOING);
  });

  it('a BARE STRING in a list-shaped field is one item, never a string of characters', async () => {
    // The skill engine hands `Record<string, string>` straight to `dispatch`, so
    // every one of these arrives as a string. `blockedBy` was the silent one:
    // it passes a `.length` check and then gets spread, so `"…cc02"` became one
    // `toCardId` call per CHARACTER and the wire got a card that isn't there.
    const stand = await startServer();

    const result = await dispatch(
      'create',
      { name: 'From a skill', board: BOARD, tags: 'bug', assignees: ALICE, blockedBy: FAR, blocks: CARD },
      ctx(stand),
    );

    expect(result.outcome).toBe('ok');
    const posts = writes(stand.received).filter((r) => r.path === '/cards');
    expect(posts).toHaveLength(1);
    // What the wire received, field by field — one element each, not N.
    expect(posts[0].body.tags).toEqual(['bug']);
    expect(posts[0].body.assignmentIds).toEqual([ALICE]);
    expect(posts[0].body.dependencies).toEqual([
      { cardId: FAR, isBefore: true },
      { cardId: CARD, isBefore: false },
    ]);
  });

  it('an empty string in a list-shaped field is absent, not an empty-named item', async () => {
    const stand = await startServer();
    const result = await dispatch('create', { name: 'Bare', board: BOARD, tags: '' }, ctx(stand));

    expect(result.outcome).toBe('ok');
    const posts = writes(stand.received).filter((r) => r.path === '/cards');
    expect(posts[0].body.tags).toBeUndefined();
  });
});

describe('the mandatory scope lock is enforced inside the table', () => {
  it('a board outside the locked collection refuses, and no write is built', async () => {
    const stand = await startServer();

    await expect(
      dispatch('create', { name: 'x', board: OTHER_BOARD }, ctx(stand, {
        config: { scopeCollectionId: 'coll-a', scopeCollectionName: 'Collection A' },
      })),
    ).rejects.toThrow(ScopeError);

    expect(writes(stand.received)).toHaveLength(0);
  });

  it('a board inside the locked collection proceeds', async () => {
    const stand = await startServer();
    const result = await dispatch('create', { name: 'x', board: BOARD }, ctx(stand, {
      config: { scopeCollectionId: 'coll-a' },
    }));
    expect(result.outcome).toBe('ok');
  });

  it('--force overrides the lock — the lock is the guardrail, not the dry-run flag', async () => {
    const stand = await startServer();
    const result = await dispatch('create', { name: 'x', board: OTHER_BOARD }, ctx(stand, {
      config: { scopeCollectionId: 'coll-a' },
      force: true,
    }));
    expect(result.outcome).toBe('ok');
  });
});

describe('the lock fails CLOSED on a write that resolves no board', () => {
  /** A lock that is actually configured — `ctx()` deliberately configures none. */
  const locked = (stand: Stand): DispatchContext =>
    ctx(stand, { config: { scopeCollectionId: 'coll-a', scopeCollectionName: 'Collection A' } });

  /** The assignment fork: no `widgetCommonId`, so `card.boardId` is undefined. */
  const forkAndEdge = (stand: Stand) => {
    stand.cards.get(CARD)!.widgetCommonId = undefined;
    stand.cards.get(CARD)!.columnId = undefined;
    stand.cards.get(CARD)!.tags = [TAG_BUG, TAG_TRIAGE];
    stand.edges.push({ near: CARD, far: FAR, isBefore: true });
  };

  // Every write intent that boards off `getCard(...).boardId`. A fork has no
  // board, and an empty board list means the lock's loop never runs — so
  // without the refusal these three wrote with no scope check at all.
  it.each([
    ['remove-blocking-edge', { card: CARD, blockedBy: FAR }],
    ['add-blocking-edge', { card: CARD, blockedBy: FAR }],
    ['retag', { card: CARD, state: 'ready-for-agent' }],
  ])('%s on a boardless fork refuses, and nothing reaches the wire', async (name, args) => {
    const stand = await startServer();
    forkAndEdge(stand);

    await expect(dispatch(name, args, locked(stand))).rejects.toThrow(RefusalError);

    // The wire, not a call count: the throw alone would still pass if the write
    // had already gone out ahead of it.
    expect(writes(stand.received)).toHaveLength(0);
    expect(stand.edges).toEqual([{ near: CARD, far: FAR, isBefore: true }]);
    expect(stand.cards.get(CARD)!.tags).toEqual([TAG_BUG, TAG_TRIAGE]);
  });

  it('a board OUTSIDE the lock still refuses — the ordinary violation is unchanged', async () => {
    const stand = await startServer();
    stand.cards.get(CARD)!.widgetCommonId = OTHER_BOARD;
    stand.edges.push({ near: CARD, far: FAR, isBefore: true });

    await expect(
      dispatch('remove-blocking-edge', { card: CARD, blockedBy: FAR }, locked(stand)),
    ).rejects.toThrow(ScopeError);
    expect(writes(stand.received)).toHaveLength(0);
    expect(stand.edges).toEqual([{ near: CARD, far: FAR, isBefore: true }]);
  });

  it('a board INSIDE the lock still writes — the lock must not become unconditional', async () => {
    const stand = await startServer();
    stand.edges.push({ near: CARD, far: FAR, isBefore: true });

    const result = await dispatch('remove-blocking-edge', { card: CARD, blockedBy: FAR }, locked(stand));

    expect(result.outcome).toBe('ok');
    expect(stand.edges).toEqual([]);
  });

  it('read on a boardless fork still works — reads are deliberately unlocked', async () => {
    const stand = await startServer();
    stand.cards.get(CARD)!.widgetCommonId = undefined;

    const result = await dispatch<ReadResult>('read', { card: CARD }, locked(stand));

    expect(result.outcome).toBe('ok');
    expect(result.value?.card.cardId).toBe(CARD);
  });
});

describe('--dry-run is a preview only', () => {
  it('previews the whole chain and makes no write at all', async () => {
    const stand = await startServer();
    const result = await dispatch('probe-chain', { card: CARD, to: 'Doing', tags: ['bug'] }, ctx(stand, {
      dryRun: true,
    }));

    expect(result.outcome).toBe('ok');
    expect(result.preview).toEqual([`move ${CARD}`, `tag ${CARD}`]);
    expect(writes(stand.received)).toHaveLength(0);
  });
});

describe('a failed multi-step write unwinds LIFO and reports rolled-back', () => {
  it('two ops in one invocation are both undone, newest first', async () => {
    const stand = await startServer();

    const result = await dispatch('probe-chain', { card: CARD, to: 'Doing', tags: ['bug'] }, ctx(stand));

    expect(result.outcome).toBe('rolled-back');
    expect(result.retryable).toBe(true);
    // What the caller can see afterwards: the card is exactly as it started.
    expect(stand.cards.get(CARD)!.columnId).toBe(TODO);
    expect(stand.cards.get(CARD)!.tags).toEqual([]);
    // Newest first: the tag write is undone before the column move.
    const compensating = puts(stand.received).slice(2);
    expect(compensating[0].body).toHaveProperty('removeTagIds', [TAG_BUG]);
    expect(compensating[1].body).toHaveProperty('columnId', TODO);
  });

  it('an intent that failed before writing anything still reports rolled-back', async () => {
    const stand = await startServer();
    const result = await dispatch('probe-fail', {}, ctx(stand));

    expect(result.outcome).toBe('rolled-back');
    expect(result.error).toContain('probe failed immediately');
    expect(writes(stand.received)).toHaveLength(0);
  });

  it('a created card is deleted on rollback — create carries an undo handle', async () => {
    const stand = await startServer();
    const log = new CompensationLog();

    const made = await dispatch<{ cardId: string }>('create', { name: 'first', board: BOARD }, ctx(stand, { log }));
    expect(made.outcome).toBe('ok');
    expect(stand.cards.has('new-card-1')).toBe(true);

    // A second invocation over the SAME log: the transaction spans both, which
    // is what lets a skill run unwind as a whole.
    const failed = await dispatch('probe-fail', {}, ctx(stand, { log }));
    expect(failed.outcome).toBe('rolled-back');
    expect(stand.cards.has('new-card-1')).toBe(false);
  });
});

describe('compare-before-restore is always on, in whatever shape the write took', () => {
  it('a scalar write is restored when the live value is still the one we wrote', async () => {
    const stand = await startServer();
    const result = await dispatch('probe-move', { card: CARD, to: 'Doing', thenFail: true }, ctx(stand));

    expect(result.outcome).toBe('rolled-back');
    expect(stand.cards.get(CARD)!.columnId).toBe(TODO);
  });

  it('a scalar a concurrent editor changed is SKIPPED, with per-field detail', async () => {
    const stand = await startServer({
      fail: (r) => {
        // A human moves the card to Done between our write and the rollback's
        // detecting read. There is no version carrier on the wire, so this read
        // is the only guard available.
        if (r.method === 'GET' && r.path === `/cards/${CARD}`) {
          const held = standRef?.cards.get(CARD);
          if (held && held.columnId === DOING) held.columnId = DONE;
        }
        return undefined;
      },
    });
    // eslint-disable-next-line prefer-const
    standRef = stand;

    const result = await dispatch('probe-move', { card: CARD, to: 'Doing', thenFail: true }, ctx(stand));

    expect(result.outcome).toBe('rollback-incomplete');
    expect(result.retryable).toBe(false);
    expect(result.orphans).toEqual([
      expect.objectContaining({
        cause: 'compensation-skipped',
        card: CARD,
        field: 'columnId',
        wrote: DOING,
        live: DONE,
      }),
    ]);
    // The whole point: we did NOT write over the concurrent edit.
    expect(stand.cards.get(CARD)!.columnId).toBe(DONE);
  });

  it('a delta write compares PER ELEMENT — a tag a human added does not block our undo', async () => {
    // Someone adds P1 after our write lands. Whole-field equality would refuse
    // to undo our own `tags=[bug]` just because P1 appeared.
    const stand = await startServer({
      afterWrite: ({ cards }, wrote) => {
        if (wrote !== 1) return;
        cards.get(CARD)!.tags.push(TAG_P1);
      },
    });
    stand.cards.get(CARD)!.tags = [];

    const result = await dispatch('probe-tags', { card: CARD, tags: ['bug'], thenFail: true }, ctx(stand));

    expect(result.outcome).toBe('rolled-back');
    expect(result.orphans ?? []).toEqual([]);
    // Our element is gone; theirs survives untouched.
    expect(stand.cards.get(CARD)!.tags).toEqual([TAG_P1]);
    const compensating = puts(stand.received).slice(1);
    expect(compensating[0].body).toEqual({ removeTagIds: [TAG_BUG] });
  });

  it('a delta element a concurrent editor already undid is not rewritten, and is not an orphan', async () => {
    // A concurrent editor unassigns Alice after our write — the very element we
    // added, so the divergence is inside our own delta.
    //
    // This is NOT `rollback-incomplete`, and the distinction is the whole point
    // of the outcome. An orphan is something the unwind LEFT BEHIND, which is
    // why it is not retryable. Here the pre-state was "Alice absent" and Alice
    // is absent: the rollback's goal is already met, by someone else's hand. The
    // per-element inverse is idempotent, so there is nothing to undo and nothing
    // to clobber. Reporting not-retryable would send an agent to inspect
    // wreckage that does not exist.
    //
    // Contrast the scalar case above: there the field was left on DONE, which is
    // neither what we wrote nor the pre-state — genuinely left behind.
    const stand = await startServer({
      afterWrite: ({ cards }, wrote) => {
        if (wrote !== 1) return;
        cards.get(CARD)!.assignments = [];
      },
    });
    const result = await dispatch('probe-assignees', {
      card: CARD, assignees: [ALICE], thenFail: true,
    }, ctx(stand));

    expect(result.outcome).toBe('rolled-back');
    expect(result.retryable).toBe(true);
    expect(result.orphans ?? []).toEqual([]);
    // The guarantee that matters: we did not rewrite the element. Exactly one
    // PUT — ours — and no compensating write chasing an element already gone.
    expect(puts(stand.received)).toHaveLength(1);
    expect(stand.cards.get(CARD)!.assignments).toEqual([]);
  });

  it('there is no opt-out flag on the guard', async () => {
    // Stated as a shape assertion because the absence of a flag is the point:
    // under the honest-failure posture an opt-out is a licence to clobber.
    const stand = await startServer();
    const keys = Object.keys(ctx(stand) as unknown as Record<string, unknown>);
    expect(keys).not.toContain('skipCompare');
    expect(keys).not.toContain('compare');
    expect(keys).not.toContain('noCompare');
  });
});

describe('rollback-incomplete distinguishes a failed write from a skipped one', () => {
  it('a compensating write that FAILED is reported as compensation-failed', async () => {
    let seenPuts = 0;
    const stand = await startServer({
      fail: (r) => {
        if (r.method !== 'PUT') return undefined;
        seenPuts += 1;
        // The forward write lands; the compensating one is refused.
        //
        // NOT "Access denied": per #38's measured closed set that message means
        // the resource is MISSING, whatever the status, and a missing target for
        // an inverse write is already-undone — success, not an orphan. An
        // unrecognised 403 is the honest "your write was refused".
        return seenPuts >= 2 ? { status: 403, message: 'Insufficient privileges' } : undefined;
      },
    });

    const result = await dispatch('probe-move', { card: CARD, to: 'Doing', thenFail: true }, ctx(stand));

    expect(result.outcome).toBe('rollback-incomplete');
    expect(result.retryable).toBe(false);
    expect(result.orphans).toEqual([
      expect.objectContaining({ cause: 'compensation-failed', card: CARD, field: 'columnId' }),
    ]);
    // Favro's own words, verbatim — the human finishing this cleanup needs the
    // refusal as the wire stated it, not our paraphrase of it.
    expect(result.orphans![0].reason).toContain('Insufficient privileges');
    // The orphan the human has to finish: the card is still where we put it.
    expect(stand.cards.get(CARD)!.columnId).toBe(DOING);
  });

  it('404 on the inverse counts as success, not as an orphan', async () => {
    const stand = await startServer();
    const log = new CompensationLog();

    await dispatch('create', { name: 'gone', board: BOARD }, ctx(stand, { log }));
    // Someone deletes the card before we get to undo the create.
    stand.cards.delete('new-card-1');

    const result = await dispatch('probe-fail', {}, ctx(stand, { log }));
    expect(result.outcome).toBe('rolled-back');
    expect(result.orphans ?? []).toEqual([]);
  });
});

describe('remove-blocking-edge is tx-instrumented over the verified unlink', () => {
  it('the edge is removed, and re-added with the SAME direction on rollback', async () => {
    const stand = await startServer();
    stand.edges.push({ near: CARD, far: FAR, isBefore: true });
    const log = new CompensationLog();

    const removed = await dispatch('remove-blocking-edge', { card: CARD, blockedBy: FAR }, ctx(stand, { log }));
    expect(removed.outcome).toBe('ok');
    expect(stand.edges).toHaveLength(0);

    const failed = await dispatch('probe-fail', {}, ctx(stand, { log }));
    expect(failed.outcome).toBe('rolled-back');
    expect(stand.edges).toEqual([{ near: CARD, far: FAR, isBefore: true }]);
  });

  it('removing an edge that is not there writes nothing and needs no undo', async () => {
    const stand = await startServer();
    const result = await dispatch<{ removed: boolean }>(
      'remove-blocking-edge',
      { card: CARD, blockedBy: FAR },
      ctx(stand),
    );

    expect(result.outcome).toBe('ok');
    expect(result.value?.removed).toBe(false);
    expect(writes(stand.received)).toHaveLength(0);
  });

  it('an edge a concurrent editor re-added FLIPPED is skipped, naming the live direction', async () => {
    const stand = await startServer();
    stand.edges.push({ near: CARD, far: FAR, isBefore: true });
    const log = new CompensationLog();

    await dispatch('remove-blocking-edge', { card: CARD, blockedBy: FAR }, ctx(stand, { log }));
    // Someone re-creates the pair the other way round. Direction is not part of
    // edge identity, so re-adding ours would 403 — and claiming success would
    // report `A blocks B` while the wire says `B blocks A`.
    stand.edges.push({ near: CARD, far: FAR, isBefore: false });

    const result = await dispatch('probe-fail', {}, ctx(stand, { log }));
    expect(result.outcome).toBe('rollback-incomplete');
    expect(result.orphans).toEqual([
      expect.objectContaining({
        cause: 'compensation-skipped',
        card: CARD,
        field: 'dependencies',
        live: { far: FAR, isBefore: false },
      }),
    ]);
    expect(stand.edges).toEqual([{ near: CARD, far: FAR, isBefore: false }]);
  });
});

describe('add-blocking-edge is idempotent by verification', () => {
  const deps = (received: Received[]) =>
    received.filter((r) => r.method === 'GET' && r.path === `/cards/${CARD}/dependencies`);

  it('writes the edge once when the pair holds none, after one bounded pre-read', async () => {
    const stand = await startServer();

    const result = await dispatch<{ created: boolean }>(
      'add-blocking-edge',
      { card: CARD, blockedBy: FAR },
      ctx(stand),
    );

    expect(result.outcome).toBe('ok');
    expect(result.value?.created).toBe(true);
    // One pre-read on ONE card: Favro mirrors the edge set, so the far card
    // needs no read of its own.
    expect(deps(stand.received)).toHaveLength(1);
    const posts = writes(stand.received);
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe(`/cards/${CARD}/dependencies`);
    expect(posts[0].body).toEqual({ dependencies: [{ cardId: FAR, isBefore: true }] });
    expect(stand.edges).toEqual([{ near: CARD, far: FAR, isBefore: true }]);
  });

  it('an edge already there is ok with created:false, and NOTHING is written', async () => {
    // Also the retry contract: after a `rollback-incomplete` left this edge
    // behind as an orphan, running the same call again has to reach `ok`
    // instead of compounding the wreckage.
    const stand = await startServer();
    stand.edges.push({ near: CARD, far: FAR, isBefore: true });

    const result = await dispatch<{ created: boolean }>(
      'add-blocking-edge',
      { card: CARD, blockedBy: FAR },
      ctx(stand),
    );

    expect(result.outcome).toBe('ok');
    // The marker that separates "created" from "already there".
    expect(result.value?.created).toBe(false);
    expect(writes(stand.received)).toHaveLength(0);
  });

  it('the REVERSE edge refuses, names the live direction, and writes nothing', async () => {
    // The pair holds `CARD blocks FAR`; we are asked for `FAR blocks CARD`.
    const stand = await startServer();
    stand.edges.push({ near: CARD, far: FAR, isBefore: false });

    // ONE dispatch, so the "writes nothing" check below covers exactly the one
    // attempt it reads as.
    const refusal = await dispatch('add-blocking-edge', { card: CARD, blockedBy: FAR }, ctx(stand))
      .then(() => undefined, (e: Error) => e);
    expect(refusal?.message).toMatch(/already holds the REVERSE edge/);
    expect(refusal?.message).toMatch(/remove-blocking-edge/);

    // A flipped write is never applied — the pair is exactly as it was.
    expect(writes(stand.received)).toHaveLength(0);
    expect(stand.edges).toEqual([{ near: CARD, far: FAR, isBefore: false }]);
  });

  it('the race window falls through to exactly ONE re-read', async () => {
    // The pair is empty at the pre-read and exists by the time we write — the
    // 403 is not success, so the re-read is what says which direction won.
    let racing: Stand | undefined;
    const stand = await startServer({
      fail: (r) => {
        if (r.method !== 'POST' || !r.path.endsWith('/dependencies')) return undefined;
        racing!.edges.push({ near: CARD, far: FAR, isBefore: true });
        return { status: 403, message: 'Dependency already exists' };
      },
    });
    racing = stand;

    const result = await dispatch<{ created: boolean }>(
      'add-blocking-edge',
      { card: CARD, blockedBy: FAR },
      ctx(stand),
    );

    expect(result.outcome).toBe('ok');
    expect(result.value?.created).toBe(false);
    // Pre-read plus one re-read. Not two, not a retry loop.
    expect(deps(stand.received)).toHaveLength(2);
    expect(writes(stand.received)).toHaveLength(1);
  });

  it('a race that lands the pair FLIPPED refuses instead of reporting success', async () => {
    let racing: Stand | undefined;
    const stand = await startServer({
      fail: (r) => {
        if (r.method !== 'POST' || !r.path.endsWith('/dependencies')) return undefined;
        racing!.edges.push({ near: CARD, far: FAR, isBefore: false });
        return { status: 403, message: 'Dependency already exists' };
      },
    });
    racing = stand;

    await expect(
      dispatch('add-blocking-edge', { card: CARD, blockedBy: FAR }, ctx(stand)),
    ).rejects.toThrow(/already holds the REVERSE edge/);
    expect(stand.edges).toEqual([{ near: CARD, far: FAR, isBefore: false }]);
  });
});

describe('claim and resolve act on the tracker-board instance', () => {
  it('claim assigns and moves to the mapped active column in one call', async () => {
    const stand = await startServer();
    await useTracker();

    const result = await dispatch<{ columnId?: string }>(
      'claim',
      { card: CARD, assignee: 'Alice Ahlberg' },
      ctx(stand),
    );

    expect(result.outcome).toBe('ok');
    expect(result.value?.columnId).toBe(DOING);
    // What the wire received: an add-only assignment write, then the move.
    // `assignees` is a silent no-op on both verbs, and a whole-array write
    // would unassign whoever else is on the card.
    expect(puts(stand.received).map((r) => r.body)).toEqual([
      { addAssignmentIds: [ALICE] },
      { columnId: DOING },
    ]);
    expect(stand.cards.get(CARD)!.assignments).toEqual([{ userId: ALICE }]);
    expect(stand.cards.get(CARD)!.columnId).toBe(DOING);
  });

  it('resolve moves the card to the mapped done column in one call', async () => {
    const stand = await startServer();
    await useTracker();

    const result = await dispatch<{ columnId?: string }>('resolve', { card: CARD }, ctx(stand));

    expect(result.outcome).toBe('ok');
    expect(puts(stand.received).map((r) => r.body)).toEqual([{ columnId: DONE }]);
    expect(stand.cards.get(CARD)!.columnId).toBe(DONE);
  });

  it('a card that is not on the tracker board refuses, and nothing is written', async () => {
    const stand = await startServer();
    stand.cards.get(CARD)!.widgetCommonId = OTHER_BOARD;
    await useTracker();

    await expect(dispatch('resolve', { card: CARD }, ctx(stand))).rejects.toThrow(
      /not on the tracker board/,
    );
    expect(writes(stand.received)).toHaveLength(0);
  });

  it('a FORK never absorbs a claim — no widgetCommonId means no column to move to', async () => {
    // What `addAssignmentIds` produces: a second to-do-list entity with no
    // `widgetCommonId` and no `columnId`. Handed one, we refuse rather than
    // write to it.
    // CEILING, stated so a later reader does not over-trust this: the stand-in
    // never actually forks on `addAssignmentIds` — the fork is planted by hand.
    // What this pins is that a card WITHOUT a `widgetCommonId` is refused, not
    // that Favro produces one where we think it does. That half is probe
    // knowledge (#54), not something this seam can observe.
    const stand = await startServer();
    const fork = stand.cards.get(CARD)!;
    fork.widgetCommonId = undefined;
    fork.columnId = undefined;
    await useTracker();

    await expect(
      dispatch('claim', { card: CARD, assignee: ALICE }, ctx(stand)),
    ).rejects.toThrow(/fork/);
    expect(writes(stand.received)).toHaveLength(0);
  });

  it('a cardCommonId on two boards settles on the tracker instance, not a dead end', async () => {
    // `resolveCardId` returns a non-sequential reference UNCHANGED, so the board
    // has to be threaded into the READ as well. Without it this escalates
    // unscoped, finds both instances and refuses with "pass --board <board>" —
    // a flag `claim` does not have.
    const stand = await startServer();
    stand.cards.set('other-instance', card({
      cardId: 'other-instance',
      cardCommonId: `ccid-${CARD}`,
      widgetCommonId: OTHER_BOARD,
      columnId: 'col-b-1',
    }));
    await useTracker();

    const result = await dispatch<{ cardId: string; columnId?: string }>(
      'claim',
      { card: `ccid-${CARD}`, assignee: ALICE },
      ctx(stand),
    );

    expect(result.outcome).toBe('ok');
    expect(result.value?.cardId).toBe(CARD);
    expect(stand.cards.get(CARD)!.columnId).toBe(DOING);
    // The other board's instance is untouched.
    expect(stand.cards.get('other-instance')!.columnId).toBe('col-b-1');
    expect(stand.cards.get('other-instance')!.assignments).toEqual([]);
  });

  it('a mapped column that is gone refuses per call, and never re-points', async () => {
    const stand = await startServer();
    await useTracker({ active: 'col-deleted', done: DONE });

    await expect(dispatch('claim', { card: CARD }, ctx(stand))).rejects.toThrow(
      /Refusing to re-point it/,
    );
    expect(writes(stand.received)).toHaveLength(0);
  });
});

describe('retag keeps the triage vocabulary coherent', () => {
  it('swaps the state role, leaves the category and everything outside the axes alone', async () => {
    const stand = await startServer();
    stand.cards.get(CARD)!.tags = [TAG_MAP, TAG_BUG, TAG_TRIAGE];

    const result = await dispatch<{ category: string; state: string }>(
      'retag',
      { card: CARD, state: 'ready-for-agent' },
      ctx(stand),
    );

    expect(result.outcome).toBe('ok');
    expect(result.value).toMatchObject({ category: 'bug', state: 'ready-for-agent' });
    expect(puts(stand.received).map((r) => r.body)).toEqual([
      { addTagIds: [TAG_AGENT], removeTagIds: [TAG_TRIAGE] },
    ]);
    // The `wayfinder:map` tag is not on either axis and survives untouched.
    expect(stand.cards.get(CARD)!.tags).toEqual([TAG_MAP, TAG_BUG, TAG_AGENT]);
  });

  it('an unknown role is refused in CLI code — no tag is created, no write is made', async () => {
    const stand = await startServer();
    stand.cards.get(CARD)!.tags = [TAG_BUG, TAG_TRIAGE];

    await expect(
      dispatch('retag', { card: CARD, state: 'in-progress' }, ctx(stand)),
    ).rejects.toThrow(/not a state role/);
    expect(writes(stand.received)).toHaveLength(0);
  });

  it('refuses to leave a card with two category tags', async () => {
    const stand = await startServer();
    stand.cards.get(CARD)!.tags = [TAG_BUG, TAG_ENHANCEMENT, TAG_TRIAGE];

    await expect(dispatch('retag', { card: CARD, state: 'ready-for-agent' }, ctx(stand)))
      .rejects.toThrow(/2 category tags/);
    expect(writes(stand.received)).toHaveLength(0);
  });

  it('refuses when an axis would be left empty', async () => {
    const stand = await startServer();
    stand.cards.get(CARD)!.tags = [TAG_BUG];

    await expect(dispatch('retag', { card: CARD, category: 'enhancement' }, ctx(stand)))
      .rejects.toThrow(/carries no state tag/);
    expect(writes(stand.received)).toHaveLength(0);
  });
});

describe('a deterministic refusal is never dressed up as a retryable rollback', () => {
  it('a refusal in step 2 of a threaded transaction stays a refusal, and step 1 still undoes', async () => {
    // The skill engine's shape: ONE log threaded through several dispatches. The
    // log's depth counts what EARLIER steps wrote, so "have I written yet?" can
    // only be answered against the depth this invocation started at.
    const stand = await startServer();
    stand.cards.get(CARD)!.tags = [TAG_BUG, TAG_TRIAGE];
    const log = new CompensationLog();

    const first = await dispatch('probe-move', { card: CARD, to: 'Doing' }, ctx(stand, { log }));
    expect(first.outcome).toBe('ok');

    // Step 2 refuses deterministically. Reported as `rolled-back / retryable`,
    // an agent would re-run the whole thing and refuse identically, forever.
    await expect(
      dispatch('retag', { card: CARD, state: 'in-progress' }, ctx(stand, { log })),
    ).rejects.toThrow(/not a state role/);

    // The refusal did not unwind on its way out: the transaction is still open,
    // which is what lets the caller that OWNS the log decide the run is over.
    expect(log.depth).toBe(1);
    expect(stand.cards.get(CARD)!.columnId).toBe(DOING);

    const { outcome, orphans } = await log.unwind();
    expect(outcome).toBe('rolled-back');
    expect(orphans).toEqual([]);
    expect(stand.cards.get(CARD)!.columnId).toBe(TODO);
  });

  it('an unknown assignee on claim refuses, and writes nothing', async () => {
    // The headline command's headline failure. `AssigneeError` is a refusal
    // because it is one — the retry looks up the same missing name.
    const stand = await startServer();
    await useTracker();

    await expect(
      dispatch('claim', { card: CARD, assignee: 'Nobody Here' }, ctx(stand)),
    ).rejects.toThrow(/Unknown assignee "Nobody Here"/);
    expect(writes(stand.received)).toHaveLength(0);
    expect(stand.cards.get(CARD)!.columnId).toBe(TODO);
  });

  it('a vocabulary role the workspace has no tag for refuses, and writes nothing', async () => {
    // Reachable on any workspace that never ran `tracker init`: the role is in
    // the vocabulary, so `settleAxis` passes it, and `setTags` is where the org
    // turns out not to hold the tag. On a write an unknown name is a tag
    // CREATION, so this must refuse rather than go out as `addTags`.
    const stand = await startServer();
    stand.cards.get(CARD)!.tags = [TAG_BUG, TAG_TRIAGE];

    await expect(
      dispatch('retag', { card: CARD, state: 'wontfix' }, ctx(stand)),
    ).rejects.toThrow(/Unknown tag "wontfix"/);
    expect(writes(stand.received)).toHaveLength(0);
    expect(stand.cards.get(CARD)!.tags).toEqual([TAG_BUG, TAG_TRIAGE]);
  });
});

describe('there is no fourth outcome', () => {
  it('every result carries one of exactly three outcomes', async () => {
    const stand = await startServer();
    const seen = new Set<string>();
    seen.add((await dispatch('create', { name: 'a', board: BOARD }, ctx(stand))).outcome);
    seen.add((await dispatch('probe-fail', {}, ctx(stand))).outcome);
    let seenPuts = 0;
    const hostile = await startServer({
      fail: (r) => {
        if (r.method !== 'PUT') return undefined;
        seenPuts += 1;
        // An unrecognised 403: "Access denied" would be read as already-undone.
        return seenPuts >= 2 ? { status: 403, message: 'Insufficient privileges' } : undefined;
      },
    });
    seen.add((await dispatch('probe-move', { card: CARD, to: 'Doing', thenFail: true }, ctx(hostile))).outcome);

    expect([...seen].sort()).toEqual(['ok', 'rollback-incomplete', 'rolled-back']);
  });
});

// ─── #55: read, and bounded multi-create ─────────────────────────────────────

describe('read is one intent, and it folds in list-children', () => {
  it('a single read answers the bare card and writes nothing', async () => {
    const stand = await startServer();
    const result = await dispatch<ReadResult>('read', { card: CARD }, ctx(stand));

    expect(result.outcome).toBe('ok');
    expect(result.value?.card.cardId).toBe(CARD);
    // Singles stay bare — the envelope belongs to list reads only.
    expect(result.value?.children).toBeUndefined();
    expect(writes(stand.received)).toHaveLength(0);
  });

  it('children come back in the envelope, filtered on parentCardId', async () => {
    const stand = await startServer();
    stand.cards.set('kid-1', card({ cardId: 'kid-1', name: 'Child one', parentCardId: CARD }));
    stand.cards.set('kid-2', card({ cardId: 'kid-2', name: 'Child two', parentCardId: CARD }));
    stand.cards.set('other', card({ cardId: 'other', name: 'Someone else’s child', parentCardId: FAR }));

    const result = await dispatch<ReadResult>('read', { card: CARD, children: true }, ctx(stand));

    expect(result.outcome).toBe('ok');
    expect(result.value?.children?.rows.map((c: Card) => c.cardId).sort()).toEqual(['kid-1', 'kid-2']);
    // Nothing was cut, so no marker — `truncated` must never be present-but-false.
    expect(result.value?.children?.truncated).toBeUndefined();
  });

  it('a card with no children answers an empty envelope, not a missing one', async () => {
    // Unavailable ≠ empty: the read is a single call, so a failure would THROW.
    // An empty `rows` therefore means true-empty, and the agent can act on it.
    const stand = await startServer();
    const result = await dispatch<ReadResult>('read', { card: CARD, children: true }, ctx(stand));

    expect(result.value?.children).toEqual({ rows: [] });
  });

  it('--limit caps the ROWS and says so; it never caps the fetch', async () => {
    const stand = await startServer();
    for (const n of [1, 2, 3]) {
      stand.cards.set(`kid-${n}`, card({ cardId: `kid-${n}`, name: `Child ${n}`, parentCardId: CARD }));
    }

    const result = await dispatch<ReadResult>('read', { card: CARD, children: true, limit: 2 }, ctx(stand));

    expect(result.value?.children?.rows).toHaveLength(2);
    expect(result.value?.children?.truncated).toBe(true);
    // The fetch ran to completion: the wire was asked for the whole board, with
    // no `limit` on it, so the filter above ran over every card and not a page.
    const listed = stand.received.filter((r) => r.method === 'GET' && r.path === '/cards');
    expect(listed).toHaveLength(1);
    expect(listed[0].url).toContain(`widgetCommonId=${BOARD}`);
  });

  it('a read outside the locked collection is not blocked by the scope lock', async () => {
    // The lock guards MUTATION. Making it guard reads would refuse `read` on any
    // card outside the lock, which is the opposite of what the lock is for.
    const stand = await startServer();
    stand.cards.set('elsewhere', card({ cardId: 'elsewhere', widgetCommonId: OTHER_BOARD }));

    const result = await dispatch<ReadResult>('read', { card: 'elsewhere' }, ctx(stand, {
      config: { scopeCollectionId: 'coll-a', scopeCollectionName: 'Collection A' },
    }));
    expect(result.outcome).toBe('ok');
  });

  it('a card with no board instance REFUSES --children, and no unfiltered list is sent', async () => {
    // A fork has no `widgetCommonId`, so `card.boardId` is undefined and
    // `listCards(undefined)` would omit the board filter and paginate the whole
    // ORGANISATION. The assertion is on the request URLs and not on a mock call
    // count on purpose: a test that only checked the throw would still pass if
    // the sweep had already gone out.
    const stand = await startServer();
    const fork = stand.cards.get(CARD)!;
    fork.widgetCommonId = undefined;
    fork.columnId = undefined;

    await expect(
      dispatch<ReadResult>('read', { card: CARD, children: true }, ctx(stand)),
    ).rejects.toThrow(RefusalError);

    const listed = stand.received.filter((r) => r.method === 'GET' && r.path === '/cards');
    expect(listed).toEqual([]);
  });
});

describe('read is reachable as a skill step, where every arg is a STRING', () => {
  it('children:"false" lists nothing — a truthy string is not a yes', async () => {
    const stand = await startServer();
    stand.cards.set('kid-1', card({ cardId: 'kid-1', parentCardId: CARD }));

    const result = await dispatch<ReadResult>('read', { card: CARD, children: 'false' }, ctx(stand));

    expect(result.value?.children).toBeUndefined();
    // And the board sweep the flag would have triggered never left.
    expect(stand.received.filter((r) => r.method === 'GET' && r.path === '/cards')).toEqual([]);
  });

  it('children:"true" lists them — the string form is honoured, not merely tolerated', async () => {
    const stand = await startServer();
    stand.cards.set('kid-1', card({ cardId: 'kid-1', parentCardId: CARD }));

    const result = await dispatch<ReadResult>('read', { card: CARD, children: 'true' }, ctx(stand));

    expect(result.value?.children?.rows.map((c: Card) => c.cardId)).toEqual(['kid-1']);
  });

  it('limit:"2" caps at two rows and marks truncated', async () => {
    const stand = await startServer();
    for (const n of [1, 2, 3]) {
      stand.cards.set(`kid-${n}`, card({ cardId: `kid-${n}`, parentCardId: CARD }));
    }

    const result = await dispatch<ReadResult>(
      'read',
      { card: CARD, children: 'true', limit: '2' },
      ctx(stand),
    );

    expect(result.value?.children?.rows).toHaveLength(2);
    expect(result.value?.children?.truncated).toBe(true);
  });

  it('a limit that is not a positive whole number refuses instead of silently not capping', async () => {
    const stand = await startServer();
    await expect(
      dispatch<ReadResult>('read', { card: CARD, children: 'true', limit: 'two' }, ctx(stand)),
    ).rejects.toThrow(/positive whole number/);
  });
});

describe('multi-create is one bounded transaction over an enumerated list', () => {
  it('creates one card per POST /cards — never the route that does not exist', async () => {
    const stand = await startServer();
    const result = await dispatch<Card[]>('create', {
      cards: [
        { name: 'One', board: BOARD },
        { name: 'Two', board: BOARD, status: 'Doing' },
        { name: 'Three', board: BOARD },
      ],
    }, ctx(stand));

    expect(result.outcome).toBe('ok');
    expect(result.value?.map((c) => c.name)).toEqual(['One', 'Two', 'Three']);
    const posts = writes(stand.received).filter((r) => r.method === 'POST');
    expect(posts.map((r) => r.path)).toEqual(['/cards', '/cards', '/cards']);
    // `POST /cards/bulk` is refused by never being reachable: it does not exist,
    // it answers 200 with an HTML page, and a half-success gives no undo handle.
    expect(stand.received.some((r) => r.path.includes('bulk'))).toBe(false);
    // Composites still ride the one call Favro validates.
    expect(posts[1].body.columnId).toBe(DOING);
    // And the wire really holds them, which a mock could not tell from a no-op.
    expect([...stand.cards.values()].filter((c) => c.name === 'Two')).toHaveLength(1);
  });

  it('a failure part-way through rolls the WHOLE batch back', async () => {
    let posts = 0;
    const stand = await startServer({
      fail: (r) => {
        if (r.method !== 'POST' || r.path !== '/cards') return undefined;
        posts += 1;
        return posts === 3 ? { status: 403, message: 'Invalid column' } : undefined;
      },
    });
    const before = stand.cards.size;

    const result = await dispatch<Card[]>('create', {
      cards: [{ name: 'One', board: BOARD }, { name: 'Two', board: BOARD }, { name: 'Three', board: BOARD }],
    }, ctx(stand));

    expect(result.outcome).toBe('rolled-back');
    expect(result.retryable).toBe(true);
    // Every card created before the failure has its own undo handle, so the
    // wire is back where it started — read back, not counted.
    expect(stand.cards.size).toBe(before);
    expect([...stand.cards.values()].some((c) => c.name === 'One' || c.name === 'Two')).toBe(false);
    expect(writes(stand.received).filter((r) => r.method === 'DELETE')).toHaveLength(2);
  });

  it(`over ${MULTI_CREATE_CAP} refuses, and creates nothing at all`, async () => {
    const stand = await startServer();
    const cards = Array.from({ length: MULTI_CREATE_CAP + 1 }, (_, i) => ({ name: `Card ${i}`, board: BOARD }));

    // A refusal, not a fourth outcome, and not a truncation: creating the first
    // 20 and dropping the 21st would report success for a card that is missing.
    await expect(dispatch('create', { cards }, ctx(stand))).rejects.toThrow(RefusalError);
    expect(writes(stand.received)).toHaveLength(0);
  });

  it('exactly the cap is allowed — the boundary is inclusive', async () => {
    const stand = await startServer();
    const cards = Array.from({ length: MULTI_CREATE_CAP }, (_, i) => ({ name: `Card ${i}`, board: BOARD }));

    const result = await dispatch<Card[]>('create', { cards }, ctx(stand));
    expect(result.outcome).toBe('ok');
    expect(result.value).toHaveLength(MULTI_CREATE_CAP);
  });

  it('an empty list refuses rather than reporting a successful nothing', async () => {
    const stand = await startServer();
    await expect(dispatch('create', { cards: [] }, ctx(stand))).rejects.toThrow(RefusalError);
    expect(writes(stand.received)).toHaveLength(0);
  });

  it('the scope lock is checked on EVERY board in the batch, before anything is written', async () => {
    const stand = await startServer();

    await expect(
      dispatch('create', {
        cards: [{ name: 'In scope', board: BOARD }, { name: 'Out of scope', board: OTHER_BOARD }],
      }, ctx(stand, { config: { scopeCollectionId: 'coll-a', scopeCollectionName: 'Collection A' } })),
    ).rejects.toThrow(ScopeError);

    // Not one card: an in-scope first entry must not smuggle the batch past.
    expect(writes(stand.received)).toHaveLength(0);
  });

  it('--dry-run previews every card in the batch and writes nothing', async () => {
    const stand = await startServer();
    const result = await dispatch('create', {
      cards: [{ name: 'One', board: BOARD }, { name: 'Two', board: BOARD }],
    }, ctx(stand, { dryRun: true }));

    expect(result.preview).toEqual([
      `create card "One" on board ${BOARD}`,
      `create card "Two" on board ${BOARD}`,
    ]);
    expect(writes(stand.received)).toHaveLength(0);
  });

  it('the single form is unchanged — one card in, one bare card out', async () => {
    const stand = await startServer();
    const result = await dispatch<Card>('create', { name: 'Solo', board: BOARD }, ctx(stand));
    expect(result.outcome).toBe('ok');
    expect(Array.isArray(result.value)).toBe(false);
    expect(result.value?.name).toBe('Solo');
  });
});

/** Set inside a `fail` hook that needs the stand it belongs to. */
let standRef: Stand | undefined;
