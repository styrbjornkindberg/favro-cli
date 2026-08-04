/**
 * One `unreachable`, one shape (#86).
 *
 * `read-shape.ts` declares the marker — `unreachable?: Unreachable[]`, objects
 * carrying `{id, reason}` — and `favro help issue-tracker` teaches it as the
 * wire contract. Two producers used to disagree: `overview` shipped the right
 * type under `unreachableBlockers`, `risks` shipped the right key holding bare
 * strings. An agent parsing the documented shape got nothing from either.
 *
 * So the assertion here is deliberately ONE parser, run over the real output of
 * every producer. A per-command shape test would have passed all along — each
 * producer was internally consistent. What was broken is that they could not be
 * read the same way, and only a shared reader can see that.
 *
 * A NEW producer must be added to the list below in the same change that adds
 * it. #116 made `getSnapshot` the fourth, and the shared reader is the only
 * thing that would have caught it shipping a fifth shape. `cards get --include`
 * is the FIFTH (#153): its four facet reads used to swallow their failures, and
 * discharging them put the marker on a `Card` — the second producer to ride on a
 * bare entity rather than an envelope, so the shared reader has to reach it too.
 */
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import CardsAPI from '../lib/cards-api';
import { judgeBlockers } from '../lib/blocking';
import { findTopBlockers } from '../commands/overview';
import { STALE_UNREACHABLE } from '../commands/risks';
import { ContextAPI, type BoardContextSnapshot } from '../api/context';
import type { AggregateCard } from '../api/aggregate';

const ORG = 'org-1';
const BOARD = 'board-a';

/** Every server this file started, so a failed assertion cannot leak one. */
const running: http.Server[] = [];

/**
 * The one read an agent writes. Anything it throws on is a producer the
 * documented shape does not reach.
 */
function parseUnreachable(payload: unknown): Array<{ id: string; reason: string }> {
  const marker = (payload as { unreachable?: unknown }).unreachable;
  if (marker === undefined) return [];
  if (!Array.isArray(marker)) throw new Error(`unreachable is ${typeof marker}, not an array`);
  return marker.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`unreachable[${i}] is ${typeof entry}, not an object — u.reason is undefined`);
    }
    const { id, reason } = entry as { id?: unknown; reason?: unknown };
    if (typeof id !== 'string') throw new Error(`unreachable[${i}].id is ${typeof id}`);
    if (typeof reason !== 'string') throw new Error(`unreachable[${i}].reason is ${typeof reason}`);
    return { id, reason };
  });
}

// ─── `cards list` — the canonical producer, via judgeBlockers ────────────────

/** A Favro stand-in whose per-blocker read always refuses. */
function startServer(board: Record<string, unknown>[]): Promise<FavroHttpClient> {
  const server = http.createServer((req, res) => {
    req.on('data', () => { /* no bodies on this path */ });
    req.on('end', () => {
      const url = req.url ?? '';
      if (url.includes('cardCommonId=')) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Access denied' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entities: board }));
    });
  });
  running.push(server);

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(new FavroHttpClient({
        baseURL: `http://127.0.0.1:${port}/api/v1`,
        auth: { organizationId: ORG },
      }));
    });
  });
}

const originalConfigDir = process.env.FAVRO_CONFIG_DIR;
const originalTrackerDoc = process.env.FAVRO_TRACKER_DOC;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-unreachable-test-'));
  process.env.FAVRO_CONFIG_DIR = tmpDir;
  process.env.FAVRO_TRACKER_DOC = path.join(tmpDir, 'issue-tracker.md');
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise((done) => s.close(() => done(null)))));
  for (const [key, value] of [
    ['FAVRO_CONFIG_DIR', originalConfigDir],
    ['FAVRO_TRACKER_DOC', originalTrackerDoc],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** What `cards list --filter unblocked --json` puts on stdout, minus the rows. */
async function fromCardsList(): Promise<unknown> {
  const client = await startServer([
    {
      cardId: 'card-1',
      cardCommonId: 'common-blocked',
      name: 'a blocked card',
      widgetCommonId: BOARD,
      dependencies: [{ cardCommonId: 'common-blocker', isBefore: true }],
    },
  ]);
  const cards = await new CardsAPI(client).listCards({ boardId: BOARD });
  const judged = await judgeBlockers(cards, client);
  // Exactly what `cli.ts` hands `writeEnvelope`.
  return { rows: [], ...(judged.unreachable.length > 0 ? { unreachable: judged.unreachable } : {}) };
}

/** What `overview --json` puts on stdout, minus everything but the marker. */
async function fromOverview(): Promise<unknown> {
  const cards = [
    { id: 'id-1', commonId: '1', title: 'blocked', blockedBy: ['off-board'] },
  ] as unknown as AggregateCard[];
  const { unreachable } = findTopBlockers(cards);
  return { ...(unreachable.length > 0 ? { unreachable } : {}) };
}

/** What `risks --json` puts on stdout, minus everything but the marker. */
function fromRisks(): unknown {
  return { unreachable: STALE_UNREACHABLE };
}

/**
 * What `context --json` puts on stdout, minus everything but the marker — the
 * FOURTH producer (#116), and the one that reaches furthest: `standup`,
 * `sprint-plan` and `query` all carry this same array straight off the snapshot,
 * so a drift here is a drift on four commands at once.
 *
 * The snapshot's holes are whole FACETS, not card ids, which is exactly why it
 * belongs in this file rather than in a shape test of its own: `id` meaning
 * something different is fine, `id` being a different TYPE is what #86 is about.
 */
async function fromContext(cardsRefuse = true): Promise<BoardContextSnapshot> {
  // A stand-in whose card fetch refuses and whose every other facet answers.
  const server = http.createServer((req, res) => {
    req.on('data', () => { /* no bodies on this path */ });
    req.on('end', () => {
      const url = req.url ?? '';
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (cardsRefuse && url.split('?')[0].endsWith('/cards')) return send(403, { message: 'Access denied' });
      if (url.split('?')[0].endsWith('/widgets')) {
        return send(200, { entities: [{ widgetCommonId: BOARD, name: 'Board A', collectionIds: ['coll-a'] }] });
      }
      return send(200, { entities: [] });
    });
  });
  running.push(server);

  const client = await new Promise<FavroHttpClient>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(new FavroHttpClient({
        baseURL: `http://127.0.0.1:${port}/api/v1`,
        auth: { organizationId: ORG },
      }));
    });
  });

  const snapshot = await new ContextAPI(client).getSnapshot(BOARD);
  // The snapshot IS what stdout carries (rule 1: a single read stays bare), so
  // there is nothing to reshape here — that is the assertion.
  return snapshot;
}

