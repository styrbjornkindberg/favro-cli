/**
 * Wire-level tests for `favro tracker init` and the tracker mapping — issue #52.
 *
 * What matters here is not what a mock was asked, but what Favro RECEIVES:
 * that adopting a board issues no `POST /widgets`, that scaffolding issues
 * exactly one plus three columns, that an already-present triage tag is not
 * re-created, and — the load-bearing one — that a deleted mapped column
 * produces a refusal with NO second call that would re-point it.
 */
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import { initTracker } from '../commands/tracker-init';
import {
  TrackerConfigError,
  TrackerMapping,
  parseTrackerBlock,
  readTrackerMapping,
  renderTrackerBlock,
  requireTrackerMapping,
  verifyTrackerMapping,
} from '../lib/tracker-config';

const ORG = 'org-1';
const COLL = 'coll-delivery';
const COLL_EMPTY = 'coll-empty';
const COLL_MANY = 'coll-many';
const BOARD = 'board-delivery';
const BOARD_X = 'board-x';
const BOARD_Y = 'board-y';
const TODO = 'col-todo';
const DOING = 'col-doing';
const DONE = 'col-done';

interface Received { method: string; url: string; body?: any }

interface Widget {
  widgetCommonId: string;
  name: string;
  collectionIds: string[];
  columns: Array<{ columnId: string; name: string; position: number }>;
}

/** Every server this file started, so a failed assertion cannot leak one. */
const running: http.Server[] = [];

function startServer(seed?: { tags?: string[] }): Promise<{
  client: FavroHttpClient;
  received: Received[];
  widgets: Widget[];
}> {
  const received: Received[] = [];
  const widgets: Widget[] = [
    {
      widgetCommonId: BOARD,
      name: 'Delivery',
      collectionIds: [COLL],
      columns: [
        { columnId: TODO, name: 'To Do', position: 0 },
        { columnId: DOING, name: 'Doing', position: 1 },
        { columnId: DONE, name: 'Done', position: 2 },
      ],
    },
    { widgetCommonId: BOARD_X, name: 'Board X', collectionIds: [COLL_MANY], columns: [] },
    {
      widgetCommonId: BOARD_Y,
      name: 'Board Y',
      collectionIds: [COLL_MANY],
      columns: [
        { columnId: 'y-doing', name: 'Doing', position: 0 },
        { columnId: 'y-done', name: 'Done', position: 1 },
      ],
    },
  ];
  const tags = (seed?.tags ?? []).map((name, i) => ({ tagId: `tag-${i}`, name }));
  let created = 0;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? JSON.parse(raw) : undefined;
      const url = req.url ?? '';
      const method = req.method ?? '';
      received.push({ method, url, body });

      const query = new URL(url, 'http://x').searchParams;
      let payload: unknown = { entities: [] };

      if (url.startsWith('/api/v1/collections')) {
        payload = {
          entities: [
            { collectionId: COLL, name: 'Delivery' },
            { collectionId: COLL_EMPTY, name: 'Empty' },
            { collectionId: COLL_MANY, name: 'Many' },
          ],
        };
      } else if (url.startsWith('/api/v1/widgets') && method === 'POST') {
        const widget: Widget = {
          widgetCommonId: `board-new-${++created}`,
          name: body.name,
          collectionIds: [body.collectionId],
          columns: [],
        };
        widgets.push(widget);
        payload = widget;
      } else if (url.startsWith('/api/v1/widgets')) {
        const collectionId = query.get('collectionId');
        payload = {
          entities: collectionId ? widgets.filter((w) => w.collectionIds.includes(collectionId)) : widgets,
        };
      } else if (url.startsWith('/api/v1/columns') && method === 'POST') {
        const widget = widgets.find((w) => w.widgetCommonId === body.widgetCommonId)!;
        const column = { columnId: `${widget.widgetCommonId}-${body.name.toLowerCase().replace(/\s+/g, '-')}`, name: body.name, position: body.position ?? widget.columns.length };
        widget.columns.push(column);
        payload = column;
      } else if (url.startsWith('/api/v1/columns')) {
        const widget = widgets.find((w) => w.widgetCommonId === query.get('widgetCommonId'));
        payload = { entities: (widget?.columns ?? []).map((c) => ({ ...c, boardId: widget!.widgetCommonId })) };
      } else if (url.startsWith('/api/v1/tags') && method === 'POST') {
        const tag = { tagId: `tag-new-${tags.length}`, name: body.name };
        tags.push(tag);
        payload = tag;
      } else if (url.startsWith('/api/v1/tags')) {
        payload = { entities: tags };
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
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
        widgets,
      });
    });
  });
}

/**
 * `config.ts` resolves CONFIG_DIR once at import, so the config fallback can
 * only be exercised on a module graph loaded after this test's tmpdir is in
 * the env. Re-import rather than write into the developer's real ~/.favro.
 */
