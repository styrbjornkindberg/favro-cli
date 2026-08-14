/**
 * `favro widgets list|add` — behaviour (#100).
 *
 * `widgets add` puts a card on a named board, so it is a write that LANDS on a
 * board and the lock applies directly. The board ARGUMENT is a name or an id
 * (#82) — it settles before the lock sees it, because the lock checks a
 * `widgetCommonId` and `GET /widgets/<name>` 404s into "Board … not found", a
 * refusal naming the wrong problem. `widgets list` is the read that answers
 * "which board instances does this card have", which is the `cardId` vs
 * `cardCommonId` distinction made visible.
 */
import { Command } from 'commander';
import { registerWidgetsCommands } from '../../commands/widgets';
import * as config from '../../lib/config';
import * as safety from '../../lib/safety';
import WidgetsAPI from '../../lib/widgets-api';
import BoardsAPI from '../../lib/boards-api';
import FavroHttpClient from '../../lib/http-client';
import { passThroughScopeResolution } from '../../test-support/scope-passthrough';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../lib/safety');
jest.mock('../../lib/widgets-api');
jest.mock('../../lib/boards-api');

const MockWidgets = WidgetsAPI as jest.MockedClass<typeof WidgetsAPI>;
const MockBoards = BoardsAPI as jest.MockedClass<typeof BoardsAPI>;
const MockClient = FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>;

/**
 * The two card references this file drives, and what `GET /cards/<ref>` answers
 * for each — the read `add-board-instance` now makes to settle the card to a
 * `cardCommonId` (#162 item 8).
 *
 * `ccid-1` answering `403 Access denied` is the wire's own shape, not a
 * convenience: that is what Favro returns for a `cardCommonId` on this path, and
 * `classifyFavroError` reads it as a classified not-found, which is what tells
 * the resolver the reference was already a `cardCommonId`. Serving a 200 here
 * would model an endpoint Favro does not have.
 */
const CARD_GET: Record<string, { cardId: string; cardCommonId: string }> = {
  'card-1': { cardId: 'card-1', cardCommonId: 'ccid-1' },
};

const accessDenied = () =>
  Object.assign(new Error('Request failed with status code 403'), {
    isAxiosError: true,
    response: { status: 403, data: { message: 'Access denied' } },
  });

/** What the one board in this file is called, and what it settles to. */
const BOARD_NAME = 'Backlog - Web Hub';
const BOARD_ID = 'board-b';

/** Every `GET /cards?…` the run issued, by params — see the client stub. */
let cardsQueries: Array<Record<string, unknown>>;

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
let tableSpy: jest.SpyInstance;

/**
 * The human path. `--human` is explicit since #119 moved this file onto
 * `run()`: JSON is the default, so a bare run hands every arm an envelope.
 */
async function runCli(args: string[]): Promise<void> {
  await drive(['--human', ...args]);
}

/** The machine path — the DEFAULT for a real invocation (ADR-0002). */
async function runJson(args: string[]): Promise<void> {
  await drive(args);
}

async function drive(args: string[]): Promise<void> {
  const program = new Command();
  program.option('--human').option('--pretty').option('--verbose', 'Show stack traces');
  registerWidgetsCommands(program);
  program.exitOverride();
  await program.parseAsync(['node', 'favro', ...args]);
}

const output = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const errors = () => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');

