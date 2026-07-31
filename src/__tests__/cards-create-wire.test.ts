/**
 * Wire-level tests for `cards create` — issue #48.
 *
 * `POST /cards` is one atomic validated call: `parentCardId`, both dependency
 * directions in a single `dependencies` array, `columnId`, `tags` by name and
 * `assignmentIds` are all honoured and validated by the same request. So the
 * only assertion that means anything is the request Favro actually receives —
 * body and query string — plus, on a refusal, that no request was built at all.
 *
 * A client mock cannot see any of this. Favro answers 200 for writes it does not
 * perform (`assignees`, `status`, a whole-array `tags`), so a mock asserting our
 * outgoing shape would happily pin a silent no-op — which is exactly what the
 * old `status: 'todo'` assertion in cards-api.test.ts did.
 */
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import CardsAPI from '../lib/cards-api';
import { ColumnResolutionError } from '../lib/column-directory';
import { CardResolutionError } from '../lib/card-reference';
import { AssigneeError } from '../lib/assignee';

const ORG = 'org-1';
const BOARD = 'board-a';
const DOING = 'col-doing-a';
const ALICE = 'aaaaaaaaaaaaaaaaa';
const BLOCKER = '00000000000000000000ab01';
const BLOCKED = '00000000000000000000ab02';
const PARENT = '00000000000000000000ab03';

interface Received { method: string; url: string; body?: unknown }

/** Every server this file started, so a failed assertion cannot leak one. */
const running: http.Server[] = [];

/**
 * A Favro stand-in. `createStatus` lets a test make the POST itself fail the way
 * Favro fails a bad composite — 403, no card created.
 */
function startServer(opts: { createStatus?: number; createMessage?: string } = {}): Promise<{
  client: FavroHttpClient;
  received: Received[];
}> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = req.url ?? '';
      received.push({
        method: req.method ?? '',
        url,
        body: raw ? JSON.parse(raw) : undefined,
      });

      if (req.method === 'POST' && url.startsWith('/api/v1/cards')) {
        const status = opts.createStatus ?? 200;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(
          status === 200
            ? { cardId: 'new-card', name: 'made', createdAt: '2026-01-01' }
            : { message: opts.createMessage ?? 'Access denied' },
        ));
        return;
      }

      let body: unknown = { entities: [] };
      if (url.startsWith('/api/v1/widgets')) {
        body = {
          entities: [{
            widgetCommonId: BOARD,
            name: 'Board A',
            columns: [{ columnId: DOING, name: 'Doing', position: 0 }],
          }],
        };
      } else if (url.startsWith('/api/v1/tags')) {
        body = { entities: [{ tagId: 'tag-bug', name: 'bug' }, { tagId: 'tag-p1', name: 'P1' }] };
      } else if (url.startsWith('/api/v1/users')) {
        body = { entities: [{ userId: ALICE, name: 'Alice Ahlberg', email: 'alice@example.com' }] };
      } else if (url.startsWith('/api/v1/cards')) {
        // sequentialId lookup — CLA-1800 is the only card that exists.
        body = url.includes('cardSequentialId=1800')
          ? { entities: [{ cardId: BLOCKER, cardCommonId: 'ccid-1800', widgetCommonId: BOARD, name: 'blocker' }] }
          : { entities: [] };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
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
      });
    });
  });
}

const creates = (received: Received[]) =>
  received.filter((r) => r.method === 'POST' && r.url.startsWith('/api/v1/cards'));

const originalConfigDir = process.env.FAVRO_CONFIG_DIR;
let tmpDir: string;

