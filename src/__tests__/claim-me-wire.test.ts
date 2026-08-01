/**
 * `claim` with no `--assignee` — the default and primary path, over a
 * `node:http` Favro stand-in. Issue #65.
 *
 * This is the chain the ticket named and that nothing exercised:
 *   claim (no assignee) → resolveAssignee('@me') → resolveUserId() → readConfig()
 *
 * It only became testable once `config.ts` stopped freezing CONFIG_FILE at
 * import: before that, `readConfig()` reached past FAVRO_CONFIG_DIR into the
 * developer's real ~/.favro/config.json, so every claim test passed an explicit
 * `--assignee` and the one that omitted it refused in `board()` before `run()`
 * ever executed. Break the config key `resolveUserId` reads and the whole rest
 * of the suite stays green while the primary claim path fails 100% in the field.
 *
 * The redirect is therefore not test ceremony here — it is the mechanism under
 * test, which is why it is established at FILE level, before any require.
 *
 * Assertions are about what the wire RECEIVED and what the caller OBSERVED.
 */
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { AddressInfo } from 'net';

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'favro-claim-me-'));
process.env.FAVRO_CONFIG_DIR = CONFIG_DIR;
process.env.FAVRO_TRACKER_DOC = path.join(CONFIG_DIR, 'issue-tracker.md');
// The `@me` fallback path reaches for these when no userId is cached. Left set
// by the developer's shell they would turn a refusal test into a live call.
delete process.env.FAVRO_API_KEY;
delete process.env.FAVRO_API_TOKEN;
delete process.env.FAVRO_EMAIL;
delete process.env.FAVRO_ORGANIZATION_ID;

import FavroHttpClient from '../lib/http-client';
import { dispatch, DispatchContext } from '../lib/dispatch';
import { renderTrackerBlock, TrackerMapping } from '../lib/tracker-config';

const ORG = 'org-1';
const BOARD = 'board-a';
const TODO = 'col-todo';
const DOING = 'col-doing';
const DONE = 'col-done';
/** The caller's own userId — reachable ONLY through the redirected config. */
const ME = 'mmmmmmmmmmmmmmmmm';
const SOMEONE_ELSE = 'sssssssssssssssss';
const CARD = '00000000000000000000cc01';

interface Received { method: string; path: string; body?: any }

interface StoredCard {
  cardId: string;
  cardCommonId: string;
  name: string;
  widgetCommonId?: string;
  columnId?: string;
  tags: string[];
  assignments: Array<{ userId: string }>;
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
      { columnId: DONE, name: 'Done', position: 2 },
    ],
  },
];

function startServer(): Promise<Stand> {
  const received: Received[] = [];
  const cards = new Map<string, StoredCard>([
    [CARD, {
      cardId: CARD,
      cardCommonId: `ccid-${CARD}`,
      name: 'A card',
      widgetCommonId: BOARD,
      columnId: TODO,
      tags: [],
      assignments: [],
    }],
  ]);
  let forks = 0;

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
        if (!stored) return send(403, { message: 'Access denied' });
        if (r.method === 'GET') return send(200, { ...stored });
        if (r.method === 'PUT') {
          const b = r.body ?? {};
          const next: StoredCard = { ...stored, assignments: [...stored.assignments] };
          if (b.columnId !== undefined) next.columnId = b.columnId;
          for (const u of b.addAssignmentIds ?? []) {
            if (next.assignments.some((a) => a.userId === u)) continue;
            next.assignments.push({ userId: u });
            // Claiming FORKS the card: `addAssignmentIds` yields a SECOND
            // entity — the assignee's to-do-list instance — with no
            // widgetCommonId and no columnId. A boardless card here is real.
            forks += 1;
            const forkId = `fork-${forks}`;
            cards.set(forkId, {
              cardId: forkId,
              cardCommonId: stored.cardCommonId,
              name: stored.name,
              tags: [],
              assignments: [{ userId: u }],
            });
          }
          for (const u of b.removeAssignmentIds ?? []) {
            next.assignments = next.assignments.filter((a) => a.userId !== u);
          }
          cards.set(single[1], next);
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
        return send(200, {
          entities: (found?.columns ?? []).map((c) => ({ ...c, widgetCommonId: board })),
        });
      }
      if (pathOnly.startsWith('/widgets')) {
        // A by-id widget GET answers the bare entity; only the list answers an
        // `entities` envelope.
        const byId = pathOnly.slice('/widgets'.length).replace(/^\//, '');
        if (byId) {
          const found = BOARDS.find((w) => w.widgetCommonId === byId);
          return found ? send(200, found) : send(404, { message: 'Widget not found' });
        }
        return send(200, { entities: BOARDS });
      }
      if (pathOnly.startsWith('/users')) {
        // Deliberately does NOT contain ME. `@me` must come from the config,
        // not from anything the directory could supply by accident.
        return send(200, {
          entities: [{ userId: SOMEONE_ELSE, name: 'Someone Else', email: 'someone@example.com' }],
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
      });
    });
  });
}

