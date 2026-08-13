/**
 * Integration tests for cli.ts (the actual shipped binary entry point)
 * CLA-1774: Unit Tests — All Commands — cli.ts coverage
 *
 * Tests the ACTUAL cli.ts via the exported buildProgram() function.
 * This gives real coverage of the shipped binary, not a reimplementation.
 *
 * Approach: Import buildProgram() from '../cli', build a fresh Command
 * tree for each test, verify the expected command hierarchy, options,
 * and that commands fail fast (exit 1) when FAVRO_API_TOKEN is missing.
 */
import { buildProgram } from '../cli';
import CardsAPI from '../lib/cards-api';
import { resolveApiKey } from '../lib/config';

jest.mock('../lib/cards-api');
jest.mock('../lib/http-client');
// `cards list` settles its board BEFORE the filter validator sees it (#82), so
// the reference these tests pass is a real resolver call. Here it only has to
// hand the reference back — what the resolver itself does is pinned on the wire
// in `board-resolution-wire.test.ts`, and these assertions are about
// `listCards`.
// BOTH exports. `cards list` reaches the resolver through `ctx.api.boards`
// since #119, and `run.ts` imports the NAMED `BoardsAPI` — a mock supplying only
// `default` answered `BoardsAPI is not a constructor`, which the runner's
// boundary then swallowed into an error envelope and an empty `listCards`.
jest.mock('../lib/boards-api', () => {
  const stub = jest.fn().mockImplementation(() => ({
    resolveBoardId: async (board: string) =>
      board === 'Backlog - Web Hub' ? 'w-hub-0001' : board,
  }));
  return { __esModule: true, default: stub, BoardsAPI: stub };
});
jest.mock('../lib/config', () => ({
  resolveApiKey: jest.fn().mockResolvedValue(undefined),
  loadConfig: jest.fn().mockResolvedValue({}),
  readConfig: jest.fn().mockResolvedValue({}),
}));

describe('cli.ts — command structure (parent/child hierarchy)', () => {
  test('program has "cards" parent command', () => {
    const program = buildProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards');
    expect(cardsCmd).toBeDefined();
  });

  test('"cards" command has "list" subcommand', () => {
    const program = buildProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const listCmd = cardsCmd.commands.find(c => c.name() === 'list');
    expect(listCmd).toBeDefined();
  });

  test('"cards" command has "create" subcommand', () => {
    const program = buildProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const createCmd = cardsCmd.commands.find(c => c.name() === 'create');
    expect(createCmd).toBeDefined();
  });

  test('"cards" command has "update" subcommand', () => {
    const program = buildProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const updateCmd = cardsCmd.commands.find(c => c.name() === 'update');
    expect(updateCmd).toBeDefined();
  });

  test('"cards" command has "export" subcommand', () => {
    const program = buildProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const exportCmd = cardsCmd.commands.find(c => c.name() === 'export');
    expect(exportCmd).toBeDefined();
  });

  test('all subcommands are registered under "cards" (no conflicts)', () => {
    const program = buildProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const subNames = cardsCmd.commands.map(c => c.name());
    expect(subNames).toContain('list');
    expect(subNames).toContain('create');
    expect(subNames).toContain('update');
    expect(subNames).toContain('export');
    // CLA-1785: advanced cards endpoints add get, link, unlink, move
    expect(subNames).toContain('get');
    expect(subNames).toContain('link');
    expect(subNames).toContain('unlink');
    expect(subNames).toContain('move');
  });

  test('program name is "favro"', () => {
    const program = buildProgram();
    expect(program.name()).toBe('favro');
  });

  test('program version is set', () => {
    const program = buildProgram();
    expect(program.version()).toMatch(/\d+\.\d+\.\d+/);
  });
});

