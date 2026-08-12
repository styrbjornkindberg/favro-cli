/**
 * `--include stats,velocity` against a real server that answers what Favro
 * actually answers.
 *
 * WHY THIS FILE EXISTS AND WHY IT IS NOT A MOCK. The defect it pins shipped
 * because a hand-written fixture gave a widget a `cards` array. Every counter in
 * `lib/boards-api.ts` was then tested against that fixture, agreed with it, and
 * the live wire disagreed with all of it — so `favro boards get <b> --include
 * stats` printed `Done cards: 0` and `Overdue cards: 0` for every board there
 * has ever been, as measured fact. A mock cannot catch that class: it asserts
 * the fixture. So the payload below is the MEASURED one, served over a real
 * `node:http` socket, and the assertions are on what the COMMAND PRINTS, because
 * the printed line is the contract a reader and a `jq` pipeline both consume.
 *
 * The measurement, probed against a throwaway board on 2026-08-12:
 *
 *     GET /widgets/{id}?include=cards
 *       keys: archived, collectionIds, color, columns, editRole, name,
 *             organizationId, ownerRole, type, widgetCommonId
 *       has cards array: false
 *
 * Read that key list twice. There is no `cards` — not empty, absent — and no
 * `cardCount` either. `include=cards` does nothing on that endpoint.
 *
 * What the server below asserts is exactly that key SET. The values are the
 * test's own, and only `name`, `widgetCommonId` and `collectionIds` are
 * load-bearing; `columns` is served as an empty array because only the presence
 * of the key was measured, never its contents, and nothing here reads them.
 *
 * ALL FOUR ATTACH PATHS ARE COVERED, because a guard is only as good as its
 * least-covered caller: `boards get` (`getBoardWithIncludes`), `boards list`
 * (the `withBoardIncludes` map in `commands/boards-list.ts`) and `boards list
 * <collection>` (`listBoardsByCollection`), each in both output modes.
 */
import http from 'http';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import { Command } from 'commander';
import FavroHttpClient from '../lib/http-client';
import * as clientFactory from '../lib/client-factory';
import { registerBoardsGetCommand } from '../commands/boards-get';
import { registerBoardsListCommand } from '../commands/boards-list';

const ORG = 'org-1';
const BOARD = 'board-1';
const COLLECTION = 'coll-1';

/**
 * The measured `/widgets/{id}?include=cards` response, key for key. Adding
 * `cards` or `cardCount` here to make a test pass is the mistake this file was
 * written to prevent — measure the endpoint again first, and quote the probe.
 */
const MEASURED_WIDGET = {
  archived: false,
  collectionIds: [COLLECTION],
  color: 'blue',
  columns: [],
  editRole: 'guests',
  name: 'Probe Board',
  organizationId: ORG,
  ownerRole: 'guests',
  type: 'backlog',
  widgetCommonId: BOARD,
};

const servers: http.Server[] = [];
let logged: string[] = [];
let logSpy: jest.SpyInstance;
let tmpDir: string;
const originalConfigDir = process.env.FAVRO_CONFIG_DIR;

/** Serves the measured widget for `/widgets`, and one collection for the resolve. */
function startServer(): Promise<number> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://x');
    const entity = url.pathname.startsWith('/api/v1/collections')
      ? { collectionId: COLLECTION, name: 'Collection 1', createdAt: '2026-01-01', updatedAt: '2026-01-01' }
      : MEASURED_WIDGET;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    // A single-entity read wants the bare object; a list read wants the envelope.
    res.end(JSON.stringify(
      url.pathname === `/api/v1/widgets/${BOARD}`
        ? entity
        : { entities: [entity], requestId: 'req-1', pages: 1, page: 0 },
    ));
  });
  servers.push(server);

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

/** The whole runner, the whole formatter — only the base URL is ours. */
async function cli(port: number, argv: string[]): Promise<string> {
  jest.spyOn(clientFactory, 'createFavroClient').mockResolvedValue(
    new FavroHttpClient({
      baseURL: `http://127.0.0.1:${port}/api/v1`,
      auth: { token: 'test-token', email: 'test@example.com', organizationId: ORG },
    }),
  );

  const program = new Command();
  program.option('--human').option('--pretty').option('--verbose');
  program.exitOverride();
  const boards = program.command('boards');
  registerBoardsGetCommand(boards);
  registerBoardsListCommand(boards);

  logged = [];
  await program.parseAsync(['node', 'cli', 'boards', ...argv]);
  return logged.join('\n');
}

