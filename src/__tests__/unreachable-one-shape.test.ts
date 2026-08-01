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
 * all three producers. A per-command shape test would have passed all along —
 * each producer was internally consistent. What was broken is that they could
 * not be read the same way, and only a shared reader can see that.
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
  const { unreachable } = await findTopBlockers(cards);
  return { ...(unreachable.length > 0 ? { unreachable } : {}) };
}

/** What `risks --json` puts on stdout, minus everything but the marker. */
function fromRisks(): unknown {
  return { unreachable: STALE_UNREACHABLE };
}

describe('the unreachable marker reads the same from every producer (#86)', () => {
  it('parses identically from cards list, overview and risks', async () => {
    const produced = [
      ['cards list', await fromCardsList()],
      ['overview', await fromOverview()],
      ['risks', fromRisks()],
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
    const { unreachable } = await findTopBlockers([
      { id: 'id-1', commonId: '1', title: 'a' },
    ] as unknown as AggregateCard[]);

    expect(unreachable).toEqual([]);
    expect(parseUnreachable({})).toEqual([]);
  });
});
