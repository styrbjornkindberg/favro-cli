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

jest.mock('../lib/cards-api');
jest.mock('../lib/http-client');
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

  test('cards list has --json option', () => {
    const program = buildProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const listCmd = cardsCmd.commands.find(c => c.name() === 'list')!;
    const optNames = listCmd.options.map(o => o.long);
    expect(optNames).toContain('--json');
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

  test('cards export has --limit option', () => {
    const program = buildProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const exportCmd = cardsCmd.commands.find(c => c.name() === 'export')!;
    const optNames = exportCmd.options.map(o => o.long);
    expect(optNames).toContain('--limit');
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
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
  });

  afterEach(() => {
    if (originalToken !== undefined) process.env.FAVRO_API_TOKEN = originalToken;
    else delete process.env.FAVRO_API_TOKEN;
    if (originalApiKey !== undefined) process.env.FAVRO_API_KEY = originalApiKey;
    else delete process.env.FAVRO_API_KEY;
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  test('cards list exits 1 with API key error when token missing', async () => {
    const program = buildProgram();

    await expect(
      program.parseAsync(['node', 'cli', 'cards', 'list'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API key'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('cards create exits 1 with API key error when token missing', async () => {
    const program = buildProgram();

    await expect(
      program.parseAsync(['node', 'cli', 'cards', 'create', 'Test Card'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API key'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('cards update exits 1 with API key error when token missing', async () => {
    const program = buildProgram();

    await expect(
      program.parseAsync(['node', 'cli', 'cards', 'update', 'card-123'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API key'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('cards export exits 1 with API key error when token missing', async () => {
    const program = buildProgram();

    await expect(
      program.parseAsync(['node', 'cli', 'cards', 'export', 'board-123'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API key'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
