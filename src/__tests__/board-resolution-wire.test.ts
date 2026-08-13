/**
 * Wire-level tests for board resolution on the CARD path — issue #82.
 *
 * The defect: `resolveBoardId` had exactly two callers, both inside `BoardsAPI`
 * itself. Every card-shaped entry point forwarded its raw `--board` value
 * straight into `widgetCommonId`, so a board NAME went on the wire where only a
 * `widgetCommonId` is accepted. Favro does not refuse that — `GET /cards`
 * answers **200 with an empty page** for a widgetCommonId nobody has, and a
 * write lands nowhere. Zero rows, silently, which is the plausible wrong answer
 * #32/#46 exist to abolish.
 *
 * The compounding failure was worse than the empty answer: `--board <name>
 * --status Done` refused with *"No column named Done on board Backlog - Web
 * Hub"* — a structured refusal naming the wrong problem entirely, because
 * column resolution ran against a board that was never resolved. So the order
 * is load-bearing and asserted here: board first, column second.
 *
 * Same discipline as the sibling wire suites: no client mock. A real
 * `node:http` server stands in for Favro, so the assertions are about what
 * Favro actually RECEIVES — the query string and the request body — and a
 * client mock would only re-state our own outgoing shape.
 */
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import CardsAPI from '../lib/cards-api';
import WidgetsAPI from '../lib/widgets-api';
import { NameResolutionError } from '../lib/name-resolve';

const ORG = 'org-1';

/** The board this suite asks for by name. */
const HUB_ID = 'w-hub-0001';
const HUB_NAME = 'Backlog - Web Hub';
const DONE_ID = 'col-done';

/** A one-word name, id-shaped by every measure `looksLikeName` has. */
const SOLO_ID = 'w-solo-0002';
const SOLO_NAME = 'Backlog';

/** Two boards, one name — the ambiguity that must refuse rather than pick. */
const DUP_A = 'w-dup-000a';
const DUP_B = 'w-dup-000b';
const DUP_NAME = 'Dev';

const CARD_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const CARD_COMMON_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const SEQUENTIAL = 'CLA-1804';

interface Received {
  method: string;
  url: string;
  body: string;
}

/** Every server this file started, so a failed assertion cannot leak one. */
const running: http.Server[] = [];

function startServer(): Promise<{ client: FavroHttpClient; received: Received[] }> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const url = req.url ?? '';
      received.push({ method: req.method ?? '', url, body });

      let payload: unknown = { entities: [] };
      if (url.startsWith('/api/v1/widgets')) {
        payload = {
          entities: [
            {
              widgetCommonId: HUB_ID,
              name: HUB_NAME,
              columns: [{ columnId: DONE_ID, name: 'Done', position: 0 }],
            },
            { widgetCommonId: SOLO_ID, name: SOLO_NAME, columns: [] },
            { widgetCommonId: DUP_A, name: DUP_NAME, columns: [] },
            { widgetCommonId: DUP_B, name: DUP_NAME, columns: [] },
          ],
        };
      } else if (url.startsWith('/api/v1/cards/')) {
        // A single-card read or a PUT: echo a card that carries both keyspaces.
        // A PUT echoes the board it was SENT, the way the live API does on a
        // landed move (#161) — a fixed board here would make `moveCard`'s own
        // read-back throw on every row that resolves to some other board.
        const sent = (JSON.parse(body || '{}') as { widgetCommonId?: string }).widgetCommonId;
        payload = {
          cardId: CARD_ID,
          cardCommonId: CARD_COMMON_ID,
          name: 'A card',
          widgetCommonId: sent ?? HUB_ID,
        };
      } else if (url.startsWith('/api/v1/cards')) {
        payload = req.method === 'POST'
          ? { cardId: CARD_ID, cardCommonId: CARD_COMMON_ID, name: 'A card', widgetCommonId: HUB_ID }
          : {
              entities: [
                { cardId: CARD_ID, cardCommonId: CARD_COMMON_ID, name: 'A card', widgetCommonId: HUB_ID },
              ],
            };
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
      });
    });
  });
}

const cardCalls = (received: Received[]) => received.filter((r) => r.url.startsWith('/api/v1/cards'));

/** Everything Favro saw, query strings and bodies alike, as one searchable blob. */
const everythingSent = (received: Received[]) =>
  received.map((r) => `${decodeURIComponent(r.url)} ${r.body}`).join('\n');

const originalConfigDir = process.env.FAVRO_CONFIG_DIR;
let tmpDir: string;