beforeEach(() => {
  jest.clearAllMocks();
  cardsQueries = [];
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  tableSpy = jest.spyOn(console, 'table').mockImplementation(() => {});
  process.exitCode = undefined;
  jest.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit must not be called under run()');
  }) as never);

  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  (config.readConfig as jest.Mock).mockResolvedValue({ scopeCollectionId: 'coll-1' });
  (safety.checkScope as jest.Mock).mockResolvedValue(undefined);
  // `widgets add` is routed through the `add-board-instance` intent (#109), so
  // the lock it takes is the table's `assertScope`. Reset per arm because
  // `clearAllMocks` clears calls, not implementations.
  (safety.assertScope as jest.Mock).mockResolvedValue(undefined);
  (safety.confirmAction as jest.Mock).mockResolvedValue(true);
  // `checkResolvedScope` IS the behaviour under test here — auto-mocked it
  // resolves nothing and every assertion below would pass against a stub.
  passThroughScopeResolution(safety, config, { prototype: { getCard: async () => undefined } });
  MockBoards.prototype.resolveBoardId = jest.fn(async (board: string) =>
    board === BOARD_NAME ? BOARD_ID : board,
  );
  (safety.dryRunLog as jest.Mock).mockImplementation((verb: string, noun: string, detail: string) =>
    console.log(`[dry-run] ${verb} ${noun}: ${detail}`),
  );

  MockClient.prototype.get = jest.fn(async (url: string, config?: { params?: Record<string, unknown> }) => {
    // The filter form, which is how a sequentialId reference resolves. It
    // records the params so the `--board` arm can assert what was sent.
    if (url === '/cards') {
      cardsQueries.push(config?.params ?? {});
      return { entities: [{ cardId: 'card-1', cardCommonId: 'ccid-1', widgetCommonId: BOARD_ID }] };
    }
    const ref = /\/cards\/(.+)$/.exec(url)?.[1];
    const card = ref ? CARD_GET[ref] : undefined;
    if (!card) throw accessDenied();
    return card;
  }) as unknown as typeof MockClient.prototype.get;

  MockWidgets.prototype.listInstancesOfCard = jest.fn().mockResolvedValue([
    { cardId: 'card-1', cardCommonId: 'ccid-1', boardId: 'board-a', columnId: 'col-a', name: 'Platform' },
    // A fork: an assignment entity with no board instance.
    { cardId: 'card-2', cardCommonId: 'ccid-1', name: 'Platform' },
  ]);
  MockWidgets.prototype.addWidgetToBoard = jest.fn().mockResolvedValue({ widgetCommonId: 'w-3' });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('widgets list', () => {
  test('renders one row per board instance, and says so when an instance has no board', async () => {
    await runCli(['widgets', 'list', '--card', 'ccid-1']);

    expect(MockWidgets.prototype.listInstancesOfCard).toHaveBeenCalledWith('ccid-1');
    expect(output()).toContain('Found 2 board instance(s) of card ccid-1');
    expect(tableSpy).toHaveBeenCalledWith([
      { BoardID: 'board-a', CardID: 'card-1', Column: 'col-a', Name: 'Platform' },
      { BoardID: '—', CardID: 'card-2', Column: '—', Name: 'Platform' },
    ]);
  });

  test('a cardId is settled to its cardCommonId before the read, not passed through', async () => {
    // The two keyspaces share a syntax, and this read takes only `cardCommonId`
    // — `GET /cards?cardCommonId=<a cardId>` was measured answering 403.
    await runCli(['widgets', 'list', '--card', 'card-1']);

    expect(MockWidgets.prototype.listInstancesOfCard).toHaveBeenCalledWith('ccid-1');
  });

  test('--board rides along to the resolver, which is where a colliding sequentialId is refused', async () => {
    // The flag exists because `pickOneInstance` refuses a collision with "pass
    // --board <board> to say which" — a remedy this command could not run
    // before. A sequentialId is the one reference shape that reads the board.
    await runCli(['widgets', 'list', '--card', 'CLA-1804', '--board', BOARD_NAME]);

    expect(cardsQueries).toContainEqual(
      expect.objectContaining({ cardSequentialId: 1804, widgetCommonId: BOARD_ID }),
    );
    expect(MockWidgets.prototype.listInstancesOfCard).toHaveBeenCalledWith('ccid-1');
  });

  test('the machine DEFAULT emits the widgets untouched and skips the table', async () => {
    // `--json` left the leaf with #119's migration: JSON is the default and
    // `--human` is the way out (ADR-0002).
    await runJson(['widgets', 'list', '--card', 'ccid-1']);

    expect(tableSpy).not.toHaveBeenCalled();
    // An envelope, not a bare array — the shape every list read emits (#99).
    expect(JSON.parse(output()).rows).toHaveLength(2);
  });

  test('reports zero instances rather than failing', async () => {
    MockWidgets.prototype.listInstancesOfCard = jest.fn().mockResolvedValue([]);

    await runCli(['widgets', 'list', '--card', 'ccid-1']);

    expect(output()).toContain('Found 0 board instance(s)');
    expect(process.exitCode).toBeUndefined();
  });

  test('a failed read exits 1', async () => {
    MockWidgets.prototype.listInstancesOfCard = jest.fn().mockRejectedValue(new Error('404 card not found'));

    await runCli(['widgets', 'list', '--card', 'ghost']);

    expect(errors()).toContain('404 card not found');
    expect(process.exitCode).toBe(1);
  });
});