beforeEach(async () => {
  process.exitCode = undefined;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-board-stats-test-'));
  process.env.FAVRO_CONFIG_DIR = tmpDir;
  logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  });
  // `console.table` writes through its own channel; the rows are asserted from
  // the JSON arm, so it is enough here that it does not reach the reporter.
  jest.spyOn(console, 'table').mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise(done => s.close(() => done(null)))));
  jest.restoreAllMocks();
  logSpy.mockRestore();
  if (originalConfigDir === undefined) delete process.env.FAVRO_CONFIG_DIR;
  else process.env.FAVRO_CONFIG_DIR = originalConfigDir;
  await fs.rm(tmpDir, { recursive: true, force: true });
  process.exitCode = undefined;
});

/** The single JSON document a read wrote to stdout. */
const parse = (out: string): any =>
  JSON.parse(out.split('\n').find(line => line.startsWith('{'))!);

describe('a card facet with no measured source is never printed as a number', () => {
  it('boards get --human: all four stats read unknown, and none reads 0', async () => {
    const out = await cli(await startServer(), [
      'get', BOARD, '--include', 'stats', '--human',
    ]);

    expect(out).toContain('Total cards:   unknown');
    expect(out).toContain('Open cards:    unknown');
    expect(out).toContain('Done cards:    unknown');
    expect(out).toContain('Overdue cards: unknown');
    // The regression itself, spelled as the string it used to print.
    expect(out).not.toMatch(/cards:\s+0\b/);
    expect(process.exitCode).toBeUndefined();
  });

  it('boards get --human: the unknowns carry a remedy, so the section stays actionable (ADR-0002)', async () => {
    const out = await cli(await startServer(), [
      'get', BOARD, '--include', 'stats,velocity', '--human',
    ]);

    expect(out).toContain('Stats:');
    expect(out).toContain('Velocity (weekly):');
    expect(out).toMatch(/Note: .*unknown, not zero/);
    expect(out).toContain('favro columns list <boardId>');
  });

  it('boards get --json: every facet is null, and null is not 0', async () => {
    const board = parse(await cli(await startServer(), [
      'get', BOARD, '--include', 'stats,velocity',
    ]));

    expect(board.stats).toEqual({
      totalCards: null,
      doneCards: null,
      openCards: null,
      overdueCards: null,
    });
    expect(board.velocity).toHaveLength(4);
    for (const week of board.velocity) {
      expect(typeof week.period).toBe('string');
      expect(week.completed).toBeNull();
      expect(week.added).toBeNull();
      expect(week.netChange).toBeNull();
    }
    expect(typeof board.unmeasured).toBe('string');
  });

  it('boards get: the response really has no cards array — the premise, asserted', async () => {
    const board = parse(await cli(await startServer(), ['get', BOARD, '--include', 'cards']));

    // If Favro ever starts honouring `include=cards`, this is the assertion that
    // fails first, and the counters above become computable rather than unknown.
    expect(board.cards).toBeUndefined();
    expect(board.cardCount).toBeUndefined();
  });

  it('boards list --json: the un-filtered list path reports unknown, not zero', async () => {
    const envelope = parse(await cli(await startServer(), [
      'list', '--include', 'stats,velocity',
    ]));

    expect(envelope.rows).toHaveLength(1);
    expect(envelope.rows[0].stats).toEqual({
      totalCards: null,
      doneCards: null,
      openCards: null,
      overdueCards: null,
    });
    expect(envelope.rows[0].velocity.every((w: any) => w.completed === null)).toBe(true);
    expect(typeof envelope.rows[0].unmeasured).toBe('string');
  });

  it('boards list <collection> --json: the collection-filtered path reports unknown too', async () => {
    const envelope = parse(await cli(await startServer(), [
      'list', COLLECTION, '--include', 'stats,velocity',
    ]));

    expect(envelope.rows).toHaveLength(1);
    expect(envelope.rows[0].stats).toEqual({
      totalCards: null,
      doneCards: null,
      openCards: null,
      overdueCards: null,
    });
    expect(envelope.rows[0].velocity.every((w: any) => w.completed === null)).toBe(true);
  });

  it('boards list --human: the table keeps the columns and states why they are unknown', async () => {
    const out = await cli(await startServer(), [
      'list', '--include', 'stats,velocity', '--human',
    ]);

    expect(out).toContain('Found 1 board(s):');
    expect(out).toMatch(/Note: .*unknown, not zero/);
  });

  it('no facet, no note: --include is not the same as asking for stats', async () => {
    const board = parse(await cli(await startServer(), ['get', BOARD, '--include', 'members']));

    expect(board.stats).toBeUndefined();
    expect(board.velocity).toBeUndefined();
    expect(board.unmeasured).toBeUndefined();
  });
});