beforeEach(async () => {
  // The name cache is a real file — give each test its own, so a run never
  // reads or clobbers the developer's own ~/.favro cache.
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-boardwire-test-'));
  process.env.FAVRO_CONFIG_DIR = tmpDir;
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise((done) => s.close(() => done(null)))));
  if (originalConfigDir === undefined) delete process.env.FAVRO_CONFIG_DIR;
  else process.env.FAVRO_CONFIG_DIR = originalConfigDir;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── the ratchet's table: every card-shaped entry point that takes a board ────

/**
 * THE REAL SURFACE, not one example.
 *
 * `cards list --board` was the reported symptom; it was never the only caller.
 * Each row drives one card-shaped entry point with a board NAME and asserts the
 * resolved `widgetCommonId` reached Favro — and, below, that the name itself
 * reached nothing. A row per entry point is the point: patching only the path
 * the ticket named would have left every sibling answering zero rows.
 *
 * The table takes a CLIENT, not a `CardsAPI`: "card-shaped" is about what goes
 * on the wire, not about which class spells it. `WidgetsAPI.addWidgetToBoard`
 * is a `PUT /cards/:cardId` carrying `widgetCommonId` and belongs here for
 * exactly that reason — it never touches `CardsAPI`, so a table keyed on the
 * class would have missed it, which is the tenth-entry-point version of the
 * bug this whole ticket is about.
 *
 * Adding a board-taking entry point without adding a row here is caught by
 * `the resolver is the only way a board reaches the wire`, further down.
 */
const ENTRY_POINTS: Array<{
  what: string;
  drive: (client: FavroHttpClient, board: string) => Promise<unknown>;
}> = [
  { what: 'listCards({ boardId })', drive: (c, board) => new CardsAPI(c).listCards({ boardId: board }) },
  { what: 'listCards(board) shorthand', drive: (c, board) => new CardsAPI(c).listCards(board) },
  { what: 'getCard(ref, { board })', drive: (c, board) => new CardsAPI(c).getCard(SEQUENTIAL, { board }) },
  {
    what: 'createCard({ boardId })',
    drive: (c, board) => new CardsAPI(c).createCard({ name: 'x', boardId: board }),
  },
  {
    what: 'createCard({ widgetCommonId })',
    drive: (c, board) => new CardsAPI(c).createCard({ name: 'x', widgetCommonId: board }),
  },
  {
    what: 'updateCard(ref, { boardId })',
    drive: (c, board) => new CardsAPI(c).updateCard(CARD_ID, { boardId: board }),
  },
  {
    what: 'moveCard(ref, { toBoardId })',
    drive: (c, board) => new CardsAPI(c).moveCard(CARD_ID, { toBoardId: board }),
  },
  {
    what: 'findCardBySequentialId(n, { widgetCommonId })',
    drive: (c, board) => new CardsAPI(c).findCardBySequentialId(1804, { widgetCommonId: board }),
  },
  {
    what: 'resolveCardId(ref, { widgetCommonId })',
    drive: (c, board) => new CardsAPI(c).resolveCardId(SEQUENTIAL, { widgetCommonId: board }),
  },
  {
    what: 'resolveCardCommonId(ref, { widgetCommonId })',
    drive: (c, board) => new CardsAPI(c).resolveCardCommonId(SEQUENTIAL, { widgetCommonId: board }),
  },
  {
    what: 'addWidgetToBoard(board, card) — the `favro widgets add` write',
    drive: (c, board) => new WidgetsAPI(c).addWidgetToBoard(board, CARD_COMMON_ID),
  },
];