async function freshTrackerConfig(): Promise<typeof import('../lib/tracker-config')> {
  jest.resetModules();
  return import('../lib/tracker-config');
}

const posts = (received: Received[], prefix: string) =>
  received.filter((r) => r.method === 'POST' && r.url.startsWith(`/api/v1/${prefix}`));

const originalConfigDir = process.env.FAVRO_CONFIG_DIR;
const originalDoc = process.env.FAVRO_TRACKER_DOC;
let tmpDir: string;

beforeEach(async () => {
  // The name cache is a real file — give each test its own, so a run never
  // reads or clobbers the developer's own ~/.favro cache.
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-tracker-test-'));
  process.env.FAVRO_CONFIG_DIR = tmpDir;
  process.env.FAVRO_TRACKER_DOC = path.join(tmpDir, 'issue-tracker.md');
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise((done) => s.close(() => done(null)))));
  if (originalConfigDir === undefined) delete process.env.FAVRO_CONFIG_DIR;
  else process.env.FAVRO_CONFIG_DIR = originalConfigDir;
  if (originalDoc === undefined) delete process.env.FAVRO_TRACKER_DOC;
  else process.env.FAVRO_TRACKER_DOC = originalDoc;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('tracker init on the wire', () => {
  it('adopts the collection\'s board — no board is created', async () => {
    const { client, received } = await startServer();
    const result = await initTracker(client, { collectionId: COLL });

    expect(result.scaffolded).toBe(false);
    expect(result.mapping.boardId).toBe(BOARD);
    expect(posts(received, 'widgets')).toHaveLength(0);
    expect(posts(received, 'columns')).toHaveLength(0);
  });

  it('maps two columnIds, not names', async () => {
    const { client } = await startServer();
    const { mapping } = await initTracker(client, { collectionId: COLL });

    expect(mapping.columns).toEqual({ active: DOING, done: DONE });
  });

  it('scaffolds To Do / Doing / Done only when the collection has no board', async () => {
    const { client, received } = await startServer();
    const result = await initTracker(client, { collectionId: COLL_EMPTY });

    expect(result.scaffolded).toBe(true);
    expect(posts(received, 'widgets')).toHaveLength(1);
    expect(posts(received, 'columns').map((r) => r.body.name)).toEqual(['To Do', 'Doing', 'Done']);
    expect(result.activeColumnName).toBe('Doing');
    expect(result.doneColumnName).toBe('Done');
    expect(result.mapping.columns.active).not.toBe(result.mapping.columns.done);
  });

  it('refuses a collection with several boards instead of guessing a primary, and writes nothing', async () => {
    const { client, received } = await startServer();
    const attempt = initTracker(client, { collectionId: COLL_MANY });

    await expect(attempt).rejects.toBeInstanceOf(TrackerConfigError);
    await expect(attempt).rejects.toThrow(BOARD_X);
    await expect(attempt).rejects.toThrow(BOARD_Y);
    expect(received.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('--board settles that tie by name', async () => {
    const { client } = await startServer();
    const result = await initTracker(client, { collectionId: COLL_MANY, board: 'Board Y' });
    expect(result.mapping.boardId).toBe(BOARD_Y);
  }, 10000);

  it('an explicit --active / --done overrides the proposal', async () => {
    const { client } = await startServer();
    const { mapping } = await initTracker(client, { collectionId: COLL, active: 'To Do', done: DONE });

    expect(mapping.columns).toEqual({ active: TODO, done: DONE });
  });

  it('provisions only the triage tags Favro does not already have', async () => {
    const { client, received } = await startServer({ tags: ['needs-triage', 'wontfix'] });
    const result = await initTracker(client, { collectionId: COLL });

    expect(posts(received, 'tags').map((r) => r.body.name).sort()).toEqual([
      'needs-info',
      'ready-for-agent',
      'ready-for-human',
    ]);
    expect(result.tags.existing.sort()).toEqual(['needs-triage', 'wontfix']);
  });
});

describe('the paste-ready block', () => {
  const mapping: TrackerMapping = {
    collectionId: COLL,
    boardId: BOARD,
    columns: { active: DOING, done: DONE },
  };

  it('round-trips through the parser', () => {
    expect(parseTrackerBlock(renderTrackerBlock(mapping))).toEqual(mapping);
  });

  it('survives being pasted into a doc with other content around it', async () => {
    const doc = process.env.FAVRO_TRACKER_DOC!;
    await fs.writeFile(doc, `# Issue tracker\n\nProse.\n\n${renderTrackerBlock(mapping)}\n\n## Later section\n`);

    const stored = await readTrackerMapping();
    expect(stored?.source).toBe('doc');
    expect(stored?.mapping).toEqual(mapping);
  });

  it('init prints the block and never writes the doc', async () => {
    const { client } = await startServer();
    const result = await initTracker(client, { collectionId: COLL });

    expect(parseTrackerBlock(result.block)).toEqual(result.mapping);
    await expect(fs.readFile(process.env.FAVRO_TRACKER_DOC!, 'utf-8')).rejects.toThrow();
  });

  it('the repo doc wins over the config fallback', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'config.json'),
      JSON.stringify({ tracker: { collectionId: 'other', boardId: 'other', columns: { active: 'a', done: 'd' } } })
    );
    await fs.writeFile(process.env.FAVRO_TRACKER_DOC!, renderTrackerBlock(mapping));

    const stored = await (await freshTrackerConfig()).readTrackerMapping();
    expect(stored?.source).toBe('doc');
    expect(stored?.mapping).toEqual(mapping);
  });

  it('falls back to ~/.favro/config.json when there is no repo doc', async () => {
    await fs.writeFile(path.join(tmpDir, 'config.json'), JSON.stringify({ tracker: mapping }));

    const stored = await (await freshTrackerConfig()).readTrackerMapping();
    expect(stored?.source).toBe('config');
    expect(stored?.mapping).toEqual(mapping);
  });

  it('a half-filled block refuses rather than being read as a mapping', async () => {
    await fs.writeFile(
      process.env.FAVRO_TRACKER_DOC!,
      '<!-- favro-tracker -->\n```json\n{"boardId":"b"}\n```\n<!-- /favro-tracker -->'
    );
    await expect(readTrackerMapping()).rejects.toThrow('incomplete');
  });

  it('no mapping anywhere is a refusal that names the fix', async () => {
    await expect(requireTrackerMapping()).rejects.toThrow('favro tracker init');
  });
});

