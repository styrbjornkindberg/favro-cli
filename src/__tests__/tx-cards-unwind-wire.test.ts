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
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import CardsAPI from '../lib/cards-api';
import { CompensationLog, TxCards } from '../lib/tx-cards';
import { tempConfigDir } from '../test-support/config-dir';

// This stand-in client carries an organizationId, so any TxCards path that grows
// a cache-backed lookup would write to the real `~/.favro` from here. Set before
// anything reads it — the cache and the config both resolve the dir per call.
tempConfigDir('favro-tx-unwind-');

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
async function startServer(opts: { denyDeleteWith202?: true } = {}): Promise<Stand> {
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
        // The compensating write REFUSED, in the shape Favro refuses with
        // (#165): a 2xx whose body carries the denial. `Access denied` is in
        // #38's closed not-found set, so on the message alone this is
        // indistinguishable from "the edge is already gone" — which is exactly
        // what `alreadyGone` used to conclude.
        if (opts.denyDeleteWith202) return send(202, { message: 'Access denied' });
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

  it('a compensating write REFUSED with a 202 is an orphan, not an already-undone (#165)', async () => {
    // The mirror of the arm above, and the reason `alreadyGone` cannot decide on
    // the message alone. `202 {"message":"Access denied"}` classifies
    // `not-found` — the same words a 403 uses for an absent resource — so
    // without the type check the refusal was swallowed by `continue` and the run
    // reported `rolled-back` with no orphan: the edge still there, the report
    // saying the world was restored. That is a 2xx denial reading as success
    // INSIDE the rollback report, which is the one place left where this
    // release's defect class could still hide.
    const stand = await startServer({ denyDeleteWith202: true });
    const log = new CompensationLog();
    const tx = new TxCards(new CardsAPI(stand.client), log, stand.client);

    await tx.addBlockingEdge(CARD, FAR);
    expect(stand.edges).toHaveLength(1);

    const result = await log.unwind();

    expect(result.outcome).toBe('rollback-incomplete');
    expect(result.orphans).toHaveLength(1);
    expect(result.orphans[0].cause).toBe('compensation-failed');
    // Favro's own words reach the orphan's reason, so a reader is told WHY the
    // edge is still there rather than being told it is not.
    expect(result.orphans[0].reason).toContain('Access denied');
    // And the edge really is still there — the assertion that makes the silence
    // a defect rather than a cosmetic one.
    expect(stand.edges).toHaveLength(1);
  });
});