describe('widgets add', () => {
  test('checks the target board, then adds the card, and reports the new widget', async () => {
    await runCli(['widgets', 'add', 'board-b', 'ccid-1', '-y']);

    expect(safety.assertScope).toHaveBeenCalledWith('board-b', expect.anything(), { scopeCollectionId: 'coll-1' }, undefined);
    expect(MockWidgets.prototype.addWidgetToBoard).toHaveBeenCalledWith('board-b', 'ccid-1', undefined);
    expect(output()).toContain('✓ Widget added to board (w-3)');
  });

  /**
   * The ✓ is spent on an OBSERVED board id and nothing else.
   *
   * `addWidgetToBoard` used to answer `updated.widgetCommonId ?? boardId`, so a
   * response that said nothing still produced `✓ Widget added to board
   * (board-b)` — the board the user typed, printed back as though Favro had
   * confirmed it. That is #82's original bug verbatim: the success line for a
   * write that never landed.
   */
  test('an unobserved board id prints no ✓ and does not name it as reached', async () => {
    MockWidgets.prototype.addWidgetToBoard = jest.fn().mockResolvedValue({ widgetCommonId: undefined });

    await runCli(['widgets', 'add', 'board-b', 'ccid-1', '-y']);

    expect(output()).not.toContain('✓');
    expect(output()).toContain('UNCONFIRMED');
    expect(output()).toContain('carried no widgetCommonId');
    // And exit 1: a hole forbids a clean exit code (#148). Not a throw — the
    // report still lands on stdout, which is what keeps a finding
    // distinguishable from a failure (#117). Throwing on an unmeasured echo
    // would be the regression #101's triage declined; a non-zero code next to a
    // printed report is not.
    expect(process.exitCode).toBe(1);
  });

  /**
   * A `null` or empty-string echo is not the same value as an absent one, and
   * neither is an observation. Nothing may launder either into a ✓.
   */
  test.each([[null], ['']])('a %p board id echo is not an observation', async (echoed) => {
    MockWidgets.prototype.addWidgetToBoard = jest.fn().mockResolvedValue({ widgetCommonId: echoed });

    await runCli(['widgets', 'add', 'board-b', 'ccid-1', '-y']);

    expect(output()).not.toContain('✓');
    expect(output()).toContain('UNCONFIRMED');
    expect(process.exitCode).toBe(1);
  });

  test('the machine default is unaffected — it prints the observed shape, holes included', async () => {
    MockWidgets.prototype.addWidgetToBoard = jest.fn().mockResolvedValue({
      widgetCommonId: undefined,
      cardId: 'card-1',
    });

    await runJson(['widgets', 'add', 'board-b', 'ccid-1', '-y']);

    // Parsed, not substring-matched: `not.toContain('board-b')` passes just as
    // happily against no output at all.
    const payload = JSON.parse(output());
    expect(payload).toMatchObject({ cardId: 'card-1' });
    expect(payload.widgetCommonId).toBeUndefined();
    // The format does not change what the command claims.
    expect(process.exitCode).toBe(1);
  });

  /**
   * The identifier half of #162 item 8.
   *
   * `addWidgetToBoard`'s first step is `GET /cards?cardCommonId=<x>`, which Favro
   * answers `403 Access denied` for a `cardId` — and a `cardId` is what `cards
   * list --json` prints as a card's own identity, so it is the reference a caller
   * pastes back. The intent settles the reference first, so the commit is handed
   * the id the endpoint actually takes.
   *
   * Both polarities, because the pass-through arm above already drives a
   * `cardCommonId`: `card-1` must NOT reach the write, and `ccid-1` must.
   */
  test('a cardId is settled to its cardCommonId before the commit', async () => {
    await runCli(['widgets', 'add', 'board-b', 'card-1', '-y']);

    expect(MockWidgets.prototype.addWidgetToBoard).toHaveBeenCalledWith('board-b', 'ccid-1', undefined);
    expect(MockWidgets.prototype.addWidgetToBoard).not.toHaveBeenCalledWith(
      'board-b',
      'card-1',
      undefined,
    );
    expect(output()).toContain('✓ Widget added to board (w-3)');
  });

  /**
   * The message half of #162 item 8, at the command that reported it.
   *
   * The table used to put `error.message` into the result raw, so a 403 arrived
   * as axios' `Request failed with status code 403` — a sentence about a socket
   * — while every read command said `Favro said "Access denied" …` for the same
   * response. Agents are told to reason about a 403; the reasoning was not
   * available on this path.
   *
   * Asserted on the MACHINE shape, which is the one an agent parses, and with
   * the raw sentence asserted absent: a message that merely CONTAINS the
   * classification while still leaking the axios line is the same defect.
   */
  test('a wire refusal reports Favro’s own message, not axios’ status line', async () => {
    MockWidgets.prototype.addWidgetToBoard = jest.fn().mockRejectedValue(accessDenied());

    await runJson(['widgets', 'add', 'board-b', 'ccid-1', '-y']);

    const reported = JSON.parse(output());
    expect(reported.error).toContain('Favro said "Access denied"');
    expect(reported.error).not.toContain('Request failed with status code');
    expect(process.exitCode).toBe(1);
  });

  test('a failure with no wire response keeps its own wording', async () => {
    // The foreign arm: only a classified response is reworded. Without this the
    // rewrite could swallow every message and nothing would notice.
    MockWidgets.prototype.addWidgetToBoard = jest
      .fn()
      .mockRejectedValue(new Error('socket hang up'));

    await runJson(['widgets', 'add', 'board-b', 'ccid-1', '-y']);

    expect(JSON.parse(output()).error).toBe('socket hang up');
    expect(process.exitCode).toBe(1);
  });

  test('--column places the new instance in a named column', async () => {
    await runCli(['widgets', 'add', 'board-b', 'ccid-1', '-y', '--column', 'col-9']);

    expect(MockWidgets.prototype.addWidgetToBoard).toHaveBeenCalledWith('board-b', 'ccid-1', 'col-9');
  });

  test('a board outside the lock adds nothing', async () => {
    (safety.assertScope as jest.Mock).mockRejectedValue(new Error('Scope violation: board-b'));

    await runCli(['widgets', 'add', 'board-b', 'ccid-1', '-y']);

    expect(MockWidgets.prototype.addWidgetToBoard).not.toHaveBeenCalled();
    expect(errors()).toContain('Scope violation');
    expect(process.exitCode).toBe(1);
  });

  test('a board NAME settles to an id before the lock sees it (#82)', async () => {
    await runCli(['widgets', 'add', BOARD_NAME, 'ccid-1', '-y']);

    // The lock GETs `/widgets/<id>`; handed the name it 404s and reports
    // "Board Backlog - Web Hub not found" — #82's complaint at a new seam.
    expect(safety.assertScope).toHaveBeenCalledWith(BOARD_ID, expect.anything(), expect.anything(), undefined);
    expect(MockWidgets.prototype.addWidgetToBoard).toHaveBeenCalledWith(BOARD_NAME, 'ccid-1', undefined);
  });

  test('the board settles before the lock whether or not one is configured', async () => {
    // It used to be gated: `checkResolvedScope` skipped the resolve when nothing
    // was locked. The settling moved INSIDE the intent with #109 (`board()` runs
    // ahead of `assertScope`), which makes the #82 spelling structural rather than
    // a property of one call site.
    //
    // It costs NO extra request, which is the opposite of what this comment first
    // claimed. `addWidgetToBoard` settles the same value again through
    // `boardIdOf`, and `resolveNameToId` reads a memoised disk cache
    // (`name-cache.ts`), so the second settling is a hit — measured on a real
    // socket in `cards-link.test.ts`'s #82 arm, which counts one `/widgets` list
    // across both.
    (config.readConfig as jest.Mock).mockResolvedValue({});

    await runCli(['widgets', 'add', BOARD_NAME, 'ccid-1', '-y']);

    expect(MockBoards.prototype.resolveBoardId).toHaveBeenCalledWith(BOARD_NAME);
    expect(MockWidgets.prototype.addWidgetToBoard).toHaveBeenCalledWith(BOARD_NAME, 'ccid-1', undefined);
  });

  test('the lock runs before the preview, so --dry-run is not a way around it', async () => {
    // Structural now: the table takes the lock before it returns a preview, so
    // this ordering cannot be got wrong at this call site at all.
    await runCli(['widgets', 'add', 'board-b', 'ccid-1', '--dry-run']);

    expect(MockWidgets.prototype.addWidgetToBoard).not.toHaveBeenCalled();
    expect(safety.assertScope).toHaveBeenCalledWith('board-b', expect.anything(), expect.anything(), undefined);
    expect(output()).toContain('[dry-run] add card ccid-1 to board board-b');
    expect(output()).toContain('IRREVERSIBLE');
  });

  test('--dry-run does not ask — previewing is not writing', async () => {
    await runCli(['widgets', 'add', 'board-b', 'ccid-1', '--dry-run']);

    expect(safety.confirmAction).not.toHaveBeenCalled();
  });

  test('declining the confirm adds nothing and exits 0', async () => {
    (safety.confirmAction as jest.Mock).mockResolvedValue(false);

    await runCli(['widgets', 'add', 'board-b', 'ccid-1']);

    expect(MockWidgets.prototype.addWidgetToBoard).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  test('--force reaches the lock', async () => {
    await runCli(['widgets', 'add', 'board-b', 'ccid-1', '-y', '--force']);

    expect(safety.assertScope).toHaveBeenCalledWith('board-b', expect.anything(), expect.anything(), true);
  });

  test('the machine default emits the created widget, and NOTHING ahead of it', async () => {
    // The second live-smoke finding: the card-write family put its `✓ …` line on
    // stdout in front of the JSON, so the documented default did not parse. The
    // ✓ is on the `human` formatter now, which the runner calls only under
    // `--human`.
    await runJson(['widgets', 'add', 'board-b', 'ccid-1', '-y']);

    expect(JSON.parse(output())).toEqual({ widgetCommonId: 'w-3' });
    expect(output()).not.toContain('✓');
  });
});