describe('cli.ts — cards list options', () => {
  test('cards list has --board option', () => {
    const program = buildProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const listCmd = cardsCmd.commands.find(c => c.name() === 'list')!;
    const optNames = listCmd.options.map(o => o.long);
    expect(optNames).toContain('--board');
  });

  test('cards list has --status option', () => {
    const program = buildProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const listCmd = cardsCmd.commands.find(c => c.name() === 'list')!;
    const optNames = listCmd.options.map(o => o.long);
    expect(optNames).toContain('--status');
  });

  test('cards list has --limit option', () => {
    const program = buildProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const listCmd = cardsCmd.commands.find(c => c.name() === 'list')!;
    const optNames = listCmd.options.map(o => o.long);
    expect(optNames).toContain('--limit');
  });

  test('cards list declares no --json — JSON is the default (#119)', () => {
    // ADR-0002: JSON is the default and `--human` is the only way out, so a leaf
    // `--json` would be a second spelling of a flag the root already owns.
    const program = buildProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const listCmd = cardsCmd.commands.find(c => c.name() === 'list')!;
    const optNames = listCmd.options.map(o => o.long);
    expect(optNames).not.toContain('--json');
    expect(program.options.map((o) => o.long)).toContain('--human');
  });

  // #44 reinstated --include on `cards list`, on the opposite grounds to CLA-1785:
  // it was removed as a flag that did nothing, and now it does exactly one thing
  // — restore the `customFields` the denylist omits — using `cards get`'s own
  // vocabulary rather than a new `--full`.
  test('cards list has --include and --body, the two flags that restore omitted fields', () => {
    const program = buildProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const listCmd = cardsCmd.commands.find(c => c.name() === 'list')!;
    const optNames = listCmd.options.map(o => o.long);
    expect(optNames).toContain('--include');
    expect(optNames).toContain('--body');
    expect(optNames).not.toContain('--full');
  });

  test('cards list has --archived', () => {
    const program = buildProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const listCmd = cardsCmd.commands.find(c => c.name() === 'list')!;
    expect(listCmd.options.map(o => o.long)).toContain('--archived');
  });
});

