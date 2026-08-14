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
  MULTI_WRITE_CAP,
  ReadResult,
  RefusalError,
} from '../lib/dispatch';
import { Card } from '../lib/cards-api';
import { CompensationLog, ReadTx, TxCards } from '../lib/tx-cards';
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
  /** The READ-side field. Written only by a body `archive`, never by `archived`. */
  archived?: boolean;
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

function startServer(
  opts: {
    fail?: FailHook;
    afterWrite?: ConcurrentEdit;
    /**
     * A wire that stopped honouring the probed write field: `PUT {archive: …}`
     * answers 200 and changes nothing, which is what the READ-side spelling
     * `archived` does today (#75). Modelled as a stand behaviour rather than a
     * seam on the facade, for the same reason `afterWrite` is: the read-back
     * check has to be verifiable through the door production uses.
     */
    ignoreArchiveWrites?: true;
    /**
     * The same shape for the column write: `PUT {columnId: …}` answers 200 and
     * leaves the card where it was. Nothing has ever observed Favro doing this —
     * it is the hazard `moveColumn`'s read-back exists for, modelled on the far
     * side of the wire so the check is exercised through the door production uses.
     */
    ignoreColumnWrites?: true;
    /**
     * The measured 202 partial (#165): the PUT applies every other field, does
     * NOT apply the column, and answers `202 {"message":"Invalid column"}` — a
     * SUCCESS status carrying a refusal. Measured live 2026-08-14 with
     * `PUT {name, columnId:<bogus>, widgetCommonId:<the card's board>}`, where the
     * name changed anyway, which is what makes 202 mean "at least one field was
     * refused" rather than "nothing happened". The board belongs in the recipe:
     * without it the same write answers `202 "Access denied"` instead (#162).
     *
     * Distinct from `ignoreColumnWrites` on purpose: that one is the silent
     * family the read-backs exist for, this one is the loud family the wire
     * boundary exists for, and a stand that could only express the first is why
     * a green suite contained both of this release's CRITICALs.
     */
    refuseColumnWith202?: true;
    /**
     * A PUT response that says nothing about `columnId`, on a write that DID
     * land. This is the arm with teeth (#101): `columnId` on a PUT response has
     * never been probed, so a check reading the echo cannot pass here, while a
     * check re-reading the card can. Without this option every PUT answers with a
     * card row we wrote ourselves, and a read-back tested against that verifies
     * our own assumption against itself — the trap `write-echo-wire.test.ts`
     * describes.
     */
    stripColumnEcho?: true;
    /**
     * Kill the connection instead of answering — a genuine transport failure.
     *
     * The only way to produce the error axios raises when there is NO response
     * at all: `isAxiosError` is stamped, `error.response` is absent. A canned
     * `{status}` object cannot reach that arm of `isWireFailure`, and neither can
     * the `fail` hook above, so this is the one hook that proves a network reset
     * is still read as transient.
     */
    resetOn?: (r: Received) => boolean;
  } = {},
): Promise<Stand> {
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

      if (opts.resetOn?.(r)) {
        req.socket.destroy();
        return;
      }

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
          if (b.columnId !== undefined && !opts.ignoreColumnWrites && !opts.refuseColumnWith202) {
            next.columnId = b.columnId;
          }
          // The measured asymmetry (#75), modelled where it actually lives: the
          // wire honours the WRITE field `archive` and answers 200-and-nothing to
          // the READ field `archived`. Modelling only the honoured half would let
          // the wrong spelling pass every test in this file.
          if (typeof b.archive === 'boolean' && !opts.ignoreArchiveWrites) next.archived = b.archive;
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
          // Everything else this PUT carried is already applied above; only the
          // column was refused. That asymmetry IS the measurement.
          if (b.columnId !== undefined && opts.refuseColumnWith202) {
            concurrently();
            return send(202, { message: 'Invalid column' });
          }
          // The echo is snapshotted BEFORE the concurrent editor runs. A real
          // server serialises the response from its own write's state, not from a
          // re-read, so an edit that `afterWrite` places "between our write and
          // our detecting read" cannot leak into the response to that write.
          // Leaving it live made a concurrent edit indistinguishable from a 200
          // that wrote nothing, which `setArchived`'s read-back has to tell apart.
          const echo = wire(next);
          if (opts.stripColumnEcho) delete echo.columnId;
          concurrently();
          return send(200, echo);
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
    board: async (a: any, tx: ReadTx) => (await tx.getCard(a.card)).boardId,
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
    board: async (a: any, tx: ReadTx) => (await tx.getCard(a.card)).boardId,
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
    board: async (a: any, tx: ReadTx) => (await tx.getCard(a.card)).boardId,
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
    board: async (a: any, tx: ReadTx) => (await tx.getCard(a.card)).boardId,
    run: async (a: any, tx: TxCards) => {
      await tx.moveColumn(a.card, a.to);
      await tx.setTags(a.card, a.tags);
      throw new Error('probe failure after two ops');
    },
  });
  registerIntent({
    name: 'probe-refuse-after-write',
    summary: 'writes, then refuses deterministically',
    preview: (a: any) => [`move ${a.card}, then refuse`],
    board: async (a: any, tx: ReadTx) => (await tx.getCard(a.card)).boardId,
    run: async (a: any, tx: TxCards) => {
      await tx.moveColumn(a.card, a.to);
      throw new RefusalError('probe refuses, after writing');
    },
  });
  registerIntent({
    name: 'probe-archive',
    summary: 'move a card across the archive line, optionally failing afterwards',
    preview: (a: any) => [`archive ${a.card} = ${a.archived}`],
    board: async (a: any, tx: ReadTx) => (await tx.getCard(a.card)).boardId,
    run: async (a: any, tx: TxCards) => {
      await tx.setArchived(a.card, a.archived);
      if (a.thenFail) throw new Error('probe failure after the archive write');
      return {};
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
  it('the intents named by the spec are all registered', () => {
    // The original seven. Frontier-listing was cut (subsumed by `--filter`) and
    // list-children folded into `read`. `delete` (#73) is the eighth and the
    // first irreversible one — see the terminal-intent block at the foot of
    // this file for what that costs. `archive` (#75) is the ninth and the
    // reversible sibling of it — one intent carrying a direction, not two.
    for (const name of [
      'create',
      'read',
      'delete',
      'archive',
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
    // Incidental to this test, which is about the LIFO unwind. `probe-chain`
    // throws a bare in-process `Error`, and `retryAdvice` gates on the wire, so
    // the advice is `false` — pinned deliberately, see the dedicated test in
    // "a deterministic WIRE refusal is not retryable either (#66)".
    expect(result.retryable).toBe(false);
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
    let written = false;
    let cardGetsAfterWrite = 0;
    const stand = await startServer({
      fail: (r) => {
        if (r.method === 'PUT' && r.path === `/cards/${CARD}`) written = true;
        // A human moves the card to Done between our write and the rollback's
        // detecting read. There is no version carrier on the wire, so this read
        // is the only guard available.
        //
        // Which post-write read matters is now specific: `moveColumn` confirms
        // its own write with a re-read (#101), so GET 1 is that confirmation —
        // it must see OUR column, or the move itself fails and this compare is
        // never reached (the failure arm has its own test). GET 2 is the
        // rollback's detecting read, which is the guard under test here.
        if (written && r.method === 'GET' && r.path === `/cards/${CARD}`) {
          cardGetsAfterWrite += 1;
          const held = standRef?.cards.get(CARD);
          if (cardGetsAfterWrite === 2 && held && held.columnId === DOING) held.columnId = DONE;
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
    // to clobber. Reporting an ORPHAN here would send an agent to inspect
    // wreckage that does not exist — which is what the empty list below pins.
    // (`retryable` is a different question and answers `false`; `reportDispatch`
    // still says "nothing was left behind" on a `rolled-back` either way.)
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
    expect(result.retryable).toBe(false);
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
      { columnId: DOING, widgetCommonId: BOARD },
    ]);
    expect(stand.cards.get(CARD)!.assignments).toEqual([{ userId: ALICE }]);
    expect(stand.cards.get(CARD)!.columnId).toBe(DOING);
  });

  it('resolve moves the card to the mapped done column in one call', async () => {
    const stand = await startServer();
    await useTracker();

    const result = await dispatch<{ columnId?: string }>('resolve', { card: CARD }, ctx(stand));

    expect(result.outcome).toBe('ok');
    expect(puts(stand.received).map((r) => r.body)).toEqual([
      { columnId: DONE, widgetCommonId: BOARD },
    ]);
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

describe('a column move is confirmed by RE-READING the card, never by the PUT echo (#101)', () => {
  /**
   * CEILING, stated so nothing here is over-read: none of this measures what
   * Favro's `PUT /cards/{id} {columnId}` actually echoes. What it pins is that
   * the code does not DEPEND on that echo — it passes whether the response
   * carries the column or says nothing about it, and it fails when the card did
   * not move. That is the whole claim, and it needs no probe to hold.
   */
  it('the stand under stripColumnEcho answers a PUT with no columnId, and still moves the card', async () => {
    // Proof the arm below is not vacuous: without this, `stripColumnEcho` could
    // silently do nothing and every assertion under it would still pass off the
    // full echo.
    const stand = await startServer({ stripColumnEcho: true });

    const echo = await stand.client.put<Record<string, unknown>>(`/cards/${CARD}`, { columnId: DONE });

    expect('columnId' in echo).toBe(false);
    expect(stand.cards.get(CARD)!.columnId).toBe(DONE);
  });

  it('the stand under ignoreColumnWrites answers 200 and leaves the card where it was', async () => {
    const stand = await startServer({ ignoreColumnWrites: true });

    await stand.client.put(`/cards/${CARD}`, { columnId: DONE });

    expect(stand.cards.get(CARD)!.columnId).toBe(TODO);
  });

  it.each([
    ['resolve', {}, DONE],
    ['claim', { assignee: ALICE }, DOING],
  ] as Array<[string, Record<string, unknown>, string]>)(
    '%s reports the column it re-read, on a wire whose PUT echoes no column',
    async (intent, extra, expected) => {
      const stand = await startServer({ stripColumnEcho: true });
      await useTracker();

      const result = await dispatch<{ cardId: string; columnId?: string }>(
        intent, { card: CARD, ...extra }, ctx(stand),
      );

      expect(result.outcome).toBe('ok');
      // **THE assertion.** Read off the PUT response, this is `undefined`, and
      // `cards-tracker.ts` prints `(column —)` for a move that landed. No
      // assertion about the stored card can catch that — the card DID move — so
      // this is the envelope a consumer receives, which is the contract.
      //
      // Stated no wider than it is: on an `ok` outcome the read-back has already
      // forced the observed column and the requested one to be equal, so this
      // cannot tell an observation from an argument echo. It pins that the field
      // is POPULATED without the PUT echo, which is what the old shape got wrong.
      // The distinction is pinned by the failure arms below, where the two differ.
      expect(result.value?.columnId).toBe(expected);
      expect(stand.cards.get(CARD)!.columnId).toBe(expected);
    },
  );

  it('a 200 that left the card where it was is a LOUD failure, not a ✓ about the argument', async () => {
    const stand = await startServer({ ignoreColumnWrites: true });
    await useTracker();

    const result = await dispatch('resolve', { card: CARD }, ctx(stand));

    expect(result.outcome).toBe('rolled-back');
    expect(result.error).toMatch(/was accepted with no denial message but the card did not land there/);
    // The message names the OBSERVED column, not just the requested one — an
    // assertion on the throw alone would pass on the wrong throw.
    expect(result.error).toContain(`a re-read of the card reads columnId="${TODO}"`);
    // Nothing to compensate: the check runs before the log push, so the unwind
    // had nothing to leave behind.
    expect(result.orphans).toBeUndefined();
    // Transient, like the archive read-back: the call is fine, the wire changed.
    expect(result.retryable).toBe(true);
    // Exactly one PUT — ours. No compensating write for a write that did nothing.
    expect(puts(stand.received)).toHaveLength(1);
    expect(stand.cards.get(CARD)!.columnId).toBe(TODO);
  });

  it('the move failing takes the assignment with it — claim still unwinds what it wrote first', async () => {
    // Throwing BEFORE the column entry is pushed must not cost the entries
    // pushed before that: `claim` assigns, then moves.
    const stand = await startServer({ ignoreColumnWrites: true });
    await useTracker();

    const result = await dispatch('claim', { card: CARD, assignee: ALICE }, ctx(stand));

    expect(result.outcome).toBe('rolled-back');
    expect(result.error).toMatch(/did not land there/);
    expect(stand.cards.get(CARD)!.assignments).toEqual([]);
    expect(puts(stand.received).map((r) => r.body)).toEqual([
      { addAssignmentIds: [ALICE] },
      { columnId: DOING, widgetCommonId: BOARD },
      { removeAssignmentIds: [ALICE] },
    ]);
  });

  it('a concurrent editor who moved the card elsewhere surfaces as the same failure', async () => {
    // The second cause the message names. There is no version carrier on this
    // wire, so a 200-and-nothing and a human moving the card between our write
    // and our read are indistinguishable — and either way nothing was logged, so
    // no compensating write goes out over their move.
    const stand = await startServer({
      afterWrite: ({ cards }, wrote) => {
        if (wrote !== 1) return;
        cards.get(CARD)!.columnId = TODO;
      },
    });
    await useTracker();

    const result = await dispatch('resolve', { card: CARD }, ctx(stand));

    expect(result.outcome).toBe('rolled-back');
    expect(result.error).toMatch(/did not land there/);
    expect(puts(stand.received)).toHaveLength(1);
    expect(stand.cards.get(CARD)!.columnId).toBe(TODO);
  });

  it('a re-read carrying NO column is a failure, not a pass — absent is not "where we asked"', async () => {
    // `Card.columnId` is OPTIONAL, and the entity that has none is real: an
    // assignment fork carries no `widgetCommonId` and no `columnId`. `claim` and
    // `resolve` cannot reach one — `trackerCard` refuses a boardless card before
    // either writes — but `moveColumn` is a facade op any intent may call on any
    // `cardId`, so the comparison has to hold absent-is-not-equal on its own.
    //
    // Without this arm the guard could be written `after.columnId !== undefined &&
    // after.columnId !== columnId` and the whole suite stayed green: measured, 173
    // suites and 3648 tests passed with the absent case failing OPEN. That is the
    // fail-closed direction ADR-0003 and this facade both require, and it was the
    // one direction nothing asserted.
    const stand = await startServer({
      afterWrite: ({ cards }, wrote) => {
        if (wrote !== 1) return;
        delete cards.get(CARD)!.columnId;
      },
    });

    const result = await dispatch('probe-move', { card: CARD, to: 'Doing' }, ctx(stand));

    expect(result.outcome).toBe('rolled-back');
    expect(result.error).toMatch(/was accepted with no denial message but the card did not land there/);
    // The message reports the absence as an absence, not as an empty string.
    expect(result.error).toContain('a re-read of the card reads columnId=undefined');
    // Nothing logged, so no compensating write went out at a card with no column.
    expect(puts(stand.received)).toHaveLength(1);
  });

  it('a confirmation read that FAILS keeps the compensation entry — the write may have landed', async () => {
    // The window the re-read opens, and the one the two causes above do not
    // cover. `getCard` can fail for reasons that say nothing about the write:
    // 500, 429, a reset. The PUT already went out and 200'd, so "we could not
    // look" is not "nothing was written" — and dropping the entry there reports
    // `rolled-back`, which this codebase defines as the world being genuinely
    // back where it was, for a card still sitting in the new column.
    //
    // So an unreadable confirmation keeps the entry and lets the unwind's own
    // compare decide: it re-reads, finds our column, and restores. `claim` is
    // the sharper caller — without the entry its assignment is undone while its
    // column move survives, which is neither state the caller asked for.
    let written = false;
    let refused = false;
    const stand = await startServer({
      // A 4xx the classifier does not know, deliberately: `http-client` retries
      // every 5xx and every response-less failure four times, so a 500 or a
      // destroyed socket costs ~15s of backoff to express the same window.
      fail: (r) => {
        if (r.method === 'PUT' && r.body?.columnId !== undefined) written = true;
        if (written && !refused && r.method === 'GET' && r.path === `/cards/${CARD}`) {
          refused = true;
          return { status: 400, message: 'Malformed backend response' };
        }
        return undefined;
      },
    });
    await useTracker();

    const result = await dispatch('claim', { card: CARD, assignee: ALICE }, ctx(stand));

    expect(result.outcome).toBe('rolled-back');
    // The read failed, so the error is the wire's — not a claim about the card.
    expect(result.error).not.toMatch(/did not land there/);
    // Both writes are undone, newest first, and the card ends where it started.
    expect(puts(stand.received).map((r) => r.body)).toEqual([
      { addAssignmentIds: [ALICE] },
      { columnId: DOING, widgetCommonId: BOARD },
      // The unwind carries the board too. It has to: `applyInverse` is a column
      // write like any other, and without `widgetCommonId` Favro denies it with a
      // 202 the stack reads as success — so before #162 this rollback could not
      // land, on the one path whose whole job is landing.
      { columnId: TODO, widgetCommonId: BOARD },
      { removeAssignmentIds: [ALICE] },
    ]);
    expect(stand.cards.get(CARD)!.columnId).toBe(TODO);
    expect(stand.cards.get(CARD)!.assignments).toEqual([]);
    expect(result.orphans).toBeUndefined();
  });
});

/**
 * The 2xx-denial boundary, driven through the table (#165).
 *
 * Favro refuses some writes with a SUCCESS status and the reason in the body.
 * Every stand above answers 200-or-4xx, which is the structural reason a green
 * suite could contain both of this release's CRITICALs, so `refuseColumnWith202`
 * models the measured shape instead: the PUT applies what it accepted, refuses
 * the column, and answers `202 {"message":"Invalid column"}`.
 *
 * The read-back arms above are NOT replaced by this — they are the only cover
 * for the family that answers a clean 200 with a full entity and no effect, and
 * `ignoreColumnWrites` is what still drives them.
 */
describe('a 2xx carrying a denial refuses, and takes the transaction with it (#165)', () => {
  it('the denial is a REFUSAL, not a success — and never advertised as retryable', async () => {
    const stand = await startServer({ refuseColumnWith202: true });
    await useTracker();

    const result = await dispatch('resolve', { card: CARD }, ctx(stand));

    expect(result.outcome).toBe('rolled-back');
    // Favro's own words, quoted rather than paraphrased: the vocabulary is open.
    expect(result.error).toContain('Invalid column');
    // The whole point. `moveColumn`'s read-back called this same wire answer
    // transient and told an agent to retry a write that refuses identically
    // forever; the boundary throw is a `RefusalError`, so it cannot.
    expect(result.retryable).toBe(false);
    expect(stand.cards.get(CARD)!.columnId).toBe(TODO);
  });

  it('a threaded transaction UNWINDS around it, rather than propagating untouched', async () => {
    // The collision this ticket had to handle. `dispatch`'s fast path propagates
    // a `RefusalError` raised before this invocation wrote anything, on the
    // reading that a refusal means nothing was written — and a 202 means "at
    // least one field was refused", never "nothing happened". So the earlier
    // steps of the transaction would have been left standing while the refusal
    // sailed past, which is this ticket's own defect class in the repair.
    const stand = await startServer({ refuseColumnWith202: true });
    await useTracker();
    const log = new CompensationLog();

    const renamed = await dispatch('update', { card: CARD, name: 'renamed' }, ctx(stand, { log }));
    expect(renamed.outcome).toBe('ok');
    expect(stand.cards.get(CARD)!.name).toBe('renamed');

    // A SECOND invocation over the same log, whose first write is the denied
    // one — so this invocation's own log depth never moves, which is exactly the
    // condition the fast path keys on.
    const refused = await dispatch('update', { card: CARD, status: 'Done' }, ctx(stand, { log }));

    expect(refused.outcome).toBe('rolled-back');
    expect(refused.retryable).toBe(false);
    // **THE assertion**: the earlier write is gone. Under the fast path this
    // dispatch threw and the rename survived.
    expect(stand.cards.get(CARD)!.name).toBe('A card');
  });

  it('the report says the applied half is not compensated, rather than claiming a clean rollback', async () => {
    // `rolled-back` is the outcome vocabulary's closest word and it overstates
    // what happened, because a field the 202 DID apply was never logged.
    //
    // **On `result.error`, deliberately.** `dispatch` reports
    // `failureMessage(error)`, which prefers the classifier's wording and DROPS
    // the thrown error's own — so a sentence written onto `WireRefusalError`
    // reaches a reader of the exception and never reaches this envelope, which
    // is what an agent actually reads. It was written there first and this arm
    // is why it moved.
    const stand = await startServer({ refuseColumnWith202: true });
    await useTracker();

    const result = await dispatch('resolve', { card: CARD }, ctx(stand));

    expect(result.error).toContain('refuses at least ONE field of the request');
    expect(result.error).toContain('is not logged for compensation, so an unwinding transaction');
    expect(result.error).toContain('Read the card back before deciding what to do');
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

describe('a deterministic WIRE refusal is not retryable either (#66)', () => {
  /**
   * Three creates where the wire refuses the third. The unwind always succeeds
   * — the two earlier cards are deleted — so the OUTCOME is `rolled-back` every
   * time and the only thing under test is the retry advice that rides with it.
   */
  async function batchRefusedBy(status: number, message: string) {
    let posts = 0;
    const stand = await startServer({
      fail: (r) => {
        if (r.method !== 'POST' || r.path !== '/cards') return undefined;
        posts += 1;
        return posts === 3 ? { status, message } : undefined;
      },
    });
    const before = stand.cards.size;
    const result = await dispatch<Card[]>('create', {
      cards: [{ name: 'One', board: BOARD }, { name: 'Two', board: BOARD }, { name: 'Three', board: BOARD }],
    }, ctx(stand));
    // Read back, not counted: the world really is where it started.
    expect(result.outcome).toBe('rolled-back');
    expect(stand.cards.size).toBe(before);
    return result;
  }

  it.each([
    ['a bad-input rejection', 403, 'Invalid column'],
    ['an already-exists conflict', 403, 'Dependency already exists'],
    ['an unrecognised 403, refused as permission', 403, 'Insufficient privileges'],
    ['a missing target', 403, 'Access denied'],
    ['rejected credentials', 401, 'Bad token'],
  ])('%s rolls back cleanly and is still NOT retryable', async (_what, status, message) => {
    // The whole point of #66: a clean unwind says the world is unchanged, which
    // is NOT the same as saying the call is worth making again. Every message
    // here is one Favro will send again, verbatim, for the same request — an
    // agent told "safe to retry" would create, be refused, unwind, forever.
    const result = await batchRefusedBy(status, message);
    expect(result.retryable).toBe(false);
  });

  it('a failure we cannot NAME on a 4xx is NOT retryable — the status decides (#162)', async () => {
    // **PINNED `false`. It was pinned `true` until #162 — do not flip it back
    // without reading this.**
    //
    // The old reading: anything the closed message set cannot name keeps the
    // rolled-back-is-retryable reading, because the world IS back where it
    // started and the next call may well behave differently. True of a 5xx and a
    // timeout. Not true of a 4xx, where the REQUEST is what was rejected —
    // measured live, `PUT /cards/{id} {name: <1115 chars>}` answers `400 "Card
    // can't have more than 1024 characters."` on every run, and this arm is what
    // let `cards update` print `"retryable": true` and *"safe to retry"* over it
    // on two identical runs.
    //
    // The transient half of the rule keeps its own arms: the status matrix in
    // `favro-error.test.ts` (408/429/5xx, no wire, no backoff) and the socket
    // reset below, which is the one shape no canned `{status}` can reach.
    const result = await batchRefusedBy(400, 'Something we have never probed');
    expect(result.retryable).toBe(false);
  });

  it('the SAME unnameable failure is not retryable once the unwind left an orphan', async () => {
    // The outcome arm, isolated. Every other `rollback-incomplete` test in this
    // file has a cause `isRetryable` rejects anyway — a 403, a refusal — so the
    // guard that actually stops an orphan from being called retryable
    // (`outcome !== 'rolled-back'`) was never the reason any of them was `false`.
    // Measured: hardcoding `retryAdvice`'s outcome argument to `'rolled-back'`
    // passed all 3036 other tests. This is the one that kills that mutation.
    //
    // The CAUSE has to read retryable on its own or this proves nothing, and
    // since #162 that means a status `isTransientStatus` accepts — a 503, where
    // the arm above now takes the 400. `http-client` retries a 503 four times at
    // 1/2/4/8s before giving up, so this test costs ~15s; that is also why the
    // compensating write is refused with a 403 rather than a second 503, which
    // would buy a second round of backoff for nothing.
    //
    // Keyed on the BODY, not on a PUT counter: the retries make a counter
    // meaningless. The tag write is the PUT carrying `addTagIds`; the
    // compensating move-back is the one carrying `columnId` after it.
    let sawTagWrite = false;
    const stand = await startServer({
      fail: (r) => {
        if (r.method !== 'PUT') return undefined;
        const body = (r.body ?? {}) as { addTagIds?: unknown; columnId?: unknown };
        if (body.addTagIds) {
          sawTagWrite = true;
          return { status: 503, message: 'Something we have never probed' };
        }
        // The move landed first. This is the compensating move-back, refused so
        // the column stays where we put it and the orphan is real. NOT "Access
        // denied", which `alreadyGone` forgives as "the card is gone anyway" and
        // which therefore leaves no orphan at all.
        return sawTagWrite && body.columnId ? { status: 403, message: 'Insufficient privileges' } : undefined;
      },
    });

    const result = await dispatch('probe-chain', { card: CARD, to: 'Doing', tags: ['bug'] }, ctx(stand));

    expect(result.outcome).toBe('rollback-incomplete');
    expect(result.retryable).toBe(false);
    // Read back, not counted: the wreckage the advice is about really is there.
    expect(stand.cards.get(CARD)!.columnId).toBe(DOING);
    expect(result.orphans?.map((o) => o.field)).toEqual(['columnId']);
  }, 40000);

  it('a 429 mid-batch is absorbed by the client, not turned into an unwind', async () => {
    // #67 deleted the only assertion that pinned 429 through the multi-create
    // path. `http-client` retries 429 generically, but nothing proved these
    // POSTs go through it — a raw client here would abort a transaction that
    // Favro merely asked us to slow down, and every earlier card would be
    // deleted for nothing. One transient 429 on the second create: all three
    // cards must exist and the outcome must be `ok`.
    let posts = 0;
    const stand = await startServer({
      fail: (r) => {
        if (r.method !== 'POST' || r.path !== '/cards') return undefined;
        posts += 1;
        return posts === 2 ? { status: 429, message: 'Rate limit exceeded' } : undefined;
      },
    });
    const before = stand.cards.size;
    const result = await dispatch<Card[]>('create', {
      cards: [{ name: 'One', board: BOARD }, { name: 'Two', board: BOARD }, { name: 'Three', board: BOARD }],
    }, ctx(stand));

    expect(result.outcome).toBe('ok');
    expect(stand.cards.size).toBe(before + 3);
  }, 20000);

  it('a plain in-process failure after a write is NOT retryable', async () => {
    // **PINNED `false`. It was pinned `true` on purpose until now — do not flip
    // it back without reading this.**
    //
    // Same discriminator from the other side: `probe-chain` throws an ordinary
    // `Error` carrying no HTTP response at all. The old reading was that the
    // table's population is narrow — everything it sees was raised inside a write
    // it instrumented — so unclassifiable there means a wire hiccup and the next
    // attempt may behave differently.
    //
    // Narrow is not clean. `intent.run` is OUR code: a `TypeError` of ours, or
    // any deterministic bare `Error` a future op raises, took that same arm and
    // came back "safe to retry" — which is exactly the `--include bogus` defect
    // #134 fixed at the CLI boundary and #151 fixed at the skill engine's unwind,
    // surviving at the third site because inverting the default here would break
    // the in-process failures that genuinely ARE transient.
    //
    // The carried-forward half of #151 enumerated those: the read-backs in
    // `TxCards`, each saying so with a `TransientError` — the archive one in
    // `setArchived`, pinned `true` by "a 200 that did not take is a LOUD
    // failure", and the column one in `moveColumn` (#101), pinned by "a 200 that
    // left the card where it was". With those marked, `retryAdvice` gates all three callers on the
    // wire and an unmarked in-process failure is deterministic-until-proven-
    // otherwise: a wrong `false` costs one honest failure, a wrong `true` costs
    // an agent looping forever.
    const stand = await startServer();
    const result = await dispatch('probe-chain', { card: CARD, to: 'Doing', tags: ['bug'] }, ctx(stand));

    expect(result.outcome).toBe('rolled-back');
    expect(result.retryable).toBe(false);
  });

  it('a socket the server killed mid-transaction is still retryable', async () => {
    // The other half of the same change, and the dangerous half: narrowing the
    // advice must not narrow it onto a REAL transient. A connection reset is the
    // arm no canned `{status}` object can reach — axios stamps `isAxiosError` and
    // attaches no `response` at all — so `retryAdvice` would answer `false` here
    // if its gate asked `classifyThrownError(...) !== undefined` instead of
    // `isWireFailure`. That mistake is invisible to every other test in this file:
    // each one either carries a status or never touches the wire.
    //
    // A real destroyed socket, not a mocked rejection: the point is the error
    // object axios actually builds. `http-client` retries a response-less failure
    // four times at 1/2/4/8s before giving up, so this costs ~15s once.
    const stand = await startServer({
      // AFTER the move has landed, so there is something to unwind: the tag
      // write's GET is the first request the reset can take.
      resetOn: (r) => r.method === 'GET' && r.path === '/tags',
    });

    const result = await dispatch('probe-chain', { card: CARD, to: 'Doing', tags: ['bug'] }, ctx(stand));

    expect(result.outcome).toBe('rolled-back');
    expect(result.retryable).toBe(true);
    // Read back, not counted: the move really was undone before the advice was
    // given, which is the other half of what `retryable` is allowed to claim.
    expect(stand.cards.get(CARD)!.columnId).toBe(TODO);
  }, 30000);

  it('a refusal raised AFTER this invocation wrote unwinds, and is not retryable', async () => {
    // A `RefusalError` before the first write throws (covered above). Raised
    // after one, it unwinds like any failure — but it is still the deterministic
    // decline it always was, so the advice must not flip just because an orphan
    // check happened to pass.
    const stand = await startServer();
    const result = await dispatch('probe-refuse-after-write', { card: CARD, to: 'Doing' }, ctx(stand));

    expect(result.outcome).toBe('rolled-back');
    expect(result.retryable).toBe(false);
    expect(stand.cards.get(CARD)!.columnId).toBe(TODO);
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
    ).rejects.toThrow(/whole number of 1 or more/);
  });

  it.each(['1e9', '0x10', '5.0', '0', '-1'])(
    'the dispatch surface speaks the FLAG grammar, so limit:%p refuses too',
    async (limit) => {
      // This arm used to be `Number(v)` guarded by `Number.isInteger`, a second
      // `--limit` dialect: `1e9` was 1000000000 here and a refusal on every CLI
      // site, `0x10` was 16, `5.0` was 5. One parser means one answer. Found in
      // review of #142/#143.
      const stand = await startServer();
      await expect(
        dispatch<ReadResult>('read', { card: CARD, children: 'true', limit }, ctx(stand)),
      ).rejects.toThrow(/whole number of 1 or more/);
    },
  );

  it('a NUMERIC limit still has its own guard, because a JSON call can send one', async () => {
    const stand = await startServer();
    // `0` matters: `capRows` reads a numeric 0 as NO cap, so letting it through
    // would return every child — the exact #142 shape.
    await expect(
      dispatch<ReadResult>('read', { card: CARD, children: 'true', limit: 0 }, ctx(stand)),
    ).rejects.toThrow(/whole number of 1 or more/);
    await expect(
      dispatch<ReadResult>('read', { card: CARD, children: 'true', limit: 2.5 }, ctx(stand)),
    ).rejects.toThrow(/whole number of 1 or more/);
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
    // NOT retryable, even though the unwind was clean: `403 "Invalid column"` is
    // a bad-input rejection, so the identical batch is refused identically (#66).
    expect(result.retryable).toBe(false);
    // Every card created before the failure has its own undo handle, so the
    // wire is back where it started — read back, not counted.
    expect(stand.cards.size).toBe(before);
    expect([...stand.cards.values()].some((c) => c.name === 'One' || c.name === 'Two')).toBe(false);
    expect(writes(stand.received).filter((r) => r.method === 'DELETE')).toHaveLength(2);
  });

  it(`over ${MULTI_WRITE_CAP} refuses, and creates nothing at all`, async () => {
    const stand = await startServer();
    const cards = Array.from({ length: MULTI_WRITE_CAP + 1 }, (_, i) => ({ name: `Card ${i}`, board: BOARD }));

    // A refusal, not a fourth outcome, and not a truncation: creating the first
    // 20 and dropping the 21st would report success for a card that is missing.
    await expect(dispatch('create', { cards }, ctx(stand))).rejects.toThrow(RefusalError);
    expect(writes(stand.received)).toHaveLength(0);
  });

  it('exactly the cap is allowed — the boundary is inclusive', async () => {
    const stand = await startServer();
    const cards = Array.from({ length: MULTI_WRITE_CAP }, (_, i) => ({ name: `Card ${i}`, board: BOARD }));

    const result = await dispatch<Card[]>('create', { cards }, ctx(stand));
    expect(result.outcome).toBe('ok');
    expect(result.value).toHaveLength(MULTI_WRITE_CAP);
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

// ─── delete: the one irreversible intent (#73) ───────────────────────────────

describe('delete removes ONE board instance, and says so on the wire', () => {
  /** Every DELETE that actually reached the stand-in, card-scoped only. */
  const deletes = (stand: Stand) =>
    stand.received.filter((r) => r.method === 'DELETE' && /^\/cards\/[^/]+$/.test(r.path));

  it('sends DELETE /cards/{cardId} with NO everywhere param, and the card is gone', async () => {
    const stand = await startServer();

    const result = await dispatch<{ cardId: string; boardId?: string }>('delete', { card: CARD }, ctx(stand));

    expect(result.outcome).toBe('ok');
    expect(result.value?.cardId).toBe(CARD);
    expect(result.value?.boardId).toBe(BOARD);

    const sent = deletes(stand);
    expect(sent).toHaveLength(1);
    expect(sent[0].path).toBe(`/cards/${CARD}`);
    // THE instance-vs-card pin. `?everywhere=true` is what removes every
    // instance of a cardCommonId; omitting it is what makes this an
    // instance-scoped delete, and it is the only thing on the wire that says
    // so. A mock of `CardsAPI` could not see this at all.
    expect(sent[0].url).not.toContain('everywhere');

    // Read the state back rather than counting calls: Favro answers 200 for
    // writes it does not perform, so "we sent it" is not "it happened".
    expect(stand.cards.has(CARD)).toBe(false);
    // The sibling instance is untouched — that is the whole claim of the flag
    // we did not send.
    expect(stand.cards.has(FAR)).toBe(true);
  });

  it('--dry-run previews the irreversibility and sends no DELETE', async () => {
    const stand = await startServer();

    const result = await dispatch('delete', { card: CARD }, ctx(stand, { dryRun: true }));

    expect(result.outcome).toBe('ok');
    expect(result.preview?.join(' ')).toMatch(/IRREVERSIBLE/);
    expect(result.preview?.join(' ')).toMatch(/ONE board instance/);
    expect(deletes(stand)).toHaveLength(0);
    expect(stand.cards.has(CARD)).toBe(true);
  });
});

describe('delete is behind the scope lock, and the lock fails CLOSED', () => {
  const deletes = (stand: Stand) =>
    stand.received.filter((r) => r.method === 'DELETE' && /^\/cards\/[^/]+$/.test(r.path));

  const locked = (stand: Stand, extra: Partial<DispatchContext> = {}): DispatchContext =>
    ctx(stand, { config: { scopeCollectionId: 'coll-a', scopeCollectionName: 'Collection A' }, ...extra });

  it('a card on a board outside the lock refuses BEFORE any DELETE is sent', async () => {
    const stand = await startServer();
    stand.cards.get(CARD)!.widgetCommonId = OTHER_BOARD;

    await expect(dispatch('delete', { card: CARD }, locked(stand))).rejects.toThrow(ScopeError);

    expect(deletes(stand)).toHaveLength(0);
    expect(stand.cards.has(CARD)).toBe(true);
  });

  it('a boardless card — the fork shape — refuses rather than failing open', async () => {
    // CEILING, same one as the `claim` fork test above: the stand-in never
    // actually forks on `addAssignmentIds`; the fork is planted BY HAND here.
    // What this pins is that a card with no `widgetCommonId` is refused, not
    // that Favro produces one where we think it does — that half is probe
    // knowledge (#54), not something this seam can observe.
    const stand = await startServer();
    stand.cards.get(CARD)!.widgetCommonId = undefined;
    stand.cards.get(CARD)!.columnId = undefined;

    await expect(dispatch('delete', { card: CARD }, locked(stand))).rejects.toThrow(RefusalError);

    expect(deletes(stand)).toHaveLength(0);
    expect(stand.cards.has(CARD)).toBe(true);
  });

  it('--force does NOT rescue a boardless delete — there is no board to know about', async () => {
    const stand = await startServer();
    stand.cards.get(CARD)!.widgetCommonId = undefined;
    stand.cards.get(CARD)!.columnId = undefined;

    await expect(
      dispatch('delete', { card: CARD }, locked(stand, { force: true })),
    ).rejects.toThrow(RefusalError);

    expect(deletes(stand)).toHaveLength(0);
    expect(stand.cards.has(CARD)).toBe(true);
  });

  it('a card inside the locked collection proceeds', async () => {
    const stand = await startServer();
    const result = await dispatch('delete', { card: CARD }, locked(stand));
    expect(result.outcome).toBe('ok');
    expect(stand.cards.has(CARD)).toBe(false);
  });
});

describe('delete logs nothing, and therefore cannot join a transaction', () => {
  const deletes = (stand: Stand) =>
    stand.received.filter((r) => r.method === 'DELETE' && /^\/cards\/[^/]+$/.test(r.path));

  it('refuses on an EMPTY caller-threaded log — the writes come AFTER the delete', async () => {
    // The direction a depth check cannot see. `delete` pushes no compensation
    // entry, so a threaded log is still at depth 0 afterwards and every write
    // that follows is unguarded: create, then fail, and the run reports
    // `rolled-back / retryable` while the deleted card stays gone forever.
    // Nothing inside this invocation can know whether a later write is coming,
    // so a threaded log AT ALL is refused.
    const stand = await startServer();
    const log = new CompensationLog();

    await expect(dispatch('delete', { card: CARD }, ctx(stand, { log }))).rejects.toThrow(RefusalError);

    expect(deletes(stand)).toHaveLength(0);
    expect(stand.cards.has(CARD)).toBe(true);
    expect(log.depth).toBe(0);
  });

  it('the reported "rolled-back, safe to retry" can no longer be a lie about a deleted card', async () => {
    // The reviewer's three-step reproduction, end to end. Step 1 is the refusal
    // above, so steps 2 and 3 run over a transaction that destroyed nothing —
    // and `rolled-back / retryable: true` is then TRUE, which is the only
    // condition under which `skill run` may print "safe to retry".
    //
    // Step 3 fails OFF THE WIRE, on an unprobed 503. It used to be `probe-fail`,
    // which throws a bare in-process `Error` — and once `retryAdvice` started
    // gating the table on the wire, that came back `retryable: false` and this
    // test stopped reaching the "safe to retry" condition it exists to guard.
    // Flipping the assertion instead would have left a test that cannot fail:
    // the lie being pinned is `rolled-back AND retryable` printing over a
    // destroyed card, so the failure mode has to keep both halves true. Same
    // reason the 400 became a 503 in #162: a 400 stopped reading retryable, so
    // the unprobed status here has to be one that still does.
    let posts = 0;
    const stand = await startServer({
      fail: (r) => {
        if (r.method !== 'POST' || r.path !== '/cards') return undefined;
        posts += 1;
        // `>= 2`, not `=== 2`: `http-client` retries a 503, so a single-attempt
        // predicate would let the retry succeed and the step would never fail.
        // Those four retries at 1/2/4/8s are what this test costs.
        return posts >= 2 ? { status: 503, message: 'Something we have never probed' } : undefined;
      },
    });
    const log = new CompensationLog();

    await expect(dispatch('delete', { card: CARD }, ctx(stand, { log }))).rejects.toThrow(RefusalError);
    const made = await dispatch<Card>('create', { name: 'later', board: BOARD }, ctx(stand, { log }));
    expect(made.outcome).toBe('ok');
    const failed = await dispatch('create', { name: 'refused', board: BOARD }, ctx(stand, { log }));

    expect(failed.outcome).toBe('rolled-back');
    expect(failed.retryable).toBe(true);
    expect(failed.orphans).toBeUndefined();
    // The whole run really is undone: the create is gone, and the card the
    // refused step would have destroyed is still there.
    expect(stand.cards.has(made.value!.cardId)).toBe(false);
    expect(stand.cards.has(CARD)).toBe(true);
    expect(deletes(stand).map((r) => r.path)).toEqual([`/cards/${made.value!.cardId}`]);
  }, 40000);

  it('refuses inside a caller-threaded transaction that already holds writes', async () => {
    // The reason the entry above must not exist is also why this must refuse:
    // a later failure would unwind the create, report `rolled-back`, and say
    // nothing about the card this step destroyed. There is no fourth outcome
    // to tell that truth with, so the composition is refused before the write.
    const stand = await startServer();
    const log = new CompensationLog();

    const made = await dispatch<{ cardId: string }>('create', { name: 'Solo', board: BOARD }, ctx(stand, { log }));
    expect(made.outcome).toBe('ok');
    expect(log.depth).toBe(1);

    await expect(dispatch('delete', { card: CARD }, ctx(stand, { log }))).rejects.toThrow(RefusalError);

    // A pre-write refusal THROWS and writes nothing — it is not a fourth outcome.
    expect(deletes(stand)).toHaveLength(0);
    expect(stand.cards.has(CARD)).toBe(true);
    // The refused step left the transaction exactly as it found it.
    expect(log.depth).toBe(1);
  });

  it('runs normally on its own — a fresh log at depth 0 is not a transaction', async () => {
    const stand = await startServer();
    const result = await dispatch('delete', { card: CARD }, ctx(stand));
    expect(result.outcome).toBe('ok');
    expect(deletes(stand)).toHaveLength(1);
  });

  it('a delete that the wire refuses is reported as NOT retryable', async () => {
    // `isRetryable` stays the one derivation: a deterministic wire refusal is
    // non-retryable whatever the outcome, and nothing here special-cases delete.
    const stand = await startServer({
      fail: (r) => (r.method === 'DELETE' ? { status: 403, message: 'Access denied' } : undefined),
    });

    const result = await dispatch('delete', { card: CARD }, ctx(stand));

    expect(result.outcome).toBe('rolled-back');
    expect(result.retryable).toBe(false);
    // Nothing was logged, so "rolled-back" here means "we wrote nothing that
    // needed undoing" — and the card is still there to prove it.
    expect(stand.cards.has(CARD)).toBe(true);
  });
});

describe('archive is ONE intent with a direction, and it writes `archive` not `archived` (#75)', () => {
  /** The body of every PUT that carried an archive flag, in either spelling. */
  const archiveBodies = (stand: Stand) =>
    puts(stand.received).map((r) => r.body ?? {});

  it('sends `archive` in the BODY — the read-side `archived` spelling never ships', async () => {
    const stand = await startServer();

    const result = await dispatch<{ cardId: string; archived: boolean }>(
      'archive', { card: CARD, archived: true }, ctx(stand),
    );

    expect(result.outcome).toBe('ok');
    expect(result.value).toEqual({ cardId: CARD, archived: true });

    // The pin that stops the trap coming back. Asserted on the body the stand-in
    // PARSED off the wire, not on a call shape — and the stand-in honours only
    // `archive`, exactly as Favro does, so a mutation to `archived` fails both
    // this assertion and the read-back below.
    const bodies = archiveBodies(stand);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({ archive: true });
    expect(bodies[0]).not.toHaveProperty('archived');

    // Read the state back rather than counting calls: Favro answers 200 for
    // writes it does not perform.
    expect(stand.cards.get(CARD)!.archived).toBe(true);
  });

  it('does not put the flag on the QUERY string — this one is body-only', async () => {
    const stand = await startServer();
    await dispatch('archive', { card: CARD, archived: true }, ctx(stand));

    for (const put of puts(stand.received)) {
      expect(put.url).not.toContain('archive=');
      expect(put.url).not.toContain('archived=');
    }
  });

  it('un-archives through the same one wire op, with the direction flipped', async () => {
    const stand = await startServer();
    stand.cards.get(CARD)!.archived = true;

    const result = await dispatch<{ archived: boolean }>(
      'archive', { card: CARD, archived: false }, ctx(stand),
    );

    expect(result.outcome).toBe('ok');
    expect(result.value?.archived).toBe(false);
    expect(archiveBodies(stand)).toEqual([{ archive: false }]);
    expect(stand.cards.get(CARD)!.archived).toBe(false);
  });

  it('a skill step spells the direction as a STRING, and "false" means false', async () => {
    const stand = await startServer();
    stand.cards.get(CARD)!.archived = true;

    await dispatch('archive', { card: CARD, archived: 'false' }, ctx(stand));

    // `"false"` is truthy in JS. Honouring it as true would archive a card the
    // caller asked to un-archive — the same silent wrong answer `read`'s
    // `children: "false"` closed.
    expect(archiveBodies(stand)).toEqual([{ archive: false }]);
    expect(stand.cards.get(CARD)!.archived).toBe(false);
  });

  it('an ABSENT direction refuses rather than defaulting to un-archive', async () => {
    const stand = await startServer();
    stand.cards.get(CARD)!.archived = true;

    await expect(dispatch('archive', { card: CARD }, ctx(stand))).rejects.toThrow(RefusalError);
    expect(writes(stand.received)).toHaveLength(0);
    expect(stand.cards.get(CARD)!.archived).toBe(true);
  });

  it('the direction is strictly two-valued — an off-type value refuses, it never INVERTS', async () => {
    // The direction used to share `read`'s lenient flag parser, whose non-string
    // arm is `v === true` and whose string arm reads anything-not-in-a-blocklist
    // as true. On a mutation that leniency is not permissive, it is WRONG in both
    // directions, and silently: every row below wrote the opposite of what it
    // reads like, or wrote at all when it should have refused.
    //
    //   1 / null      → un-archived, no refusal
    //   "off" / "n"   → archived
    //
    // Held as a table so no row can be quietly dropped, and the card starts
    // ARCHIVED so an inverse write is observable as a state change rather than as
    // a no-op.
    const offType: unknown[] = [1, 0, null, 'yes', 'no', 'n', 'off', 'nope', '', '1', '0', {}, []];

    for (const archived of offType) {
      const stand = await startServer();
      stand.cards.get(CARD)!.archived = true;

      await expect(
        dispatch('archive', { card: CARD, archived } as any, ctx(stand)),
      ).rejects.toThrow(RefusalError);

      expect(writes(stand.received)).toHaveLength(0);
      expect(stand.cards.get(CARD)!.archived).toBe(true);
    }
  });

  it('the refusal names the accepted set, so a caller can repair the call', async () => {
    const stand = await startServer();

    await expect(dispatch('archive', { card: CARD, archived: 1 } as any, ctx(stand)))
      .rejects.toThrow(/"true" \/ "false"/);
  });

  it('the four accepted spellings all reach the wire, in the direction they name', async () => {
    // Case and surrounding space are ignored on the string arm, because a skill
    // step spells every arg as a string and a stray space is not a direction
    // change. Nothing beyond these four is accepted — see the table above.
    for (const [spelling, expected] of [
      [true, true], [false, false], ['TRUE', true], [' false ', false],
    ] as Array<[unknown, boolean]>) {
      const stand = await startServer();
      stand.cards.get(CARD)!.archived = !expected;

      await dispatch('archive', { card: CARD, archived: spelling } as any, ctx(stand));

      expect(archiveBodies(stand)).toEqual([{ archive: expected }]);
      expect(stand.cards.get(CARD)!.archived).toBe(expected);
    }
  });

  it('a 200 that did not take is a LOUD failure, not a ✓ about the argument', async () => {
    // The premise of this whole ticket is a wire that answers 200 and writes
    // nothing — that is exactly what `PUT {archived: …}` does. `status`,
    // `assignees` and whole-array `tags` are defended by TRANSLATING the write;
    // `archive` has no translation to make, so it reads the echo back instead.
    // Modelled on the far side of the wire, where the real thing would live: the
    // stand takes the PUT, answers 200, and does not move the card.
    const stand = await startServer({ ignoreArchiveWrites: true });

    const result = await dispatch('archive', { card: CARD, archived: true }, ctx(stand));

    expect(result.outcome).not.toBe('ok');
    // The message says "a SUCCESS status", not the code: this stand answers 200,
    // but the live wire answers 202 on writes too (#165) and the code is not
    // threaded out of the write seam, so the string states the class (#162 item 10).
    expect(result.error).toMatch(/answered a SUCCESS status but did not take/);
    // Nothing to compensate: the write landed nothing, so the log stayed empty
    // and the unwind had nothing to leave behind.
    expect(result.orphans).toBeUndefined();
    expect(result.outcome).toBe('rolled-back');
    // Not a refusal — the call is fine, the wire changed. A refusal would claim
    // "repair the call", which is advice about the wrong thing.
    //
    // **This is one of the two tests that pin `TransientError`.** `retryAdvice`
    // gates every caller on `isWireFailure` now, and this failure is raised in
    // OUR process, so the marker on `TxCards.setArchived`'s throw is the only
    // reason this line is `true` rather than `false`. Drop the marker and this is
    // the assertion that fails. Dropping the `instanceof TransientError` disjunct
    // from the gate fails this AND #101's "a 200 that left the card where it was
    // is a LOUD failure", which reaches the same arm through `moveColumn`. It
    // keys on the stand's real refusal to move the card, not on a call count.
    expect(result.retryable).toBe(true);
  });

  it('the reported side is the OBSERVED one, never the requested one', async () => {
    const stand = await startServer();

    const result = await dispatch<{ cardId: string; archived: boolean }>(
      'archive', { card: CARD, archived: true }, ctx(stand),
    );

    // Agreeing here is the point: the value comes from the card the wire echoed,
    // so it can only agree once the read-back check above has passed.
    expect(result.value?.archived).toBe(true);
    expect(stand.cards.get(CARD)!.archived).toBe(true);
  });

  it('a card already on the requested side is left alone, and nothing is written', async () => {
    const stand = await startServer();
    stand.cards.get(CARD)!.archived = true;

    const result = await dispatch('archive', { card: CARD, archived: true }, ctx(stand));

    expect(result.outcome).toBe('ok');
    expect(puts(stand.received)).toHaveLength(0);
    expect(stand.cards.get(CARD)!.archived).toBe(true);
  });

  it('is NOT terminal — it composes into a caller-threaded transaction', async () => {
    // The contrast with `delete`, which refuses a threaded log outright. Archive
    // is reversible in both directions, so it carries a real compensation entry
    // and a transaction can hold it.
    const stand = await startServer();
    const log = new CompensationLog();

    const result = await dispatch('archive', { card: CARD, archived: true }, ctx(stand, { log }));

    expect(result.outcome).toBe('ok');
    // A real entry, not an exempt placeholder: the transaction can undo this.
    expect(log.depth).toBe(1);
    expect(log.describe().join(' ')).toMatch(/un-archive card/);
  });

  it('--dry-run previews the direction and writes nothing', async () => {
    const stand = await startServer();

    const result = await dispatch('archive', { card: CARD, archived: true }, ctx(stand, { dryRun: true }));

    expect(result.outcome).toBe('ok');
    expect(result.preview?.join(' ')).toMatch(/archive card/);
    expect(result.preview?.join(' ')).toMatch(/reversible/i);
    expect(writes(stand.received)).toHaveLength(0);
    expect(stand.cards.get(CARD)!.archived).toBeUndefined();
  });

  it('the preview promises nothing it cannot see — it makes no read, so it stays conditional', async () => {
    // `preview` is a pure function of its args by design (`delete` shares that),
    // so it cannot know which side of the line the card is already on. The flat
    // wording asserted two things that are both false for an already-archived
    // card: that a write would happen, and that a compensation entry would exist
    // to move it back. Pinned on an ALREADY-archived card, which is the case the
    // old wording lied about.
    const stand = await startServer();
    stand.cards.get(CARD)!.archived = true;

    const result = await dispatch('archive', { card: CARD, archived: true }, ctx(stand, { dryRun: true }));
    const preview = result.preview?.join('\n') ?? '';

    expect(preview).toMatch(/unless it is already archived/);
    expect(preview).toMatch(/if it does write, a later failure/);
    // The two claims the old wording made unconditionally.
    expect(preview).not.toMatch(/reversible: a later failure in the same transaction moves it back/);
    // And no read was made to reach that wording.
    expect(stand.received.filter((r) => r.method === 'GET' && r.path === `/cards/${CARD}`)).toHaveLength(1);
  });

  it('a board outside the locked collection refuses BEFORE any PUT is sent', async () => {
    const stand = await startServer();
    stand.cards.get(CARD)!.widgetCommonId = OTHER_BOARD;

    await expect(
      dispatch('archive', { card: CARD, archived: true }, ctx(stand, {
        config: { scopeCollectionId: 'coll-a', scopeCollectionName: 'Collection A' },
      })),
    ).rejects.toThrow(ScopeError);

    expect(writes(stand.received)).toHaveLength(0);
    expect(stand.cards.get(CARD)!.archived).toBeUndefined();
  });

  it('a boardless card — the fork shape — refuses rather than failing open', async () => {
    const stand = await startServer();
    delete stand.cards.get(CARD)!.widgetCommonId;

    await expect(
      dispatch('archive', { card: CARD, archived: true }, ctx(stand, {
        config: { scopeCollectionId: 'coll-a', scopeCollectionName: 'Collection A' },
      })),
    ).rejects.toThrow(RefusalError);

    expect(writes(stand.received)).toHaveLength(0);
  });

  it('a card inside the locked collection proceeds', async () => {
    const stand = await startServer();

    const result = await dispatch('archive', { card: CARD, archived: true }, ctx(stand, {
      config: { scopeCollectionId: 'coll-a' },
    }));

    expect(result.outcome).toBe('ok');
    expect(stand.cards.get(CARD)!.archived).toBe(true);
  });
});

describe('the archive compensation restores the CAPTURED prior value', () => {
  it('un-archiving an ARCHIVED card unwinds back to archived, not to false', async () => {
    // The hardcode test. A compensating write that sent `archive: false` — or
    // any fixed value — would leave this card un-archived and report a clean
    // `rolled-back`, which is the lie the captured pre-state exists to prevent.
    const stand = await startServer();
    stand.cards.get(CARD)!.archived = true;

    const result = await dispatch(
      'probe-archive', { card: CARD, archived: false, thenFail: true }, ctx(stand),
    );

    expect(result.outcome).toBe('rolled-back');
    // Incidental: `probe-archive`'s `thenFail` is a bare in-process `Error`, so
    // `retryAdvice`'s wire gate answers `false`. Contrast the read-back failure
    // in "a 200 that did not take", which carries a `TransientError` and stays
    // `true` — the two are the same shape only if you read the outcome instead.
    expect(result.retryable).toBe(false);
    expect(stand.cards.get(CARD)!.archived).toBe(true);

    const bodies = puts(stand.received).map((r) => r.body);
    expect(bodies).toEqual([{ archive: false }, { archive: true }]);
  });

  it('archiving a LIVE card unwinds back to un-archived', async () => {
    const stand = await startServer();

    const result = await dispatch(
      'probe-archive', { card: CARD, archived: true, thenFail: true }, ctx(stand),
    );

    expect(result.outcome).toBe('rolled-back');
    expect(stand.cards.get(CARD)!.archived).toBe(false);
    expect(puts(stand.received).map((r) => r.body)).toEqual([{ archive: true }, { archive: false }]);
  });

  it('a concurrent editor who moved the card back is SKIPPED, with per-field detail', async () => {
    // No version carrier on this wire, so this is DETECTED, never prevented. A
    // human un-archives the card between our write and the detecting read;
    // applying our inverse would clobber their edit.
    const stand = await startServer({
      afterWrite: ({ cards }, wrote) => {
        if (wrote !== 1) return;
        cards.get(CARD)!.archived = false;
      },
    });

    const result = await dispatch(
      'probe-archive', { card: CARD, archived: true, thenFail: true }, ctx(stand),
    );

    expect(result.outcome).toBe('rollback-incomplete');
    expect(result.retryable).toBe(false);
    expect(result.orphans).toEqual([
      expect.objectContaining({
        cause: 'compensation-skipped',
        card: CARD,
        field: 'archived',
        wrote: true,
        live: false,
      }),
    ]);
    // Exactly ONE PUT — ours. No compensating write went out over their edit.
    expect(puts(stand.received)).toHaveLength(1);
    expect(stand.cards.get(CARD)!.archived).toBe(false);
  });
});

describe('a client-side resolution refusal is never advertised as retryable', () => {
  // Each of these names something the org does not hold, so the identical call
  // refuses identically — `retryable: true` is advice to loop forever, which is
  // exactly what `ColumnResolutionError` produced while it extended plain
  // `Error`: no `RefusalError` arm to match, and no HTTP response to classify,
  // so the transient family by default (#81).
  //
  // Driven as the SECOND card of a multi-create on purpose. A refusal raised
  // before this invocation has written anything is RETHROWN, so the retry advice
  // only exists on a returned result once one card is already made.
  const bad: Array<[string, Record<string, unknown>]> = [
    ['--status', { name: 'Second', board: BOARD, status: 'Dong' }],
    ['--tag', { name: 'Second', board: BOARD, tags: ['no-such-tag'] }],
    ['--assignee', { name: 'Second', board: BOARD, assignees: ['Nobody Here'] }],
  ];

  it.each(bad)('a %s that resolves to nothing reports retryable: false', async (_flag, second) => {
    const stand = await startServer();

    const result = await dispatch(
      'create',
      { cards: [{ name: 'First', board: BOARD }, second] },
      ctx(stand),
    );

    expect(result.outcome).toBe('rolled-back');
    expect(result.retryable).toBe(false);
    // The first card really was unwound — "rolled-back" is a claim about the
    // wire, not about our own bookkeeping.
    expect([...stand.cards.keys()]).not.toContain('new-card-1');
  });
});
