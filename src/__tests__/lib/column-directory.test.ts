/**
 * Shared column module (#39): three directions off one org-wide fetch,
 * and refill-before-refuse on a miss.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import ColumnDirectory from '../../lib/column-directory';
import { CACHE_TTL_MS, readCache, writeCache } from '../../lib/name-cache';

const WIDGETS = [
  {
    widgetCommonId: 'board-1',
    name: 'Dev',
    type: 'board',
    columns: [
      { columnId: 'col-1', name: 'To Do' },
      { columnId: 'col-2', name: 'Doing' },
    ],
  },
  {
    widgetCommonId: 'board-2',
    name: 'Ops',
    type: 'board',
    columns: [{ columnId: 'col-3', name: 'Doing' }],
  },
];

/** Minimal stub of FavroHttpClient — only `get` is exercised. */
function makeClient(overrides: { widgets?: any[]; columns?: Record<string, any[]> } = {}) {
  const get = jest.fn(async (url: string, config?: any) => {
    if (url === '/widgets') return { entities: overrides.widgets ?? WIDGETS };
    if (url === '/columns') {
      const boardId = config?.params?.widgetCommonId;
      return { entities: overrides.columns?.[boardId] ?? [] };
    }
    throw new Error(`unexpected GET ${url}`);
  });
  return { client: { get } as any, get };
}

const originalConfigDir = process.env.FAVRO_CONFIG_DIR;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-coldir-test-'));
  process.env.FAVRO_CONFIG_DIR = tmpDir;
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.FAVRO_CONFIG_DIR;
  else process.env.FAVRO_CONFIG_DIR = originalConfigDir;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('org-wide fill', () => {
  test('fills every board’s columns from one GET /widgets', async () => {
    const { client, get } = makeClient();
    const dir = new ColumnDirectory(client, 'org-a');

    const all = await dir.listAll();

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/widgets', { params: {} });
    expect(all).toEqual([
      { columnId: 'col-1', name: 'To Do', boardId: 'board-1' },
      { columnId: 'col-2', name: 'Doing', boardId: 'board-1' },
      { columnId: 'col-3', name: 'Doing', boardId: 'board-2' },
    ]);
  });

  test('persists to the cache, so a second directory does not refetch', async () => {
    await new ColumnDirectory(makeClient().client, 'org-a').listAll();
    const { client, get } = makeClient();

    await new ColumnDirectory(client, 'org-a').listAll();

    expect(get).not.toHaveBeenCalled();
    expect(await readCache('org-a', 'columns')).toHaveLength(3);
  });

  test('refetches once the cache expires', async () => {
    await writeCache('org-a', 'columns', [], Date.now() - CACHE_TTL_MS - 1);
    const { client, get } = makeClient();

    expect(await new ColumnDirectory(client, 'org-a').listAll()).toHaveLength(3);
    expect(get).toHaveBeenCalledTimes(1);
  });

  test('caches per organization', async () => {
    await new ColumnDirectory(makeClient().client, 'org-a').listAll();
    const { get } = makeClient();

    expect(await readCache('org-b', 'columns')).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });
});

describe('three directions off one fetch', () => {
  test('name→id, case-insensitively and across boards', async () => {
    const { client, get } = makeClient();
    const dir = new ColumnDirectory(client, 'org-a');

    expect(await dir.findByName('doing')).toEqual([
      { columnId: 'col-2', name: 'Doing', boardId: 'board-1' },
      { columnId: 'col-3', name: 'Doing', boardId: 'board-2' },
    ]);
    expect(await dir.findByName('Doing', 'board-2')).toEqual([
      { columnId: 'col-3', name: 'Doing', boardId: 'board-2' },
    ]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  test('id→name', async () => {
    const dir = new ColumnDirectory(makeClient().client, 'org-a');
    expect(await dir.nameOf('col-1')).toBe('To Do');
  });

  test('id→board membership', async () => {
    const dir = new ColumnDirectory(makeClient().client, 'org-a');
    expect(await dir.boardOf('col-3')).toBe('board-2');
  });
});

describe('refill before refuse', () => {
  test('a column added after the cache was filled is found via listColumns', async () => {
    // Fresh cache without the new column.
    await writeCache('org-a', 'columns', [{ columnId: 'col-1', name: 'To Do', boardId: 'board-1' }]);
    const { client, get } = makeClient({
      columns: {
        'board-1': [
          { columnId: 'col-1', name: 'To Do', boardId: 'board-1', position: 0 },
          { columnId: 'col-9', name: 'Blocked', boardId: 'board-1', position: 1 },
        ],
      },
    });
    const dir = new ColumnDirectory(client, 'org-a');

    expect(await dir.findByName('Blocked', 'board-1')).toEqual([
      { columnId: 'col-9', name: 'Blocked', boardId: 'board-1' },
    ]);
    expect(get).toHaveBeenCalledWith('/columns', { params: { widgetCommonId: 'board-1' } });
  });

  test('a board top-up keeps the org timestamp so the rest still expires on time', async () => {
    const fetchedAt = Date.now() - CACHE_TTL_MS + 1000;
    await writeCache(
      'org-a',
      'columns',
      [
        { columnId: 'col-1', name: 'To Do', boardId: 'board-1' },
        { columnId: 'col-3', name: 'Doing', boardId: 'board-2' },
      ],
      fetchedAt
    );
    const { client } = makeClient({
      columns: { 'board-1': [{ columnId: 'col-9', name: 'Blocked', boardId: 'board-1' }] },
    });

    await new ColumnDirectory(client, 'org-a').findByName('Blocked', 'board-1');

    const stored = JSON.parse(await fs.readFile(path.join(tmpDir, 'name-cache.json'), 'utf-8'));
    expect(stored['org-a'].columns.fetchedAt).toBe(fetchedAt);
    expect(stored['org-a'].columns.entries).toEqual([
      { columnId: 'col-3', name: 'Doing', boardId: 'board-2' },
      { columnId: 'col-9', name: 'Blocked', boardId: 'board-1' },
    ]);
  });

  test('an id miss refills org-wide before answering undefined', async () => {
    await writeCache('org-a', 'columns', [{ columnId: 'col-1', name: 'To Do', boardId: 'board-1' }]);
    const { client, get } = makeClient();
    const dir = new ColumnDirectory(client, 'org-a');

    expect(await dir.nameOf('col-3')).toBe('Doing');
    expect(get).toHaveBeenCalledWith('/widgets', { params: {} });
  });

  test('refuses only after a refill that still has no match', async () => {
    const { client, get } = makeClient();
    const dir = new ColumnDirectory(client, 'org-a');

    expect(await dir.findByName('Nope')).toEqual([]);
    expect(await dir.nameOf('col-404')).toBeUndefined();
    expect(await dir.boardOf('col-404')).toBeUndefined();
    expect(get.mock.calls.filter(c => c[0] === '/widgets').length).toBeGreaterThanOrEqual(2);
  });

  test('works without an organizationId, just without persistence', async () => {
    const { client, get } = makeClient();
    const dir = new ColumnDirectory(client);

    expect(await dir.nameOf('col-2')).toBe('Doing');
    expect(await dir.nameOf('col-2')).toBe('Doing');
    expect(get).toHaveBeenCalledTimes(2);
  });
});