describe('every card-shaped entry point resolves --board before the wire (#82)', () => {
  it.each(ENTRY_POINTS)('$what puts the resolved id on widgetCommonId', async ({ drive }) => {
    const { client, received } = await startServer();
    await drive(client, HUB_NAME);

    const sent = everythingSent(cardCalls(received));
    expect(cardCalls(received).length).toBeGreaterThan(0);
    expect(sent).toContain(HUB_ID);
    // The name itself must reach nothing — this is the whole bug.
    expect(sent).not.toContain(HUB_NAME);
  });

  it.each(ENTRY_POINTS)('$what resolves a one-word name too — shape never decides', async ({ drive }) => {
    const { client, received } = await startServer();
    await drive(client, SOLO_NAME);

    const sent = everythingSent(cardCalls(received));
    expect(sent).toContain(SOLO_ID);
  });

  it.each(ENTRY_POINTS)('$what refuses an unknown board and never calls /cards', async ({ drive }) => {
    const { client, received } = await startServer();
    const attempt = drive(client, 'No Such Board');

    await expect(attempt).rejects.toBeInstanceOf(NameResolutionError);
    // The #82 wording, reused from `resolveBoard` rather than invented twice.
    await expect(attempt).rejects.toThrow('missing or not visible to your key');
    expect(cardCalls(received)).toHaveLength(0);
  });

  it.each(ENTRY_POINTS)('$what refuses an ambiguous board, listing every candidate id', async ({ drive }) => {
    const { client, received } = await startServer();
    const attempt = drive(client, DUP_NAME);

    const error = (await attempt.catch((e: unknown) => e)) as NameResolutionError;
    expect(error).toBeInstanceOf(NameResolutionError);
    expect(error.kind).toBe('ambiguous');
    expect(error.message).toContain(DUP_A);
    expect(error.message).toContain(DUP_B);
    expect(error.candidates.map((c) => c.id).sort()).toEqual([DUP_A, DUP_B].sort());
    expect(cardCalls(received)).toHaveLength(0);
  });

  it.each(ENTRY_POINTS)('$what still passes a real id straight through', async ({ drive }) => {
    const { client, received } = await startServer();
    await drive(client, HUB_ID);

    expect(everythingSent(cardCalls(received))).toContain(HUB_ID);
  });
});

describe('board before column, in that order (#82)', () => {
  it('--board <name> --status <name> resolves the board first, then the column on it', async () => {
    const { client, received } = await startServer();
    await new CardsAPI(client).listCards({ boardId: HUB_NAME, status: 'Done' });

    const [call] = cardCalls(received);
    expect(call.url).toContain(`widgetCommonId=${HUB_ID}`);
    expect(call.url).toContain(`columnId=${DONE_ID}`);
  });

  it('an unresolvable board refuses as a BOARD, not as a missing column', async () => {
    const { client } = await startServer();
    const attempt = new CardsAPI(client).listCards({ boardId: 'No Such Board', status: 'Done' });

    // The old refusal was "No column named Done on board No Such Board" — a
    // structured refusal naming the wrong problem entirely.
    await expect(attempt).rejects.toBeInstanceOf(NameResolutionError);
    await expect(attempt).rejects.toThrow('No board named "No Such Board"');
  });
});

describe('a board-less read is untouched (#82)', () => {
  it('listCards() with no board sends no widgetCommonId and resolves nothing', async () => {
    const { client, received } = await startServer();
    await new CardsAPI(client).listCards();

    expect(cardCalls(received)[0].url).not.toContain('widgetCommonId');
    expect(received.filter((r) => r.url.startsWith('/api/v1/widgets'))).toHaveLength(0);
  });
});

// ─── the ratchet ─────────────────────────────────────────────────────────────

/**
 * The resolver is the only way a board value reaches `widgetCommonId` (#82).
 *
 * Nothing above goes red if an eleventh entry point is added that forwards its
 * board raw — and that is exactly how eight of the ten above survived years of
 * green suites, each one covered by a mock that answered whatever board it was
 * asked about.
 *
 * Two scans, because one is not enough. The NAME check is the cheap one:
 * inside `cards-api.ts` the only name a resolved board is ever bound to is
 * `boardId`, so every `widgetCommonId` write must spell exactly that. On its
 * own it matches provenance-free — `const boardId = opts.boardId;` launders a
 * raw forward straight through it, which is precisely the eleventh-entry-point
 * case this ratchet exists for. So the PROVENANCE check does the real work:
 * whatever function writes `widgetCommonId` must itself have called
 * `boardIdOf`. That one is not fooled by a rebinding, and it does not care
 * what the local is called or which file it lives in.
 *
 * The asymmetry is deliberate, not an oversight: the name check reads
 * `cards-api.ts` only, because in `widgets-api.ts` the RETURNED `Widget`
 * legitimately spells `widgetCommonId:` with Favro's own echo, and that is not
 * a wire write. A regex cannot tell a request body from a response shape, so
 * that file is held by the provenance check alone.
 *
 * If you are here because this failed: the value you put on `widgetCommonId`
 * did not come from `boardIdOf(…)`. Route it through, bind it to `boardId`,
 * and add a row to `ENTRY_POINTS`.
 */
const GUARDED = ['cards-api.ts', 'widgets-api.ts'].map((f) => path.resolve(__dirname, '..', 'lib', f));
const CARDS_API = GUARDED[0];