describe('cli.ts — CLA-1785 critic fixes: limit cap and null guard', () => {
  let consoleSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let tableSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FAVRO_API_TOKEN = 'test-token';
    (resolveApiKey as jest.Mock).mockResolvedValue('test-token');
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    tableSpy = jest.spyOn(console, 'table').mockImplementation(() => {});
    process.exitCode = undefined;
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit must not be called under run()');
    });
  });

  afterEach(() => {
    delete process.env.FAVRO_API_TOKEN;
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    tableSpy.mockRestore();
    exitSpy.mockRestore();
    // Reset resolveApiKey back to undefined so FAVRO_API_TOKEN-missing tests still work
    (resolveApiKey as jest.Mock).mockResolvedValue(undefined);
  });

  // #44 replaced four `--limit` cap tests here. The 100 clamp existed because
  // `--limit` sized the FETCH; it is now a pure OUTPUT cap, so there is nothing
  // to clamp and nothing about it reaches the API.
  test('--limit never reaches the fetch, at any size', async () => {
    const mockListCards = jest.fn().mockResolvedValue([]);
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => ({
      listCards: mockListCards,
    } as any));

    const program = buildProgram();
    await program.parseAsync(['node', 'cli', 'cards', 'list', 'board-123', '--limit', '9999']);

    expect(mockListCards).toHaveBeenCalledWith(
      expect.objectContaining({ boardId: 'board-123', archived: 'false' })
    );
    expect(mockListCards.mock.calls[0][0]).not.toHaveProperty('limit');
    expect(mockListCards.mock.calls[0][0]).not.toHaveProperty('filter');
  });

  test('the output cap trims the rows and marks them truncated', async () => {
    const cards = Array.from({ length: 5 }, (_, i) => ({ cardId: `c${i}`, name: `Card ${i}` }));
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => ({
      listCards: jest.fn().mockResolvedValue(cards),
    } as any));

    const program = buildProgram();
    await program.parseAsync(['node', 'cli', 'cards', 'list', 'board-123', '--limit', '2']);

    const line = consoleSpy.mock.calls.map(c => String(c[0])).find(c => c.startsWith('{"rows":'))!;
    const parsed = JSON.parse(line);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.truncated).toBe(true);
  });

  test('the card body and custom fields are omitted from output, and --body/--include restore them', async () => {
    const cards = [{ cardId: 'c1', name: 'Card', description: 'body text', customFields: [{ f: 1 }] }];
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => ({
      listCards: jest.fn().mockResolvedValue(cards),
    } as any));
    const envelope = () =>
      JSON.parse(consoleSpy.mock.calls.map(c => String(c[0])).filter(c => c.startsWith('{"rows":')).pop()!);

    const program = buildProgram();
    await program.parseAsync(['node', 'cli', 'cards', 'list', 'board-123']);
    expect(envelope().rows[0].description).toBeUndefined();
    expect(envelope().rows[0].customFields).toBeUndefined();

    await program.parseAsync([
      'node', 'cli', 'cards', 'list', 'board-123', '--body', '--include', 'custom-fields',
    ]);
    expect(envelope().rows[0].description).toBe('body text');
    expect(envelope().rows[0].customFields).toEqual([{ f: 1 }]);
  });

  // #46 handoff: `--filter` is parsed and its values settled BEFORE the fetch,
  // so no query runs on a bad filter and a typo never costs a whole board read.
  test('a bad filter refuses before listCards is ever called', async () => {
    const mockListCards = jest.fn().mockResolvedValue([]);
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => ({
      listCards: mockListCards,
    } as any));

    const program = buildProgram();
    await program.parseAsync(['node', 'cli', 'cards', 'list', 'board-123', '--filter', 'nosuchfield:x']);

    expect(process.exitCode).toBe(1);
    expect(mockListCards).not.toHaveBeenCalled();
  });

  // #82: the filter validator runs BEFORE the fetch, so it is the first thing
  // to see the board. Handed a NAME it looked a column up on a board that does
  // not exist and refused with "No column named done on board Backlog - Web
  // Hub" — the wrong problem, named confidently. Both consumers now read one
  // settled id.
  test('cards list settles the board before the filter validator and the fetch', async () => {
    const mockListCards = jest.fn().mockResolvedValue([]);
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => ({
      listCards: mockListCards,
    } as any));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const queryValues = require('../lib/query-values') as typeof import('../lib/query-values');
    const validate = jest
      .spyOn(queryValues, 'resolveCardFilter')
      .mockImplementation(async () => undefined);

    try {
      const program = buildProgram();
      await program.parseAsync([
        'node', 'cli', 'cards', 'list', 'Backlog - Web Hub', '--filter', 'status:Done',
      ]);

      expect(validate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ boardId: 'w-hub-0001' }),
      );
      expect(mockListCards).toHaveBeenCalledWith(
        expect.objectContaining({ boardId: 'w-hub-0001' }),
      );
    } finally {
      validate.mockRestore();
    }
  });

  /**
   * The fail-closed half of the hole notice (#119 review).
   *
   * `cards list --filter unblocked` judges each blocker; one it cannot read
   * leaves its card in the list, so the rows are a SUPERSET rather than an
   * answer. `cli.ts` said that in its own wording until #119 routed this read
   * through the runner, whose notice is generic — "a part of this read could not
   * be reached" — and true of every list read. Both lines print; this arm is the
   * one that says what the hole MEANT, and it is what the migration dropped.
   */
  test('an unreadable blocker says the cards stayed BLOCKED, not just that a read failed', async () => {
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => ({
      listCards: jest.fn().mockResolvedValue([{ cardId: 'c1', name: 'Card' }]),
    } as any));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const queryValues = require('../lib/query-values') as typeof import('../lib/query-values');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const parser = require('../lib/query-parser') as typeof import('../lib/query-parser');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const blocking = require('../lib/blocking') as typeof import('../lib/blocking');
    jest.spyOn(queryValues, 'resolveCardFilter').mockResolvedValue({} as never);
    jest.spyOn(parser, 'queryNames').mockReturnValue(true);
    jest.spyOn(parser, 'filterCards').mockImplementation((_q, cards) => cards as never);
    jest.spyOn(blocking, 'judgeBlockers').mockResolvedValue({
      done: new Set<string>(),
      unreachable: [{ id: 'card-9', reason: '404 Not Found' }],
    } as never);

    await buildProgram().parseAsync([
      'node', 'cli', '--human', 'cards', 'list', 'board-123', '--filter', 'unblocked',
    ]);

    const printed = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('Blockers that could not be checked stayed BLOCKED');
    // Beside the runner's generic notice, not instead of it: that one lists the
    // holes, this one says what leaving them in the list did.
    expect(printed).toContain('(1 part(s) of this read could not be reached:)');
    expect(printed).toContain('card-9 — 404 Not Found');
  });

  test('--archived rides the wire, and a bad value is refused', async () => {
    const mockListCards = jest.fn().mockResolvedValue([]);
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => ({
      listCards: mockListCards,
    } as any));

    const program = buildProgram();
    await program.parseAsync(['node', 'cli', 'cards', 'list', 'board-123', '--archived', 'all']);
    expect(mockListCards).toHaveBeenCalledWith(expect.objectContaining({ archived: 'all' }));

    // `--human`, so the refusal renders on stderr where this arm reads it.
    await buildProgram().parseAsync([
      'node', 'cli', '--human', 'cards', 'list', 'board-123', '--archived', 'maybe',
    ]);
    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('--archived'));
  });
});

