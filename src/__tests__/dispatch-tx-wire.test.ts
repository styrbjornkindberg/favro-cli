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
} from '../lib/dispatch';
import { CompensationLog, TxCards } from '../lib/tx-cards';
import { ScopeError } from '../lib/safety';

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
const CARD = '00000000000000000000cc01';
const FAR = '00000000000000000000cc02';

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
        const entities = [...cards.values()].filter((c) => {
          if (commonId) return c.cardCommonId === commonId;
          if (seq) return false;
          return true;
        });
        return send(200, { entities: entities.map(wire) });
      }

      // ── directories ───────────────────────────────────────────────────────
      if (pathOnly.startsWith('/widgets')) {
        // A by-id widget GET answers the bare entity; only the list answers an
        // `entities` envelope. `assertScope` reads `collectionIds` off the
        // former, so serving the envelope for both would make the lock
        // unenforceable against a board that is genuinely in scope.
        const byId = pathOnly.slice('/widgets'.length).replace(/^\//, '');
        const all = [
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
        if (byId) {
          const found = all.find((w) => w.widgetCommonId === byId);
          return found ? send(200, found) : send(404, { message: 'Widget not found' });
        }
        return send(200, {
          entities: [
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
          ],
        });
      }
      if (pathOnly.startsWith('/tags')) {
        return send(200, {
          entities: [{ tagId: TAG_BUG, name: 'bug' }, { tagId: TAG_P1, name: 'P1' }],
        });
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
  it('the seven intents named by the spec are either registered or explicitly pending', () => {
    // A registry, not a hand list: #53–#55 add theirs against this same table.
    expect(intentNames()).toContain('create');
    expect(intentNames()).toContain('remove-blocking-edge');
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

/** Set inside a `fail` hook that needs the stand it belongs to. */
let standRef: Stand | undefined;
