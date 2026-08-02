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

    expect(safety.checkScope).toHaveBeenCalledWith('board-b', expect.anything(), { scopeCollectionId: 'coll-1' }, undefined);
    expect(MockWidgets.prototype.addWidgetToBoard).toHaveBeenCalledWith('board-b', 'ccid-1', undefined);
    expect(output()).toContain('✓ Widget added to board (w-3)');
  });

  test('--column places the new instance in a named column', async () => {
    await runCli(['widgets', 'add', 'board-b', 'ccid-1', '-y', '--column', 'col-9']);

    expect(MockWidgets.prototype.addWidgetToBoard).toHaveBeenCalledWith('board-b', 'ccid-1', 'col-9');
  });

  test('a board outside the lock adds nothing', async () => {
    (safety.checkScope as jest.Mock).mockRejectedValue(new Error('Scope violation: board-b'));

    await runCli(['widgets', 'add', 'board-b', 'ccid-1', '-y']);

    expect(MockWidgets.prototype.addWidgetToBoard).not.toHaveBeenCalled();
    expect(errors()).toContain('Scope violation');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('a board NAME settles to an id before the lock sees it (#82)', async () => {
    await runCli(['widgets', 'add', BOARD_NAME, 'ccid-1', '-y']);

    // The lock GETs `/widgets/<id>`; handed the name it 404s and reports
    // "Board Backlog - Web Hub not found" — #82's complaint at a new seam.
    expect(safety.checkScope).toHaveBeenCalledWith(BOARD_ID, expect.anything(), expect.anything(), undefined);
    expect(MockWidgets.prototype.addWidgetToBoard).toHaveBeenCalledWith(BOARD_NAME, 'ccid-1', undefined);
  });

  test('no lock configured means the board is never resolved for the lock', async () => {
    (config.readConfig as jest.Mock).mockResolvedValue({});

    await runCli(['widgets', 'add', BOARD_NAME, 'ccid-1', '-y']);

    expect(safety.checkScope).not.toHaveBeenCalled();
    expect(MockBoards.prototype.resolveBoardId).not.toHaveBeenCalled();
  });

  test('the lock runs before the preview, so --dry-run is not a way around it', async () => {
    await runCli(['widgets', 'add', 'board-b', 'ccid-1', '--dry-run']);

    expect(MockWidgets.prototype.addWidgetToBoard).not.toHaveBeenCalled();
    const check = (safety.checkScope as jest.Mock).mock.invocationCallOrder[0];
    const preview = (safety.dryRunLog as jest.Mock).mock.invocationCallOrder[0];
    expect(check).toBeLessThan(preview);
    expect(exitSpy).toHaveBeenCalledWith(0);
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

    expect(safety.checkScope).toHaveBeenCalledWith('board-b', expect.anything(), expect.anything(), true);
  });

  test('--json emits the created widget', async () => {
    await runCli(['widgets', 'add', 'board-b', 'ccid-1', '-y', '--json']);

    expect(JSON.parse(output())).toEqual({ widgetCommonId: 'w-3' });
  });
});