describe('cli.ts — cards export options', () => {
  test('cards export has --format option', () => {
    const program = buildProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const exportCmd = cardsCmd.commands.find(c => c.name() === 'export')!;
    const optNames = exportCmd.options.map(o => o.long);
    expect(optNames).toContain('--format');
  });

  test('cards export has --out option', () => {
    const program = buildProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const exportCmd = cardsCmd.commands.find(c => c.name() === 'export')!;
    const optNames = exportCmd.options.map(o => o.long);
    expect(optNames).toContain('--out');
  });

  test('cards export has --filter option', () => {
    const program = buildProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const exportCmd = cardsCmd.commands.find(c => c.name() === 'export')!;
    const optNames = exportCmd.options.map(o => o.long);
    expect(optNames).toContain('--filter');
  });

  // #44 removed `cards export --limit`: it capped the FETCH, so an export could
  // silently be part of a board and still call itself the export.
  test('cards export has NO --limit option', () => {
    const program = buildProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const exportCmd = cardsCmd.commands.find(c => c.name() === 'export')!;
    const optNames = exportCmd.options.map(o => o.long);
    expect(optNames).not.toContain('--limit');
  });
});

describe('cli.ts — FAVRO_API_TOKEN missing causes fast-fail', () => {
  let consoleErrorSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;
  const originalToken = process.env.FAVRO_API_TOKEN;
  const originalApiKey = process.env.FAVRO_API_KEY;

  beforeEach(() => {
    delete process.env.FAVRO_API_TOKEN;
    delete process.env.FAVRO_API_KEY;
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit must not be called under run()');
    });
  });

  afterEach(() => {
    if (originalToken !== undefined) process.env.FAVRO_API_TOKEN = originalToken;
    else delete process.env.FAVRO_API_TOKEN;
    if (originalApiKey !== undefined) process.env.FAVRO_API_KEY = originalApiKey;
    else delete process.env.FAVRO_API_KEY;
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
    process.exitCode = undefined;
  });

  test('cards list exits 1 with API key error when token missing', async () => {
    const program = buildProgram();

    await program.parseAsync(['node', 'cli', '--human', 'cards', 'list']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API key'));
    expect(process.exitCode).toBe(1);
  });

  test('cards create exits 1 with API key error when token missing', async () => {
    const program = buildProgram();

    await program.parseAsync(['node', 'cli', '--human', 'cards', 'create', 'Test Card']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API key'));
    expect(process.exitCode).toBe(1);
  });

  test('cards update exits 1 with API key error when token missing', async () => {
    const program = buildProgram();

    await program.parseAsync(['node', 'cli', '--human', 'cards', 'update', 'card-123']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API key'));
    expect(process.exitCode).toBe(1);
  });

  test('cards export exits 1 with API key error when token missing', async () => {
    const program = buildProgram();

    await program.parseAsync(['node', 'cli', '--human', 'cards', 'export', 'board-123']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API key'));
    expect(process.exitCode).toBe(1);
  });
});
