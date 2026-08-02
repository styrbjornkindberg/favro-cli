/**
 * Pagination against a real server (#91).
 *
 * Every paginated list in this CLI feeds a client-side filter, so a loop that
 * silently drops a page answers a plausible wrong number. Queued mocks hide
 * that: they hand back the next canned page whatever cursor was asked for. This
 * file serves pages *by the `page` query parameter*, so a skipped or repeated
 * cursor shows up as missing or duplicated rows, not as a passing test.
 *
 * Favro's cursor is 0-based, the first request carries no cursor at all, and
 * `requestId` from the first response is what opens it.
 */
import http from 'http';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import { getAllPages } from '../lib/paginate';
import { BoardsAPI } from '../lib/boards-api';
import { CollectionsAPI } from '../lib/collections-api';
import { ColumnsAPI } from '../lib/columns-api';
import { TagsAPI } from '../lib/tags-api';

const ORG = 'org-1';

/** Every server this file started, so a failed assertion cannot leak one. */
const running: http.Server[] = [];

interface Served {
  /** The cursor the client asked for — `undefined` on the opening request. */
  page?: string;
  /** The page size asked for, when the caller capped the fetch. */
  limit?: string;
  path: string;
}

/**
 * A Favro stand-in that serves page N of `pages` for `?page=N`, two entities
 * per page, named after the page they came from.
 */
function startServer(pages: number): Promise<{ client: FavroHttpClient; served: Served[] }> {
  const served: Served[] = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://x');
    const raw = url.searchParams.get('page');
    served.push({
      page: raw ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
      path: url.pathname,
    });

    const page = raw === null ? 0 : Number(raw);
    const entities = page >= pages ? [] : [0, 1].map((i) => ({
      widgetCommonId: `p${page}-${i}`,
      collectionId: `p${page}-${i}`,
      columnId: `p${page}-${i}`,
      tagId: `p${page}-${i}`,
      name: `p${page}-${i}`,
      position: page * 2 + i,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ entities, requestId: 'req-1', pages, page }));
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
        served,
      });
    });
  });
}

const originalConfigDir = process.env.FAVRO_CONFIG_DIR;
let tmpDir: string;

beforeEach(async () => {
  // The name cache is a real file — give each test its own, so a run never
  // reads or clobbers the developer's own ~/.favro cache.
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-pagination-test-'));
  process.env.FAVRO_CONFIG_DIR = tmpDir;
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise((done) => s.close(() => done(null)))));
  if (originalConfigDir === undefined) delete process.env.FAVRO_CONFIG_DIR;
  else process.env.FAVRO_CONFIG_DIR = originalConfigDir;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** The opening request carries no cursor; every later one is 0-based and consecutive. */
const cursors = (served: Served[]) => served.map((s) => s.page);

describe('a paginated read visits every page, in order (#91)', () => {
  it('boards: three pages, six boards, cursors 0..2', async () => {
    const { client, served } = await startServer(3);
    const boards = await new BoardsAPI(client).listBoards();

    expect(cursors(served)).toEqual([undefined, '1', '2']);
    expect(boards.map((b) => b.boardId)).toEqual([
      'p0-0', 'p0-1', 'p1-0', 'p1-1', 'p2-0', 'p2-1',
    ]);
  });

  it('boards by collection: the collection resolve sees page 1 too', async () => {
    const { client } = await startServer(3);
    // "p1-0" only exists on page 1 of /collections — a resolve built on a
    // truncated listing refuses a collection that is really there.
    const boards = await new BoardsAPI(client).listBoardsByCollection('p1-0');

    expect(boards.map((b) => b.boardId)).toEqual([
      'p0-0', 'p0-1', 'p1-0', 'p1-1', 'p2-0', 'p2-1',
    ]);
  });

  it('collections: three pages, no page dropped', async () => {
    const { client, served } = await startServer(3);
    const collections = await new CollectionsAPI(client).listCollections();

    expect(cursors(served)).toEqual([undefined, '1', '2']);
    expect(collections.map((c) => c.collectionId)).toEqual([
      'p0-0', 'p0-1', 'p1-0', 'p1-1', 'p2-0', 'p2-1',
    ]);
  });

  it('columns: three pages, no page dropped', async () => {
    const { client, served } = await startServer(3);
    const columns = await new ColumnsAPI(client).listColumns('board-1');

    expect(cursors(served)).toEqual([undefined, '1', '2']);
    expect(columns.map((c) => c.columnId)).toEqual([
      'p0-0', 'p0-1', 'p1-0', 'p1-1', 'p2-0', 'p2-1',
    ]);
  });

  it('tags: three pages, no page dropped', async () => {
    const { client } = await startServer(3);
    const tags = await new TagsAPI(client).listTags();

    expect(tags.map((t) => t.tagId)).toEqual([
      'p0-0', 'p0-1', 'p1-0', 'p1-1', 'p2-0', 'p2-1',
    ]);
  });

  it('a single-page list is one call and no cursor', async () => {
    const { client, served } = await startServer(1);
    const boards = await new BoardsAPI(client).listBoards();

    expect(cursors(served)).toEqual([undefined]);
    expect(boards).toHaveLength(2);
  });
});

