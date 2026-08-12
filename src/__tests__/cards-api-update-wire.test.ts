/**
 * Wire-level tests for the card update path — issue #49.
 *
 * Same discipline as the tag wire suite: no client mock. A real `node:http`
 * server stands in for Favro, so the axios stack builds the URL and serialises
 * the body, and every assertion is about what Favro actually RECEIVES. A mock
 * could not catch any of these bugs — Favro's honoured 200 and Favro's silent
 * 200 are byte-identical to a mock.
 *
 * Pinned to the live probes recorded on #49 / #36:
 *
 * - `PUT {assignees:[…]}`     → 200, assignments unchanged (silent no-op).
 * - `PUT {assignmentIds:[…]}` → 200, assignments unchanged (silent no-op too;
 *                               `assignmentIds` is honoured on POST only).
 * - `PUT {addAssignmentIds}` / `{removeAssignmentIds}` → honoured, and forgiving:
 *                               re-adding and removing-what-is-absent both 200.
 * - `PUT {status:"Done"}`     → 200, nothing written. The column IS the status,
 *                               so a write has to become `columnId`.
 * - `PUT {dependencies}`      → silent no-op; `parentCardId` → 202 "Access denied";
 *                               `parentCardId: null` → 400. Hence no `--parent`
 *                               on update and no unparent flag — nothing to test
 *                               here beyond the field being gone from the type.
 */
import * as http from 'http';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import CardsAPI from '../lib/cards-api';
import { ColumnResolutionError } from '../lib/column-directory';
import { AssigneeError } from '../lib/assignee';
import { tempConfigDir } from '../test-support/config-dir';

// The name cache resolves its file per call, so a tmpdir here keeps the suite
// off the real `~/.favro` — a cache invalidation with no organizationId rewrites
// the whole file.
tempConfigDir('favro-update-wire-');

interface Received {
  method: string;
  url: string;
  body: string;
}

const CARD = '713db3018af39956227d4279';
const BOARD = 'w1BoardCommonId';
const OTHER_BOARD = 'w2BoardCommonId';
const TODO = 'col-todo';
const DONE = 'col-done';
const SHIPPED = 'col-shipped';
const ALICE = 'aaaaaaaaaaaaaaaaa';
const BOB = 'bbbbbbbbbbbbbbbbb';