/**
 * What `cards get <card> --include comments` puts on stdout, minus everything but
 * the marker — the FIFTH producer (#153).
 *
 * The holes are `--include` FACETS, like `context`'s, and they ride on the card
 * itself: a single read has no envelope (rule 1), so the entity carries its own.
 * The card GET answers; only the `/comments?cardCommonId=` facet refuses, so the
 * marker has to describe a partial read of a card that WAS fetched.
 */
async function fromCardsGet(): Promise<unknown> {
  const CARD = '117a0f59f4145c41747b32dc';
  const server = http.createServer((req, res) => {
    req.on('data', () => { /* no bodies on this path */ });
    req.on('end', () => {
      const url = req.url ?? '';
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.includes('cardCommonId=')) return send(403, { message: 'Access denied' });
      if (url.split('?')[0].endsWith(`/cards/${CARD}`)) {
        return send(200, { cardId: CARD, cardCommonId: 'common-1', name: 'a card' });
      }
      return send(200, { entities: [] });
    });
  });
  running.push(server);

  const client = await new Promise<FavroHttpClient>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(new FavroHttpClient({
        baseURL: `http://127.0.0.1:${port}/api/v1`,
        auth: { organizationId: ORG },
      }));
    });
  });

  // The card IS what stdout carries, so there is nothing to reshape here.
  return new CardsAPI(client).getCard(CARD, { include: ['comments'] });
}

describe('the unreachable marker reads the same from every producer (#86)', () => {
  it('parses identically from cards list, overview, risks, context and cards get', async () => {
    const produced = [
      ['cards list', await fromCardsList()],
      ['overview', await fromOverview()],
      ['risks', fromRisks()],
      ['context', await fromContext()],
      ['cards get', await fromCardsGet()],
    ] as const;

    for (const [command, payload] of produced) {
      // The key. `unreachableBlockers` made an agent find no `unreachable` at all.
      expect(Object.keys(payload as object)).toContain('unreachable');

      // The type. A `string[]` under the right key is worse than a missing one:
      // it parses, and every `u.reason` is undefined.
      const parsed = parseUnreachable(payload);
      expect(parsed.length).toBeGreaterThan(0);
      for (const entry of parsed) {
        expect(typeof entry.id).toBe('string');
        expect(entry.reason).not.toHaveLength(0);
        // Terminal-ready wording, never a bare "not found".
        expect(entry.reason.length).toBeGreaterThan('not found'.length);
      }
      // Naming the command keeps a failure readable when only one producer drifts.
      expect({ command, ok: true }).toEqual({ command, ok: true });
    }
  });

  it('an absent marker is absent, not an empty array — empty means true-empty', async () => {
    const { unreachable } = findTopBlockers([
      { id: 'id-1', commonId: '1', title: 'a' },
    ] as unknown as AggregateCard[]);

    expect(unreachable).toEqual([]);
    expect(parseUnreachable({})).toEqual([]);
  });

  it('a context snapshot that read everything omits the key entirely (#116)', async () => {
    // The distinction the whole marker rests on, on the producer four commands
    // share: `cards: []` with NO `unreachable` means the board is empty. An
    // `unreachable: []` here would read as a hole to any truthiness check.
    const snapshot = await fromContext(false);
    expect(snapshot.cards).toEqual([]);
    expect('unreachable' in snapshot).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain('unreachable');
  });
});