beforeEach(async () => {
  // The name cache is a real file — give each test its own, so a run never
  // reads or clobbers the developer's own ~/.favro cache.
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-createwire-test-'));
  process.env.FAVRO_CONFIG_DIR = tmpDir;
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise((done) => s.close(() => done(null)))));
  if (originalConfigDir === undefined) delete process.env.FAVRO_CONFIG_DIR;
  else process.env.FAVRO_CONFIG_DIR = originalConfigDir;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('cards create is one atomic validated call', () => {
  it('every composite rides ONE POST /cards, with the exact body and query string', async () => {
    const { client, received } = await startServer();

    await new CardsAPI(client).createCard({
      name: 'Ship it',
      description: 'body **text**',
      boardId: BOARD,
      status: 'Doing',
      tags: ['bug'],
      assignees: ['alice@example.com'],
      parentCardId: PARENT,
      blockedBy: ['CLA-1800'],
      blocks: [BLOCKED],
    });

    const posts = creates(received);
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('/api/v1/cards?descriptionFormat=markdown');
    expect(posts[0].body).toEqual({
      name: 'Ship it',
      // `description` never reaches the wire; `detailedDescription` is the field.
      detailedDescription: 'body **text**',
      widgetCommonId: BOARD,
      columnId: DOING,
      tags: ['bug'],
      assignmentIds: [ALICE],
      parentCardId: PARENT,
      // Both directions in ONE array — two edges from one create.
      dependencies: [
        { cardId: BLOCKER, isBefore: true },
        { cardId: BLOCKED, isBefore: false },
      ],
    });
  });

  it('no follow-up write happens after the create', async () => {
    const { client, received } = await startServer();

    await new CardsAPI(client).createCard({
      name: 'Ship it',
      boardId: BOARD,
      tags: ['bug'],
      blockedBy: [BLOCKER],
      assignees: [ALICE],
    });

    const writes = received.filter((r) => r.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe('POST');
  });

  it('a status name resolves to columnId — Favro has no status field on POST', async () => {
    const { client, received } = await startServer();
    await new CardsAPI(client).createCard({ name: 'c', boardId: BOARD, status: '  doing ' });

    const body = creates(received)[0].body as Record<string, unknown>;
    expect(body.columnId).toBe(DOING);
    expect(body).not.toHaveProperty('status');
  });

  it('a raw columnId passes through untouched', async () => {
    const { client, received } = await startServer();
    await new CardsAPI(client).createCard({ name: 'c', boardId: BOARD, status: DOING });

    expect((creates(received)[0].body as Record<string, unknown>).columnId).toBe(DOING);
  });

  it('tags ride the wire as NAMES in the workspace spelling, never as tagIds', async () => {
    const { client, received } = await startServer();
    await new CardsAPI(client).createCard({ name: 'c', boardId: BOARD, tags: ['BUG', ' p1 '] });

    const body = creates(received)[0].body as Record<string, unknown>;
    expect(body.tags).toEqual(['bug', 'P1']);
    expect(body).not.toHaveProperty('tagIds');
  });

  it('a userId assignee needs no lookup and still leaves as assignmentIds', async () => {
    const { client, received } = await startServer();
    await new CardsAPI(client).createCard({ name: 'c', boardId: BOARD, assignees: [ALICE] });

    const body = creates(received)[0].body as Record<string, unknown>;
    expect(body.assignmentIds).toEqual([ALICE]);
    // `assignees` is a silent no-op on both verbs — it must never reach Favro.
    expect(body).not.toHaveProperty('assignees');
  });
});

describe('a bad composite fails the whole create with no card behind it', () => {
  it('an unknown tag name is refused CLIENT-SIDE — no POST is built', async () => {
    const { client, received } = await startServer();

    await expect(
      new CardsAPI(client).createCard({ name: 'c', boardId: BOARD, tags: ['buhg'] }),
    ).rejects.toThrow(/Unknown tag "buhg"/);

    expect(creates(received)).toHaveLength(0);
  });

  it('the tag refusal never creates the tag it did not find', async () => {
    const { client, received } = await startServer();

    await expect(
      new CardsAPI(client).createCard({ name: 'c', boardId: BOARD, tags: ['buhg'] }),
    ).rejects.toThrow();

    expect(received.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('an unknown column refuses before the request is built', async () => {
    const { client, received } = await startServer();

    await expect(
      new CardsAPI(client).createCard({ name: 'c', boardId: BOARD, status: 'Nowhere' }),
    ).rejects.toThrow(ColumnResolutionError);

    expect(creates(received)).toHaveLength(0);
  });

  it('an unknown assignee refuses before the request is built', async () => {
    const { client, received } = await startServer();

    await expect(
      new CardsAPI(client).createCard({ name: 'c', boardId: BOARD, assignees: ['Nobody Here'] }),
    ).rejects.toThrow(AssigneeError);

    expect(creates(received)).toHaveLength(0);
  });

  it('an unresolvable dependency target refuses before the request is built', async () => {
    const { client, received } = await startServer();

    await expect(
      new CardsAPI(client).createCard({ name: 'c', boardId: BOARD, blocks: ['CLA-9999'] }),
    ).rejects.toThrow(CardResolutionError);

    expect(creates(received)).toHaveLength(0);
  });

  it("Favro's own 403 on the create surfaces to the caller — one attempt, no retry", async () => {
    const { client, received } = await startServer({ createStatus: 403, createMessage: 'Invalid column' });

    await expect(
      new CardsAPI(client).createCard({ name: 'c', boardId: BOARD, columnId: 'col-from-another-board' }),
    ).rejects.toThrow();

    // The create is atomic: it either made the card or it made nothing. One
    // attempt, and nothing to compensate.
    expect(creates(received)).toHaveLength(1);
  });
});
