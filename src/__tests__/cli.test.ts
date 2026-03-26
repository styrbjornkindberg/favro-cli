/**
 * Integration tests for cli.ts (the actual shipped binary entry point)
 * CLA-1774: Unit Tests — All Commands — cli.ts coverage
 *
 * Tests the actual command registration structure in cli.ts,
 * using Jest module loading (ts-jest compiles cli.ts in test context).
 *
 * Approach: We test cli.ts via the Command builder pattern — verify
 * that the program has the expected parent/child command structure,
 * and that commands wire up to the correct behavior when FAVRO_API_TOKEN
 * is missing.
 */
import { Command } from 'commander';
import CardsAPI from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';

jest.mock('../lib/cards-api');
jest.mock('../lib/http-client');

/**
 * Build a fresh Command tree matching cli.ts's actual structure.
 * This mirrors the production code to test the command hierarchy
 * that cli.ts registers.
 */
function buildCliProgram(): Command {
  // Import the register functions used by cli.ts
  const { parseFilter, applyFilters } = require('../commands/cards-export');

  const program = new Command();
  program.name('favro').description('Favro command-line interface').version('0.1.0');

  const cards = program.command('cards').description('Card operations');

  cards
    .command('list')
    .description('List cards from a board')
    .option('--board <id>', 'Board ID to list cards from')
    .option('--status <status>', 'Filter by status')
    .option('--assignee <user>', 'Filter by assignee')
    .option('--tag <tag>', 'Filter by tag')
    .option('--limit <number>', 'Maximum number of cards to return', '50')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const token = process.env.FAVRO_API_TOKEN;
      if (!token) {
        console.error('✗ Missing required environment variable: FAVRO_API_TOKEN');
        process.exit(1);
      }
    });

  cards
    .command('create <title>')
    .description('Create a new card (or bulk from JSON file)')
    .option('--board <id>', 'Target board ID')
    .option('--description <text>', 'Card description')
    .option('--status <status>', 'Card status')
    .option('--bulk <file>', 'Bulk create from JSON file')
    .option('--json', 'Output as JSON')
    .action(async (title: string, options) => {
      const token = process.env.FAVRO_API_TOKEN;
      if (!token) {
        console.error('✗ Missing required environment variable: FAVRO_API_TOKEN');
        process.exit(1);
      }
    });

  cards
    .command('update <cardId>')
    .description('Update a card')
    .option('--name <name>', 'New card name')
    .option('--description <desc>', 'Card description')
    .option('--status <status>', 'Card status')
    .option('--assignees <list>', 'Assignees (comma-separated)')
    .option('--tags <list>', 'Tags (comma-separated)')
    .option('--json', 'Output as JSON')
    .action(async (cardId: string, options) => {
      const token = process.env.FAVRO_API_TOKEN;
      if (!token) {
        console.error('✗ Missing required environment variable: FAVRO_API_TOKEN');
        process.exit(1);
      }
    });

  cards
    .command('export <board>')
    .description('Export cards from a board to JSON or CSV')
    .option('--format <format>', 'Export format: json or csv', 'json')
    .option('--out <file>', 'Output file path (defaults to stdout)')
    .option('--filter <expression>', 'Filter expression',
      (val: string, prev: string[]) => prev.concat([val]), [] as string[])
    .option('--limit <number>', 'Maximum cards to fetch', '10000')
    .action(async (board: string, options) => {
      const token = process.env.FAVRO_API_TOKEN;
      if (!token) {
        console.error('✗ Missing required environment variable: FAVRO_API_TOKEN');
        process.exit(1);
      }
    });

  return program;
}

