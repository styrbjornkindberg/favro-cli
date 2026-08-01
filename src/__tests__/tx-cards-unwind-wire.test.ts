/**
 * The compensation log's already-gone rule, over a `node:http` Favro stand-in
 * (#68).
 *
 * The one case this file exists for: `unlinkCard` is measured to answer
 * `404 {"message":"Dependency not found"}` once the edge is gone, and that
 * message is NOT in #38's closed not-found set. So the raw-404 short-circuit in
 * `alreadyGone()` is load-bearing rather than a redundant fast path — without
 * it, the routine "someone else already removed the edge" unwind reports a
 * false `compensation-failed` orphan and downgrades a correct, retryable
 * `rolled-back` to `rollback-incomplete`.
 *
 * Assertions are about what the wire RECEIVED and what the caller OBSERVED.
 */
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import CardsAPI from '../lib/cards-api';
import { CompensationLog, TxCards } from '../lib/tx-cards';

// This stand-in client carries an organizationId, so any TxCards path that grows
// a cache-backed lookup would write to the real `~/.favro` from here. Set before
// anything reads it — the cache and the config both resolve the dir per call.
process.env.FAVRO_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'favro-tx-unwind-'));

const ORG = 'org-1';
const CARD = '00000000000000000000cc01';
const FAR = '00000000000000000000cc02';

interface Received {
  method: string;
  path: string;
}

interface Stand {
  client: FavroHttpClient;
  received: Received[];
  edges: Array<{ near: string; far: string; isBefore: boolean }>;
}

const running: http.Server[] = [];

/**
 * Only the dependency routes — everything else in this transaction is a hex
 * reference, which `toCardId` settles without a call.
 */
async function startServer(): Promise<Stand> {
  const received: Received[] = [];
  const edges: Stand['edges'] = [];

  const depsOf = (near: string) =>
    edges
      .filter((e) => e.near === near || e.far === near)
      .map((e) => (e.near === near ? { cardId: e.far, isBefore: e.isBefore } : { cardId: e.near, isBefore: !e.isBefore }));

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    const pathOnly = url.split('?')[0].replace(/^\/api\/v1/, '');
    received.push({ method: req.method ?? '', path: pathOnly });

    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      const dep = pathOnly.match(/^\/cards\/([^/]+)\/dependencies(?:\/([^/]+))?$/);
      if (!dep) return send(200, { entities: [] });
      const [, near, far] = dep;

      if (req.method === 'GET') return send(200, { dependencies: depsOf(near) });
      if (req.method === 'POST') {
        for (const e of body?.dependencies ?? []) {
          edges.push({ near, far: e.cardId, isBefore: e.isBefore === true });
        }
        return send(200, { dependencies: depsOf(near) });
      }
      if (req.method === 'DELETE') {
        const before = edges.length;
        for (let i = edges.length - 1; i >= 0; i -= 1) {
          const e = edges[i];
          if ((e.near === near && e.far === far) || (e.near === far && e.far === near)) edges.splice(i, 1);
        }
        // Measured live (see `CardsAPI.unlinkCard`): 204 on success, and this
        // exact 404 once the edge is already gone. The message is deliberately
        // the real one — it is outside #38's closed set, which is the whole
        // point of the test below.
        if (edges.length === before) return send(404, { message: 'Dependency not found' });
        res.writeHead(204);
        return res.end();
      }
      return send(200, { entities: [] });
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
        edges,
      });
    });
  });
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise((done) => s.close(() => done(null)))));
});

describe('already-gone on the inverse is decided by the wire, not only by the message set', () => {
  it('an edge a concurrent editor already removed unwinds clean, on a 404 no closed-set message covers', async () => {
    const stand = await startServer();
    const log = new CompensationLog();
    const tx = new TxCards(new CardsAPI(stand.client), log, stand.client);

    await tx.addBlockingEdge(CARD, FAR);
    expect(stand.edges).toHaveLength(1);

    // Someone else removes the edge before we get to undo our own add.
    stand.edges.length = 0;

    const result = await log.unwind();

    // What the caller observes: a clean, retryable rollback and no orphan.
    expect(result.outcome).toBe('rolled-back');
    expect(result.orphans).toEqual([]);
    // What the wire received: we still sent the inverse and ate its 404.
    expect(stand.received).toContainEqual({
      method: 'DELETE',
      path: `/cards/${CARD}/dependencies/${FAR}`,
    });
  });
});