describe('mapping verification', () => {
  const stored = {
    mapping: { collectionId: COLL, boardId: BOARD, columns: { active: DOING, done: DONE } },
    source: 'doc' as const,
    location: '/repo/docs/agents/issue-tracker.md',
  };

  it('costs one call and answers with the current column names', async () => {
    const { client, received } = await startServer();
    const verified = await verifyTrackerMapping(client, stored);

    expect(verified.activeColumnName).toBe('Doing');
    expect(verified.doneColumnName).toBe('Done');
    expect(received).toHaveLength(1);
  });

  it('a rename is not drift — the id still matches', async () => {
    const { client, widgets } = await startServer();
    widgets[0].columns[1].name = 'In Progress';

    expect((await verifyTrackerMapping(client, stored)).activeColumnName).toBe('In Progress');
  });

  it('an added column is not drift either', async () => {
    const { client, widgets } = await startServer();
    widgets[0].columns.push({ columnId: 'col-review', name: 'Review', position: 3 });

    await expect(verifyTrackerMapping(client, stored)).resolves.toBeTruthy();
  });

  it('a deleted mapped column refuses, lists the real columns, and never re-points', async () => {
    const { client, widgets, received } = await startServer();
    widgets[0].columns = widgets[0].columns.filter((c) => c.columnId !== DONE);

    const attempt = verifyTrackerMapping(client, stored);
    await expect(attempt).rejects.toBeInstanceOf(TrackerConfigError);

    const error = (await attempt.catch((e: unknown) => e)) as TrackerConfigError;
    expect(error.kind).toBe('drift');
    expect(error.message).toContain('missing or not visible to your key');
    expect(error.message).toContain(stored.location);
    expect(error.columns.map((c) => c.columnId)).toContain(DOING);
    // No self-heal: one read, no write, and nothing that would settle on a
    // replacement column.
    expect(received.filter((r) => r.method !== 'GET')).toHaveLength(0);
    expect(error.columns.map((c) => c.columnId)).not.toContain(DONE);
  });
});

describe('cli registration', () => {
  it('`favro tracker init --help` is reachable from the real program', async () => {
    const { buildProgram } = await import('../cli');
    const tracker = buildProgram().commands.find((c) => c.name() === 'tracker');
    const init = tracker?.commands.find((c) => c.name() === 'init');

    expect(init).toBeDefined();
    const help = init!.helpInformation();
    expect(help).toContain('--collection');
    expect(help).toContain('--active');
    expect(help).toContain('--done');
  });
});

describe('detectStage', () => {
  it('has exactly one definition in the tree', async () => {
    const { execFileSync } = await import('child_process');
    const hits = execFileSync('grep', ['-rl', 'function detectStage', path.join(__dirname, '..')], {
      encoding: 'utf-8',
    })
      .trim()
      .split('\n')
      .filter((f) => !f.includes('__tests__'));

    expect(hits).toEqual([path.join(__dirname, '..', 'lib', 'workflow-stage.ts')]);
  });

  it('proposes Doing as open and Done as closed', async () => {
    const { proposeColumnMapping } = await import('../lib/workflow-stage');
    const proposal = proposeColumnMapping([
      { columnId: TODO, name: 'To Do' },
      { columnId: DOING, name: 'Doing' },
      { columnId: DONE, name: 'Done' },
    ]);

    expect(proposal.active?.columnId).toBe(DOING);
    expect(proposal.done?.columnId).toBe(DONE);
  });
});