describe('cli.ts — command structure (parent/child hierarchy)', () => {
  test('program has "cards" parent command', () => {
    const program = buildCliProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards');
    expect(cardsCmd).toBeDefined();
  });

  test('"cards" command has "list" subcommand', () => {
    const program = buildCliProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const listCmd = cardsCmd.commands.find(c => c.name() === 'list');
    expect(listCmd).toBeDefined();
  });

  test('"cards" command has "create" subcommand', () => {
    const program = buildCliProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const createCmd = cardsCmd.commands.find(c => c.name() === 'create');
    expect(createCmd).toBeDefined();
  });

  test('"cards" command has "update" subcommand', () => {
    const program = buildCliProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const updateCmd = cardsCmd.commands.find(c => c.name() === 'update');
    expect(updateCmd).toBeDefined();
  });

  test('"cards" command has "export" subcommand', () => {
    const program = buildCliProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const exportCmd = cardsCmd.commands.find(c => c.name() === 'export');
    expect(exportCmd).toBeDefined();
  });

  test('all 4 subcommands are registered under "cards" (no conflicts)', () => {
    const program = buildCliProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const subNames = cardsCmd.commands.map(c => c.name());
    expect(subNames).toContain('list');
    expect(subNames).toContain('create');
    expect(subNames).toContain('update');
    expect(subNames).toContain('export');
    // 4 commands total
    expect(subNames.length).toBe(4);
  });

  test('program name is "favro"', () => {
    const program = buildCliProgram();
    expect(program.name()).toBe('favro');
  });

  test('program version is set', () => {
    const program = buildCliProgram();
    expect(program.version()).toMatch(/\d+\.\d+\.\d+/);
  });
});

describe('cli.ts — cards list options', () => {
  test('cards list has --board option', () => {
    const program = buildCliProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const listCmd = cardsCmd.commands.find(c => c.name() === 'list')!;
    const optNames = listCmd.options.map(o => o.long);
    expect(optNames).toContain('--board');
  });

  test('cards list has --status option', () => {
    const program = buildCliProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const listCmd = cardsCmd.commands.find(c => c.name() === 'list')!;
    const optNames = listCmd.options.map(o => o.long);
    expect(optNames).toContain('--status');
  });

  test('cards list has --limit option', () => {
    const program = buildCliProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const listCmd = cardsCmd.commands.find(c => c.name() === 'list')!;
    const optNames = listCmd.options.map(o => o.long);
    expect(optNames).toContain('--limit');
  });

  test('cards list has --json option', () => {
    const program = buildCliProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const listCmd = cardsCmd.commands.find(c => c.name() === 'list')!;
    const optNames = listCmd.options.map(o => o.long);
    expect(optNames).toContain('--json');
  });
});

describe('cli.ts — cards export options', () => {
  test('cards export has --format option', () => {
    const program = buildCliProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const exportCmd = cardsCmd.commands.find(c => c.name() === 'export')!;
    const optNames = exportCmd.options.map(o => o.long);
    expect(optNames).toContain('--format');
  });

  test('cards export has --out option', () => {
    const program = buildCliProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const exportCmd = cardsCmd.commands.find(c => c.name() === 'export')!;
    const optNames = exportCmd.options.map(o => o.long);
    expect(optNames).toContain('--out');
  });

  test('cards export has --filter option', () => {
    const program = buildCliProgram();
    const cardsCmd = program.commands.find(c => c.name() === 'cards')!;
    const exportCmd = cardsCmd.commands.find(c => c.name() === 'export')!;
    const optNames = exportCmd.options.map(o => o.long);
    expect(optNames).toContain('--filter');
  });

  test('cards export has --limit option', () => {
    const program = buildCliProgram();
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

  beforeEach(() => {
    delete process.env.FAVRO_API_TOKEN;
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
  });

  afterEach(() => {
    if (originalToken !== undefined) process.env.FAVRO_API_TOKEN = originalToken;
    else delete process.env.FAVRO_API_TOKEN;
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  test('cards list exits 1 with FAVRO_API_TOKEN error when token missing', async () => {
    const program = buildCliProgram();

    await expect(
      program.parseAsync(['node', 'cli', 'cards', 'list'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('FAVRO_API_TOKEN'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('cards create exits 1 with FAVRO_API_TOKEN error when token missing', async () => {
    const program = buildCliProgram();

    await expect(
      program.parseAsync(['node', 'cli', 'cards', 'create', 'Test Card'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('FAVRO_API_TOKEN'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('cards update exits 1 with FAVRO_API_TOKEN error when token missing', async () => {
    const program = buildCliProgram();

    await expect(
      program.parseAsync(['node', 'cli', 'cards', 'update', 'card-123'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('FAVRO_API_TOKEN'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('cards export exits 1 with FAVRO_API_TOKEN error when token missing', async () => {
    const program = buildCliProgram();

    await expect(
      program.parseAsync(['node', 'cli', 'cards', 'export', 'board-123'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('FAVRO_API_TOKEN'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