describe('the pager itself (#91)', () => {
  interface Row { name: string }

  it('reads to completion when no cap is asked for', async () => {
    const { client } = await startServer(4);
    const rows = await getAllPages<Row>(client, '/anything');

    expect(rows).toHaveLength(8);
  });

  it('a cap stops the fetch and shrinks the page it asks for', async () => {
    const { client, served } = await startServer(4);
    const rows = await getAllPages<Row>(client, '/anything', {}, { max: 3 });

    // 2 per page: page 0 fills 2 of 3, so the next page asks for the 1 that is left.
    expect(rows.map((r) => r.name)).toEqual(['p0-0', 'p0-1', 'p1-0']);
    expect(served).toHaveLength(2);
    expect(served[1].limit).toBe('1');
  });

  it('a cap of zero makes no call at all', async () => {
    const { client, served } = await startServer(4);

    await expect(getAllPages<Row>(client, '/anything', {}, { max: 0 })).resolves.toEqual([]);
    expect(served).toHaveLength(0);
  });

  it('stops at the last page rather than asking for one past the end', async () => {
    // `pages` alone is enough to terminate — a locally-counted `page < pages`
    // cannot spin. What this pins is the off-by-one at the *other* end: nine of
    // the old loops ran one iteration too many and requested a page that does
    // not exist. The empty-page guard in the pager is load-bearing for a
    // different case (`cards-api.test.ts` — a page can come back empty while
    // `pages` still claims more), not for this one.
    const { client, served } = await startServer(2);
    const rows = await getAllPages<Row>(client, '/anything');

    expect(rows).toHaveLength(4);
    expect(served).toHaveLength(2);
  });
});

// ─── the ratchet ─────────────────────────────────────────────────────────────

/**
 * One pager, and no twentieth hand-rolled loop (#91).
 *
 * Nothing above goes red if a new module writes its own cursor loop, and that
 * is exactly how nine wrong ones survived years of green suites: each was
 * covered by a queued mock that answered whatever page it was asked for. The
 * cheapest guard is to make the cursor itself unspellable outside the pager —
 * any loop must read `response.requestId` to continue, so that is what this
 * matches. Comments and the `requestId?: string` field on `PaginatedResponse`
 * are not uses and do not trip it.
 *
 * If you are here because this failed: you almost certainly want
 * `getAllPages` from `src/lib/paginate.ts`. If you genuinely need a bespoke
 * loop, add the file to `PAGES_ITSELF` with a comment saying why.
 */
const PAGES_ITSELF = ['src/lib/paginate.ts'];

/** Reading the cursor off a response, assigning it, or passing it along. */
const CURSOR_USE = /\.requestId\b|\brequestId\s*=|\brequestId,/;

const REPO_ROOT = path.resolve(__dirname, '../..');

/** Every `.ts` file under `src`, repo-relative, tests excluded. */
function sourceFiles(dir = 'src'): string[] {
  return fsSync.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(rel);
    return entry.name.endsWith('.ts') ? [rel] : [];
  });
}

describe('the pager is the only pager (#91)', () => {
  it('no module outside paginate.ts touches a pagination cursor', () => {
    const offenders = sourceFiles()
      .filter((file) => !PAGES_ITSELF.includes(file))
      .filter((file) => CURSOR_USE.test(fsSync.readFileSync(path.join(REPO_ROOT, file), 'utf-8')));

    expect(offenders).toEqual([]);
  });

  it('the ratchet is actually looking at the tree', () => {
    // A scan that silently matched nothing would pass the test above forever.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain('src/lib/paginate.ts');
    expect(CURSOR_USE.test(fsSync.readFileSync(path.join(REPO_ROOT, 'src/lib/paginate.ts'), 'utf-8')))
      .toBe(true);
  });
});
