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
import { passThroughScopeResolution } from '../../test-support/scope-passthrough';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../lib/safety');
jest.mock('../../lib/widgets-api');
jest.mock('../../lib/boards-api');

const MockWidgets = WidgetsAPI as jest.MockedClass<typeof WidgetsAPI>;
const MockBoards = BoardsAPI as jest.MockedClass<typeof BoardsAPI>;

/** What the one board in this file is called, and what it settles to. */
const BOARD_NAME = 'Backlog - Web Hub';
const BOARD_ID = 'board-b';

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
let tableSpy: jest.SpyInstance;
let exitSpy: jest.SpyInstance;

async function runCli(args: string[]): Promise<void> {
  const program = new Command();
  program.option('--verbose', 'Show stack traces');
  registerWidgetsCommands(program);
  program.exitOverride();
  await program.parseAsync(['node', 'favro', ...args]).catch((e) => {
    if (!(e instanceof ExitCalled)) throw e;
  });
}

const output = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const errors = () => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');

beforeEach(() => {
  jest.clearAllMocks();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  tableSpy = jest.spyOn(console, 'table').mockImplementation(() => {});
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code ?? 0);
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

  MockWidgets.prototype.listWidgetsForCard = jest.fn().mockResolvedValue([
    { widgetCommonId: 'w-1', boardId: 'board-a', type: 'board', name: 'Platform' },
    { widgetCommonId: 'w-2', collectionIds: ['coll-1', 'coll-2'], type: 'backlog', name: 'Backlog' },
  ]);
  MockWidgets.prototype.addWidgetToBoard = jest.fn().mockResolvedValue({ widgetCommonId: 'w-3' });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('widgets list', () => {
  test('renders one row per board instance, falling back to collections when a widget has no board', async () => {
    await runCli(['widgets', 'list', '--card', 'ccid-1']);

    expect(MockWidgets.prototype.listWidgetsForCard).toHaveBeenCalledWith('ccid-1');
    expect(output()).toContain('Found 2 widget(s) for card ccid-1');
    expect(tableSpy).toHaveBeenCalledWith([
      { BoardID: 'board-a', WidgetID: 'w-1', Type: 'board', Name: 'Platform' },
      { BoardID: 'coll-1,coll-2', WidgetID: 'w-2', Type: 'backlog', Name: 'Backlog' },
    ]);
  });

  test('--json emits the widgets untouched and skips the table', async () => {
    await runCli(['widgets', 'list', '--card', 'ccid-1', '--json']);

    expect(tableSpy).not.toHaveBeenCalled();
    // An envelope, not a bare array — the shape every list read emits (#99).
    expect(JSON.parse(output()).rows).toHaveLength(2);
  });

  test('reports zero widgets rather than failing', async () => {
    MockWidgets.prototype.listWidgetsForCard = jest.fn().mockResolvedValue([]);

    await runCli(['widgets', 'list', '--card', 'ccid-1']);

    expect(output()).toContain('Found 0 widget(s)');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('a failed read exits 1', async () => {
    MockWidgets.prototype.listWidgetsForCard = jest.fn().mockRejectedValue(new Error('404 card not found'));

    await runCli(['widgets', 'list', '--card', 'ghost']);

    expect(errors()).toContain('404 card not found');
    expect(exitSpy).toHaveBeenCalledWith(1);
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
    expect(exitSpy).toHaveBeenCalledWith(1);
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
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('--json is unaffected — it prints the observed shape, holes included', async () => {
    MockWidgets.prototype.addWidgetToBoard = jest.fn().mockResolvedValue({
      widgetCommonId: undefined,
      cardId: 'card-1',
    });

    await runCli(['widgets', 'add', 'board-b', 'ccid-1', '-y', '--json']);

    // Parsed, not substring-matched: `not.toContain('board-b')` passes just as
    // happily against no output at all.
    const payload = JSON.parse(output());
    expect(payload).toMatchObject({ cardId: 'card-1' });
    expect(payload.widgetCommonId).toBeUndefined();
    // The format does not change what the command claims.
    expect(exitSpy).toHaveBeenCalledWith(1);
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
    expect(exitSpy).toHaveBeenCalledWith(1);
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
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('--force reaches the lock', async () => {
    await runCli(['widgets', 'add', 'board-b', 'ccid-1', '-y', '--force']);

    expect(safety.assertScope).toHaveBeenCalledWith('board-b', expect.anything(), expect.anything(), true);
  });

  test('--json emits the created widget', async () => {
    await runCli(['widgets', 'add', 'board-b', 'ccid-1', '-y', '--json']);

    expect(JSON.parse(output())).toEqual({ widgetCommonId: 'w-3' });
  });
});