/** Designate a tracker the way `tracker init` does — a pasted block in a doc. */
function useTracker(): TrackerMapping {
  const mapping: TrackerMapping = {
    collectionId: 'coll-a',
    boardId: BOARD,
    columns: { active: DOING, done: DONE },
  };
  fs.writeFileSync(process.env.FAVRO_TRACKER_DOC!, renderTrackerBlock(mapping));
  return mapping;
}

/** Write the redirected config — the ONLY place `@me` can come from. */
function writeConfigFile(config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(CONFIG_DIR, 'config.json'), JSON.stringify(config));
}

const ctx = (stand: Stand): DispatchContext => ({ client: stand.client, config: {} });
const puts = (received: Received[]) => received.filter((r) => r.method === 'PUT');

beforeEach(() => {
  useTracker();
  writeConfigFile({ userId: ME });
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise((done) => s.close(() => done(null)))));
  fs.rmSync(path.join(CONFIG_DIR, 'config.json'), { force: true });
});

afterAll(() => {
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('claim with no --assignee resolves @me through the config', () => {
  it('sends the config userId on the wire, and never the literal "@me"', async () => {
    const stand = await startServer();

    const result = await dispatch<{ cardId: string; columnId?: string; assignee: string }>(
      'claim',
      { card: CARD },
      ctx(stand),
    );

    // What the caller observes.
    expect(result.outcome).toBe('ok');
    expect(result.value).toMatchObject({ cardId: CARD, columnId: DOING, assignee: ME });

    // What the wire received: the assignment carries the redirected config's
    // userId, and the placeholder is resolved before it ever leaves the CLI.
    expect(puts(stand.received).map((r) => r.body)).toEqual([
      { addAssignmentIds: [ME] },
      { columnId: DOING },
    ]);
    expect(JSON.stringify(stand.received)).not.toContain('@me');

    // And the state the wire is left in.
    expect(stand.cards.get(CARD)!.assignments).toEqual([{ userId: ME }]);
    expect(stand.cards.get(CARD)!.columnId).toBe(DOING);
  });

  it('moves the tracker-board instance, not the fork the claim created', async () => {
    // `addAssignmentIds` yields a second entity with no widgetCommonId and no
    // columnId. That boardless card is real, not corruption — and it is not
    // what the caller gets back or what gets moved.
    const stand = await startServer();

    const result = await dispatch<{ cardId: string }>('claim', { card: CARD }, ctx(stand));

    const fork = [...stand.cards.values()].find((c) => c.cardId !== CARD);
    expect(fork).toMatchObject({ assignments: [{ userId: ME }] });
    expect(fork!.widgetCommonId).toBeUndefined();
    expect(fork!.columnId).toBeUndefined();
    expect(result.value?.cardId).toBe(CARD);
    expect(puts(stand.received).every((r) => r.path === `/cards/${CARD}`)).toBe(true);
  });

  it('refuses, without writing, when no userId is cached for the caller', async () => {
    // The failure mode the field sees on a machine that never ran `auth login`.
    writeConfigFile({});
    const stand = await startServer();

    await expect(dispatch('claim', { card: CARD }, ctx(stand))).rejects.toThrow(
      /Cannot resolve "@me"/,
    );
    expect(puts(stand.received)).toHaveLength(0);
    expect(stand.cards.get(CARD)!.assignments).toEqual([]);
    expect(stand.cards.get(CARD)!.columnId).toBe(TODO);
  });

  it('an explicit --assignee still wins over the config', async () => {
    const stand = await startServer();

    const result = await dispatch<{ assignee: string }>(
      'claim',
      { card: CARD, assignee: SOMEONE_ELSE },
      ctx(stand),
    );

    expect(result.value?.assignee).toBe(SOMEONE_ELSE);
    expect(puts(stand.received)[0].body).toEqual({ addAssignmentIds: [SOMEONE_ELSE] });
  });
  it('follows FAVRO_CONFIG_DIR when it is redirected AFTER the module was loaded', async () => {
    // This is #65 itself. Setting the env before the require (as this file
    // does) is satisfied by an import-time constant too, so nothing above
    // would notice a re-freeze. Here the redirect happens mid-run: only a
    // path resolved PER CALL can follow it. The HTTP MCP server depends on
    // exactly this, since it hands each user their own config dir per process.
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'favro-claim-me-2nd-'));
    fs.writeFileSync(path.join(second, 'config.json'), JSON.stringify({ userId: SOMEONE_ELSE }));
    const first = process.env.FAVRO_CONFIG_DIR;
    process.env.FAVRO_CONFIG_DIR = second;
    const stand = await startServer();

    try {
      const result = await dispatch<{ assignee: string }>('claim', { card: CARD }, ctx(stand));
      expect(result.value?.assignee).toBe(SOMEONE_ELSE);
      expect(puts(stand.received)[0].body).toEqual({ addAssignmentIds: [SOMEONE_ELSE] });
    } finally {
      process.env.FAVRO_CONFIG_DIR = first;
      fs.rmSync(second, { recursive: true, force: true });
    }
  });
});
