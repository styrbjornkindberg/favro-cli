/**
 * `favro columns list` — #43.
 *
 * `GET /columns` already carries `cardCount`, `timeSum` and `estimationSum` on
 * the same response the human path was throwing away, so a per-column count
 * costs no extra call. That is also why there is no `--count` flag: counting by
 * fetching every card would.
 */
import { Command } from 'commander';
import { registerColumnsCommands } from '../../commands/columns';
import ColumnsAPI, { Column } from '../../lib/columns-api';
import FavroHttpClient from '../../lib/http-client';
import * as config from '../../lib/config';
import * as safety from '../../lib/safety';

jest.mock('../../lib/columns-api');
jest.mock('../../lib/http-client');
jest.mock('../../lib/safety');

const columns: Column[] = [
  { columnId: 'col-1', name: 'Doing', position: 0, boardId: 'board-1', cardCount: 3, timeSum: 90, estimationSum: 5 },
  { columnId: 'col-2', name: 'Done', position: 1, boardId: 'board-1' },
];

describe('columns list', () => {
  let logSpy: jest.SpyInstance;
  let tableSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(config, 'resolveApiKey').mockResolvedValue('test-token');
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    tableSpy = jest.spyOn(console, 'table').mockImplementation(() => {});
    (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({} as any));
    (ColumnsAPI as jest.MockedClass<typeof ColumnsAPI>).mockImplementation(() => ({
      listColumns: jest.fn().mockResolvedValue(columns),
    } as any));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // `--human`, since #119 made JSON the default (ADR-0002) and these arms read
  // the `console.table` the human formatter draws.
  const run = async (...argv: string[]) => {
    const program = new Command();
    program.option('--human').option('--pretty');
    registerColumnsCommands(program);
    await program.parseAsync(['node', 'test', '--human', 'columns', 'list', ...argv]);
  };

  /** The machine path — the DEFAULT. */
  const runJson = async (...argv: string[]) => {
    const program = new Command();
    program.option('--human').option('--pretty');
    registerColumnsCommands(program);
    await program.parseAsync(['node', 'test', 'columns', 'list', ...argv]);
  };

  test('renders the counts that ride along on the same response', async () => {
    await run('board-1');

    expect(tableSpy).toHaveBeenCalledWith([
      { Position: 0, ID: 'col-1', Name: 'Doing', Cards: 3, Time: 90, Estimate: 5 },
      { Position: 1, ID: 'col-2', Name: 'Done', Cards: '—', Time: '—', Estimate: '—' },
    ]);
  });

  test('an absent count reads — and never 0, in the command stats points readers at', async () => {
    await run('board-1');

    // `boards get --include stats` cannot count cards and names this command as the
    // one that can. A `?? 0` here would answer "no cards" for a column whose count
    // simply did not arrive — the same fabrication, one command downstream.
    const [rows] = tableSpy.mock.calls[0] as [Array<Record<string, unknown>>];
    const absent = rows.find((r) => r.ID === 'col-2')!;
    expect([absent.Cards, absent.Time, absent.Estimate]).toEqual(['—', '—', '—']);
    expect(Object.values(absent)).not.toContain(0);
  });

  test('--json keeps the three fields untouched', async () => {
    await runJson('board-1');

    // An envelope, not a bare array — the shape every list read emits (#99).
    const printed = JSON.parse(logSpy.mock.calls.map((c) => c[0]).find((c: string) => c.startsWith('{')));
    expect(printed.truncated).toBeUndefined();
    expect(printed.rows[0]).toMatchObject({ cardCount: 3, timeSum: 90, estimationSum: 5 });
  });

  test('has no --count flag — counting by fetching every card is what it avoids', async () => {
    const program = new Command();
    registerColumnsCommands(program);
    const list = program.commands
      .find((c) => c.name() === 'columns')!
      .commands.find((c) => c.name() === 'list')!;

    expect(list.options.map((o) => o.long)).not.toContain('--count');
  });
});

describe('columns update — scope lock', () => {
  let updateColumn: jest.Mock;
  let getColumn: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(config, 'resolveApiKey').mockResolvedValue('test-token');
    jest.spyOn(config, 'readConfig').mockResolvedValue({} as any);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit must not be called under run()');
  }) as never);
    (safety.confirmAction as jest.Mock).mockResolvedValue(true);
    (safety.checkScope as jest.Mock).mockResolvedValue(undefined);
    (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({} as any));

    getColumn = jest.fn().mockResolvedValue(undefined);
    updateColumn = jest.fn().mockResolvedValue({ columnId: 'col-1' });
    (ColumnsAPI as jest.MockedClass<typeof ColumnsAPI>).mockImplementation(
      () => ({ getColumn, updateColumn } as any)
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const run = async (...argv: string[]) => {
    const program = new Command();
    program.option('--human').option('--pretty');
    registerColumnsCommands(program);
    await program.parseAsync(['node', 'test', '--human', 'columns', 'update', ...argv]);
  };

  test('still checks scope when the column metadata cannot be resolved', async () => {
    // A falsy getColumn used to skip the check entirely while updateColumn wrote
    // anyway — the fail-open shape #77 removed. The empty board id hands the
    // boardless case to the shared refusal instead.
    await run('col-1', '--name', 'Renamed');

    expect(safety.checkScope).toHaveBeenCalledWith('', expect.anything(), {}, undefined);
  });

  test('passes the resolved board through when it is known', async () => {
    getColumn.mockResolvedValue({ columnId: 'col-1', boardId: 'board-1' });

    await run('col-1', '--name', 'Renamed');

    expect(safety.checkScope).toHaveBeenCalledWith('board-1', expect.anything(), {}, undefined);
  });
});