/**
 * `widgetCommonId: <value>` / `…widgetCommonId = <value>` — a WRITE. Bracket
 * notation (`params['widgetCommonId'] = …`) is the same write in a spelling
 * that used to slip past.
 *
 * Not matched, and not wanted: the `widgetCommonId?: string` field
 * declarations, the `{ …, widgetCommonId, … }` destructures, and a local
 * `const widgetCommonId = …` (which `parseCardUrl` builds out of a URL path and
 * hands back to its caller, rather than to Favro).
 */
const WIRE_WRITE = /(const |let |var )?['"]?widgetCommonId['"]?\s*\]?\s*[:=]\s*([^,;\n}]+)/g;

/** A field declaration (`widgetCommonId: string`), never a wire write. */
const NOT_A_WRITE = /^(string|\?)/;

/**
 * Where a function body starts: a class member at its two-space indent, or a
 * top-level `function`. Crude on purpose — the ratchet only needs to know which
 * body a write sits in, and its own self-check below proves the split found the
 * bodies rather than treating each file as one blob.
 */
const FUNCTION_START =
  /^(?: {2}(?:private |public |protected )?(?:static )?(?:async )?(?:get |set )?[A-Za-z_$][\w$]*\s*[(<]|(?:export )?(?:async )?function [A-Za-z_$][\w$]*)/gm;

function wireWrites(source: string): RegExpExecArray[] {
  return [...source.matchAll(WIRE_WRITE)]
    .filter((m) => m[1] === undefined)
    .filter((m) => !NOT_A_WRITE.test(m[2].trim())) as RegExpExecArray[];
}

function boardValuesWrittenToTheWire(source: string): string[] {
  return wireWrites(source).map((m) => m[2].trim());
}

/** The source of the function body a given offset sits inside. */
function enclosingBody(source: string, offset: number): string {
  const starts = [...source.matchAll(FUNCTION_START)].map((m) => m.index as number);
  const from = starts.filter((i) => i <= offset).pop() ?? 0;
  const to = starts.find((i) => i > offset) ?? source.length;
  return source.slice(from, to);
}

/** Every `widgetCommonId` write whose own function never called `boardIdOf`. */
function unresolvedWrites(source: string): string[] {
  return wireWrites(source)
    .filter((m) => !/boardIdOf\s*\(/.test(enclosingBody(source, m.index as number)))
    .map((m) => `${m[0].trim()}  (line ${source.slice(0, m.index).split('\n').length})`);
}

describe('the resolver is the only way a board reaches the wire (#82)', () => {
  it('every widgetCommonId written in cards-api.ts takes the resolved boardId', () => {
    const source = fsSync.readFileSync(CARDS_API, 'utf-8');
    const offenders = boardValuesWrittenToTheWire(source).filter((value) => value !== 'boardId');

    expect(offenders).toEqual([]);
  });

  it.each(GUARDED.map((f) => [path.basename(f), f]))(
    '%s writes widgetCommonId only from a function that called boardIdOf',
    (_name, file) => {
      expect(unresolvedWrites(fsSync.readFileSync(file, 'utf-8'))).toEqual([]);
    },
  );

  it('the ratchet is actually looking at the files', () => {
    // A scan that silently matched nothing would pass the tests above forever.
    for (const file of GUARDED) {
      const source = fsSync.readFileSync(file, 'utf-8');
      expect(boardValuesWrittenToTheWire(source).length).toBeGreaterThanOrEqual(1);
      // …and a split that found no bodies would make every write "enclosed" by
      // the whole file, where SOME other function's boardIdOf always matches.
      expect([...source.matchAll(FUNCTION_START)].length).toBeGreaterThanOrEqual(3);
    }
    expect(boardValuesWrittenToTheWire(fsSync.readFileSync(CARDS_API, 'utf-8')).length)
      .toBeGreaterThanOrEqual(5);

    // Positive probes: each scan flags the shape it exists to flag.
    expect(boardValuesWrittenToTheWire('params.widgetCommonId = opts.boardId;')).toEqual(['opts.boardId']);
    expect(boardValuesWrittenToTheWire("params['widgetCommonId'] = opts.boardId;")).toEqual(['opts.boardId']);
    expect(
      unresolvedWrites('  async listCards(opts) {\n    const boardId = opts.boardId;\n    params.widgetCommonId = boardId;\n  }\n'),
    ).toHaveLength(1);
  });
});
