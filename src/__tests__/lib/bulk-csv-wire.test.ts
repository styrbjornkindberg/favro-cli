/**
 * A bulk CSV import over a `node:http` Favro stand-in — issue #60.
 *
 * Separate from `bulk.test.ts` on purpose: that file mocks `cards-api` and
 * `http-client` at module level, and a mock is exactly what cannot answer the
 * question here. Favro answers 200 to a whole-array `assignees` write and
 * changes nothing, so "we sent the right thing" and "the assignment landed"
 * look identical to a mock. Only a stand-in holding real state can show that a
 * display name in a CSV `owner` column reaches the wire as a `userId`.
 *
 * Every assertion is about what the server RECEIVED or what the caller
 * OBSERVED — never about which layer did the resolving.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';

// Before ANY favro module is required: the name cache is a real file, and a
// stray read here would touch the developer's own ~/.favro.
const TMP = mkdtempSync(path.join(os.tmpdir(), 'favro-bulk-wire-'));
const originalConfigDir = process.env.FAVRO_CONFIG_DIR;
process.env.FAVRO_CONFIG_DIR = TMP;

/* eslint-disable @typescript-eslint/no-var-requires */
const FavroHttpClient = require('../../lib/http-client').default;
const CardsAPI = require('../../lib/cards-api').default;
const { parseCSVContent, csvRowToBulkOperation, BulkTransaction } = require('../../lib/bulk');
const { AssigneeError } = require('../../lib/assignee');
/* eslint-enable @typescript-eslint/no-var-requires */

const ORG = 'org-1';
const BOARD = 'board-a';
const ALICE = 'aaaaaaaaaaaaaaaaa';
const BOB = 'bbbbbbbbbbbbbbbbb';
const CARD_1 = '00000000000000000000cc01';
const CARD_2 = '00000000000000000000cc02';

interface Received { method: string; path: string; body?: any }

interface StoredCard {
  cardId: string;
  cardCommonId: string;
  name: string;
  widgetCommonId: string;
  assignments: Array<{ userId: string }>;
}

/** Every server this file started, so a failed assertion cannot leak a listener. */
const running: http.Server[] = [];

interface Stand {
  client: any;
  received: Received[];
  cards: Map<string, StoredCard>;
}

function startServer(): Promise<Stand> {
  const received: Received[] = [];
  const cards = new Map<string, StoredCard>([
    [CARD_1, { cardId: CARD_1, cardCommonId: `ccid-${CARD_1}`, name: 'First', widgetCommonId: BOARD, assignments: [] }],
    [CARD_2, { cardId: CARD_2, cardCommonId: `ccid-${CARD_2}`, name: 'Second', widgetCommonId: BOARD, assignments: [] }],
  ]);

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = req.url ?? '';
      const pathOnly = url.split('?')[0].replace('/api/v1', '');
      const body = raw ? JSON.parse(raw) : undefined;
      received.push({ method: req.method ?? '', path: pathOnly, body });

      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (pathOnly.startsWith('/users')) {
        return send(200, {
          entities: [
            { userId: ALICE, name: 'Alice Ahlberg', email: 'alice@example.com' },
            { userId: BOB, name: 'Bob Berg', email: 'bob@example.com' },
          ],
        });
      }

      const single = pathOnly.match(/^\/cards\/([^/]+)$/);
      if (single) {
        const stored = cards.get(single[1]);
        if (!stored) return send(403, { message: 'Access denied' });
        if (req.method === 'GET') return send(200, { ...stored });
        if (req.method === 'PUT') {
          const next: StoredCard = { ...stored, assignments: [...stored.assignments] };
          for (const u of body?.addAssignmentIds ?? []) {
            if (!next.assignments.some((a) => a.userId === u)) next.assignments.push({ userId: u });
          }
          for (const u of body?.removeAssignmentIds ?? []) {
            next.assignments = next.assignments.filter((a) => a.userId !== u);
          }
          cards.set(single[1], next);
          return send(200, { ...next });
        }
      }

      if (pathOnly === '/cards') {
        const commonId = new URLSearchParams(url.split('?')[1] ?? '').get('cardCommonId');
        const entities = [...cards.values()].filter((c) => !commonId || c.cardCommonId === commonId);
        return send(200, { entities: entities.map((c) => ({ ...c })) });
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

const puts = (received: Received[]) => received.filter((r) => r.method === 'PUT');

/** The real path: CSV text in, operations out, transaction executed. */
function opsFromCSV(csv: string) {
  const parsed = parseCSVContent(csv);
  expect(parsed.errors).toEqual([]);
  return parsed.rows.map((row: any) => csvRowToBulkOperation(row));
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise((done) => s.close(() => done(null)))));
});

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.FAVRO_CONFIG_DIR;
  else process.env.FAVRO_CONFIG_DIR = originalConfigDir;
  rmSync(TMP, { recursive: true, force: true });
});

describe('bulk CSV import — the `owner` column', () => {
  it('a display name in `owner` reaches the wire as a userId, and the assignment lands', async () => {
    const stand = await startServer();
    const tx = new BulkTransaction(new CardsAPI(stand.client));
    tx.addAll(opsFromCSV(`card_id,owner\n${CARD_1},Alice Ahlberg\n`));

    const result = await tx.execute();

    expect(result.failure).toBe(0);
    expect(result.success).toBe(1);

    // What the wire received: the verb field, carrying a userId. A raw name here
    // would be a stranger Favro has never seen, written over a wipe.
    const [put] = puts(stand.received);
    expect(put.body.addAssignmentIds).toEqual([ALICE]);
    expect(put.body.assignees).toBeUndefined();

    // What the caller observes on a read-back: the assignment is really there.
    expect(stand.cards.get(CARD_1)!.assignments).toEqual([{ userId: ALICE }]);
  });

  it('an unresolvable `owner` refuses before ANY card is written, not after 399 of them', async () => {
    const stand = await startServer();
    const tx = new BulkTransaction(new CardsAPI(stand.client));
    // Row 1 is fine; row 2 is a typo. Lazily, row 1 lands and is then rolled
    // back — 2 wasted writes here, 798 on a 500-row file, with a partial
    // rollback on the table (#60).
    tx.addAll(opsFromCSV(`card_id,owner\n${CARD_1},Alice Ahlberg\n${CARD_2},Alcie Ahlberg\n`));

    await expect(tx.execute()).rejects.toThrow(AssigneeError);

    expect(puts(stand.received)).toEqual([]);
    expect(stand.cards.get(CARD_1)!.assignments).toEqual([]);
    expect(stand.cards.get(CARD_2)!.assignments).toEqual([]);
  });

  it('a userId already in `owner` needs no lookup and goes straight out', async () => {
    const stand = await startServer();
    const tx = new BulkTransaction(new CardsAPI(stand.client));
    tx.addAll(opsFromCSV(`card_id,owner\n${CARD_1},${BOB}\n`));

    await tx.execute();

    expect(puts(stand.received)[0].body.addAssignmentIds).toEqual([BOB]);
    expect(stand.received.some((r) => r.path.startsWith('/users'))).toBe(false);
  });
});