function startServer(
  handler: (req: Received) => { status: number; body?: unknown },
): Promise<{ api: CardsAPI; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const entry = { method: req.method ?? '', url: req.url ?? '', body };
      received.push(entry);
      const { status, body: out } = handler(entry);
      if (out === undefined) {
        res.writeHead(status);
        res.end();
        return;
      }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const client = new FavroHttpClient({ baseURL: `http://127.0.0.1:${port}/api/v1` });
      resolve({
        api: new CardsAPI(client as any),
        received,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * Favro as far as the update path cares: two boards with columns, and one card
 * on BOARD sitting in "To Do" with `assignments` as Favro sends them.
 */
function favro(card: Record<string, unknown> = {}) {
  const stored = {
    cardId: CARD,
    name: 'probe',
    widgetCommonId: BOARD,
    columnId: TODO,
    assignments: [{ userId: ALICE }],
    ...card,
  };
  return (req: Received) => {
    if (req.method === 'GET' && req.url?.startsWith('/api/v1/widgets')) {
      return {
        status: 200,
        body: {
          entities: [
            {
              widgetCommonId: BOARD,
              name: 'Delivery',
              columns: [
                { columnId: TODO, name: 'To Do' },
                { columnId: DONE, name: 'Done' },
              ],
            },
            {
              widgetCommonId: OTHER_BOARD,
              name: 'Ops',
              columns: [{ columnId: SHIPPED, name: 'Shipped' }],
            },
          ],
        },
      };
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/v1/tags')) {
      return { status: 200, body: { entities: [] } };
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/v1/users')) {
      return {
        status: 200,
        body: {
          entities: [
            { userId: ALICE, name: 'Alice Ant', email: 'alice@example.com' },
            { userId: BOB, name: 'Bob Builder', email: 'bob@example.com' },
          ],
        },
      };
    }
    return { status: 200, body: stored };
  };
}

function putRequest(received: Received[]): Received {
  const put = received.find((r) => r.method === 'PUT');
  if (!put) throw new Error('no PUT was sent');
  return put;
}

const putBody = (received: Received[]): Record<string, unknown> => JSON.parse(putRequest(received).body);

const cardReads = (received: Received[]): Received[] =>
  received.filter((r) => r.method === 'GET' && r.url.startsWith(`/api/v1/cards/${CARD}`));

describe('updateCard assignee writes (no client mock)', () => {
  test('never sends `assignees` — Favro 200s on it and changes nothing', async () => {
    const { api, received, close } = await startServer(favro());
    try {
      await api.updateCard(CARD, { assignees: [ALICE, BOB] });
      const body = putBody(received);
      expect(body).not.toHaveProperty('assignees');
      expect(body).not.toHaveProperty('assignmentIds');
    } finally {
      await close();
    }
  });

  test('diffs a whole-array write into add/removeAssignmentIds', async () => {
    // Card holds alice; caller wants bob only → add bob, remove alice.
    const { api, received, close } = await startServer(favro());
    try {
      await api.updateCard(CARD, { assignees: [BOB] });
      expect(putBody(received)).toEqual({
        addAssignmentIds: [BOB],
        removeAssignmentIds: [ALICE],
      });
    } finally {
      await close();
    }
  });

  test('clearing assignees removes every current one — the case the old add-only flag could not express', async () => {
    const { api, received, close } = await startServer(
      favro({ assignments: [{ userId: ALICE }, { userId: BOB }] }),
    );
    try {
      await api.updateCard(CARD, { assignees: [] });
      expect(putBody(received)).toEqual({ removeAssignmentIds: [ALICE, BOB] });
    } finally {
      await close();
    }
  });

  test('an unchanged set produces no add and no remove', async () => {
    const { api, received, close } = await startServer(favro());
    try {
      await api.updateCard(CARD, { assignees: [ALICE] });
      expect(putBody(received)).toEqual({});
    } finally {
      await close();
    }
  });

  // #59 / #60: `updateCard` is the chokepoint every whole-array assignee write
  // funnels through — batch-smart's composed array, bulk's CSV `owner` column,
  // `cards update --assignee`. Resolving here is what stops a display name being
  // diffed into "unassign everyone, add a stranger".
  test('a display name is resolved to a userId and diffed — never sent raw', async () => {
    const { api, received, close } = await startServer(favro());
    try {
      await api.updateCard(CARD, { assignees: ['Bob Builder'] });
      expect(putBody(received)).toEqual({
        addAssignmentIds: [BOB],
        removeAssignmentIds: [ALICE],
      });
      // The name itself must not reach Favro under any key.
      expect(putRequest(received).body).not.toContain('Bob Builder');
    } finally {
      await close();
    }
  });

  test('an email resolves too, and a name already on the card is a no-op', async () => {
    const { api, received, close } = await startServer(favro());
    try {
      await api.updateCard(CARD, { assignees: ['alice@example.com'] });
      expect(putBody(received)).toEqual({});
    } finally {
      await close();
    }
  });

  test('a name and its own userId in one array do not double-add', async () => {
    const { api, received, close } = await startServer(favro());
    try {
      await api.updateCard(CARD, { assignees: ['Bob Builder', BOB] });
      expect(putBody(received)).toEqual({
        addAssignmentIds: [BOB],
        removeAssignmentIds: [ALICE],
      });
    } finally {
      await close();
    }
  });

  test('an unresolvable name refuses before the PUT, leaving the card untouched', async () => {
    const { api, received, close } = await startServer(favro());
    try {
      await expect(api.updateCard(CARD, { assignees: ['Nobody Here'] })).rejects.toThrow(AssigneeError);
      expect(received.some((r) => r.method === 'PUT')).toBe(false);
    } finally {
      await close();
    }
  });

  test('an all-userId array costs no /users read', async () => {
    // The undo and tx paths hand back ids. Resolving those would add a read per
    // write for nothing.
    const { api, received, close } = await startServer(favro());
    try {
      await api.updateCard(CARD, { assignees: [BOB] });
      expect(received.filter((r) => r.url.startsWith('/api/v1/users'))).toEqual([]);
    } finally {
      await close();
    }
  });

  test('add/removeAssignmentIds pass straight through and cost no extra reads', async () => {
    const { api, received, close } = await startServer(favro());
    try {
      await api.updateCard(CARD, { addAssignmentIds: [BOB], removeAssignmentIds: [ALICE] });
      expect(received).toHaveLength(1);
      expect(received[0].method).toBe('PUT');
      expect(JSON.parse(received[0].body)).toEqual({
        addAssignmentIds: [BOB],
        removeAssignmentIds: [ALICE],
      });
    } finally {
      await close();
    }
  });
});

describe('updateCard status writes are a column move (no client mock)', () => {
  test('a column name becomes columnId on the card\'s own board, and `status` never ships', async () => {
    const { api, received, close } = await startServer(favro());
    try {
      await api.updateCard(CARD, { status: 'Done' });
      const body = putBody(received);
      expect(body).toEqual({ columnId: DONE });
      expect(body).not.toHaveProperty('status');
    } finally {
      await close();
    }
  });

  test('matches the column name case-insensitively', async () => {
    const { api, received, close } = await startServer(favro());
    try {
      await api.updateCard(CARD, { status: 'done' });
      expect(putBody(received)).toEqual({ columnId: DONE });
    } finally {
      await close();
    }
  });

  test('a columnId is accepted as-is', async () => {
    const { api, received, close } = await startServer(favro());
    try {
      await api.updateCard(CARD, { status: DONE });
      expect(putBody(received)).toEqual({ columnId: DONE });
    } finally {
      await close();
    }
  });

  test('an unknown name refuses with that board\'s real columns, and writes nothing', async () => {
    const { api, received, close } = await startServer(favro());
    try {
      await expect(api.updateCard(CARD, { status: 'Shipped' })).rejects.toThrow(ColumnResolutionError);
      await expect(api.updateCard(CARD, { status: 'Shipped' })).rejects.toThrow(/To Do[\s\S]*Done/);
      expect(received.some((r) => r.method === 'PUT')).toBe(false);
    } finally {
      await close();
    }
  });

  test('a column on another board is refused rather than silently moving the card there', async () => {
    const { api, received, close } = await startServer(favro());
    try {
      await expect(api.updateCard(CARD, { status: SHIPPED })).rejects.toThrow(ColumnResolutionError);
      expect(received.some((r) => r.method === 'PUT')).toBe(false);
    } finally {
      await close();
    }
  });

  test('when the same write moves boards, the name resolves against the TARGET board', async () => {
    const { api, received, close } = await startServer(favro());
    try {
      await api.updateCard(CARD, { boardId: OTHER_BOARD, status: 'Shipped' });
      expect(putBody(received)).toEqual({ widgetCommonId: OTHER_BOARD, columnId: SHIPPED });
    } finally {
      await close();
    }
  });
});

describe('updateCard archive writes send `archive`, never `archived` (#75)', () => {
  // The trap this suite exists for. Measured live: `PUT {archive:true}` is
  // honoured, `PUT {archived:true}` — the spelling a card reads BACK, and so the
  // one a future reader reaches for — answers 200 and writes nothing. Every
  // assertion below is on the SERIALISED body, not on a call shape, because a
  // mock cannot tell Favro's honoured 200 from Favro's silent one.
  test('sends the `archive` field and nothing named `archived`', async () => {
    const { api, received, close } = await startServer(favro());
    try {
      await api.updateCard(CARD, { archive: true });
      const put = putRequest(received);
      expect(JSON.parse(put.body)).toEqual({ archive: true });
      // On the raw bytes: `archived` must not appear at all. `toEqual` above
      // already excludes the key, but the substring check is what fails loudly
      // if someone "helpfully" forwards both spellings.
      expect(put.body).not.toContain('archived');
    } finally {
      await close();
    }
  });

  test('un-archiving sends `archive:false` — false is a value, not an omission', async () => {
    const { api, received, close } = await startServer(favro({ archived: true }));
    try {
      await api.updateCard(CARD, { archive: false });
      expect(JSON.parse(putRequest(received).body)).toEqual({ archive: false });
    } finally {
      await close();
    }
  });

  test('neither spelling rides the QUERY string — unlike descriptionFormat (#17)', async () => {
    const { api, received, close } = await startServer(favro());
    try {
      await api.updateCard(CARD, { archive: true });
      const put = putRequest(received);
      // `descriptionFormat` is the one parameter this PUT carries, and it is
      // there because Favro genuinely only reads it from the query string. The
      // archive flag is NOT in that family: probed as a body field only, so a
      // query parameter here would be a silent no-op.
      expect(put.url).not.toContain('archive=');
      expect(put.url).toBe(`/api/v1/cards/${CARD}?descriptionFormat=markdown`);
    } finally {
      await close();
    }
  });

  test('composes with another field in ONE PUT, and needs no card read of its own', async () => {
    const { api, received, close } = await startServer(favro());
    try {
      await api.updateCard(CARD, { archive: true, name: 'renamed' });
      expect(JSON.parse(putRequest(received).body)).toEqual({ archive: true, name: 'renamed' });
      // `archive` is a straight pass-through, so unlike status/assignees/tags it
      // buys no read.
      expect(cardReads(received)).toHaveLength(0);
    } finally {
      await close();
    }
  });
});

describe('updateCard shared read and description bytes', () => {
  test('status, assignees and tags together cost exactly one card read', async () => {
    const { api, received, close } = await startServer(favro());
    try {
      await api.updateCard(CARD, { status: 'Done', assignees: [BOB], tags: [] });
      expect(cardReads(received)).toHaveLength(1);
      expect(putBody(received)).toEqual({
        columnId: DONE,
        addAssignmentIds: [BOB],
        removeAssignmentIds: [ALICE],
      });
    } finally {
      await close();
    }
  });

  test('`- [ ]` checkboxes survive a body rewrite byte-for-byte', async () => {
    // The old append path read the description back (tasklist lines and all) and
    // wrote it out again. A whole body written straight through is byte-clean,
    // and `descriptionFormat` rides the query string where Favro reads it.
    const description = '# Plan\n\n- [ ] first\n- [x] second\n';
    const { api, received, close } = await startServer(favro());
    try {
      await api.updateCard(CARD, { description });
      const put = putRequest(received);
      expect(JSON.parse(put.body)).toEqual({ detailedDescription: description });
      expect(put.body).not.toContain('​');
      expect(put.url).toContain('descriptionFormat=markdown');
    } finally {
      await close();
    }
  });
});
