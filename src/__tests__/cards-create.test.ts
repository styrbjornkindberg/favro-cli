/**
 * Comprehensive tests for cards-create command
 * CLA-1774: Unit Tests — All Commands
 */
import { registerCardsCreateCommand } from '../commands/cards-create';
import { Command } from 'commander';
import CardsAPI from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';
import * as fs from 'fs/promises';

jest.mock('../lib/cards-api');
jest.mock('../lib/http-client');
jest.mock('fs/promises');
jest.mock('../lib/config');

import * as config from '../lib/config';

const mockFs = fs as jest.Mocked<typeof fs>;

function buildMockApi(overrides: Partial<InstanceType<typeof CardsAPI>> = {}) {
  const base = {
    listCards: jest.fn(),
    getCard: jest.fn(),
    createCard: jest.fn(),
    createCards: jest.fn(),
    updateCard: jest.fn(),
    deleteCard: jest.fn(),
    searchCards: jest.fn(),
    ...overrides,
  };
  (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => base as any);
  (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({} as any));
  return base;
}

describe('Cards Create Command', () => {
  let consoleSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;
  const originalEnv = process.env.FAVRO_API_TOKEN;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FAVRO_API_TOKEN = 'test-token';
    (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
    (config.readConfig as jest.Mock).mockResolvedValue({});
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.FAVRO_API_TOKEN;
    } else {
      process.env.FAVRO_API_TOKEN = originalEnv;
    }
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // --- Registration ---

  test('registers cards create command on program', () => {
    const program = new Command();
    registerCardsCreateCommand(program);
    const cmd = program.commands.find(c => c.name() === 'cards');
    expect(cmd).toBeDefined();
  });

  test('create command has expected options', () => {
    const program = new Command();
    registerCardsCreateCommand(program);
    const cmd = program.commands.find(c => c.name() === 'cards');
    const optionNames = cmd!.options.map(o => o.long);
    expect(optionNames).toContain('--board');
    expect(optionNames).toContain('--description');
    expect(optionNames).toContain('--status');
    expect(optionNames).toContain('--bulk');
    expect(optionNames).toContain('--json');
  });

  // --- Single card create ---

  test('creates a single card with title', async () => {
    const mockCard = { cardId: 'new-card-1', name: 'My Card', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
    const api = buildMockApi({ createCard: jest.fn().mockResolvedValue(mockCard) });

    const program = new Command();
    registerCardsCreateCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'create', 'My Card']);

    expect(api.createCard).toHaveBeenCalledWith({
      name: 'My Card',
      description: undefined,
      status: undefined,
      boardId: undefined,
    });
    expect(consoleSpy).toHaveBeenCalledWith('✓ Card created: new-card-1');
  });

  test('creates a single card with all options', async () => {
    const mockCard = { cardId: 'card-2', name: 'Full Card', description: 'A desc', status: 'todo', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
    const api = buildMockApi({ createCard: jest.fn().mockResolvedValue(mockCard) });

    const program = new Command();
    registerCardsCreateCommand(program);
    await program.parseAsync([
      'node', 'test',
      'cards', 'create', 'Full Card',
      '--description', 'A desc',
      '--status', 'todo',
      '--board', 'board-abc',
    ]);

    expect(api.createCard).toHaveBeenCalledWith({
      name: 'Full Card',
      description: 'A desc',
      status: 'todo',
      boardId: 'board-abc',
    });
  });

  test('outputs JSON when --json flag is used (single card)', async () => {
    const mockCard = { cardId: 'json-card', name: 'JSON Card', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
    buildMockApi({ createCard: jest.fn().mockResolvedValue(mockCard) });

    const program = new Command();
    registerCardsCreateCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'create', 'JSON Card', '--json']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"cardId":"json-card"') || JSON.stringify(mockCard));
    // Check that JSON was output (second call to console.log)
    const calls = consoleSpy.mock.calls.map(c => c[0]);
    const jsonCall = calls.find(c => typeof c === 'string' && c.startsWith('{'));
    expect(jsonCall).toBeDefined();
  });

  // --- Bulk create ---

  test('bulk creates cards from JSON file', async () => {
    const mockCards = [
      { cardId: 'bulk-1', name: 'Bulk Card 1', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      { cardId: 'bulk-2', name: 'Bulk Card 2', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    ];
    const inputData = [{ name: 'Bulk Card 1' }, { name: 'Bulk Card 2' }];
    mockFs.readFile.mockResolvedValue(JSON.stringify(inputData) as any);
    const api = buildMockApi({ createCards: jest.fn().mockResolvedValue(mockCards) });

    const program = new Command();
    registerCardsCreateCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'create', 'ignored', '--bulk', 'cards.json']);

    expect(api.createCards).toHaveBeenCalledWith(inputData);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Created 2 cards'));
  });

  test('bulk create outputs JSON when --json flag is used', async () => {
    const mockCards = [
      { cardId: 'bulk-1', name: 'Card 1', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    ];
    mockFs.readFile.mockResolvedValue(JSON.stringify([{ name: 'Card 1' }]) as any);
    buildMockApi({ createCards: jest.fn().mockResolvedValue(mockCards) });

    const program = new Command();
    registerCardsCreateCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'create', 'x', '--bulk', 'in.json', '--json']);

    const calls = consoleSpy.mock.calls.map(c => c[0]);
    const jsonCall = calls.find(c => typeof c === 'string' && c.startsWith('['));
    expect(jsonCall).toBeDefined();
    const parsed = JSON.parse(jsonCall!);
    expect(parsed).toHaveLength(1);
  });

  test('bulk create with 100+ cards (large batch)', async () => {
    const inputData = Array.from({ length: 150 }, (_, i) => ({ name: `Card ${i}` }));
    const mockCards = inputData.map((c, i) => ({
      cardId: `bulk-${i}`, name: c.name, createdAt: '2026-01-01', updatedAt: '2026-01-01'
    }));
    mockFs.readFile.mockResolvedValue(JSON.stringify(inputData) as any);
    const api = buildMockApi({ createCards: jest.fn().mockResolvedValue(mockCards) });

    const program = new Command();
    registerCardsCreateCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'create', 'ignored', '--bulk', 'large.json']);

    expect(api.createCards).toHaveBeenCalledWith(inputData);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Created 150 cards'));
  });

  // --- Error cases ---

  test('handles API error on single create', async () => {
    buildMockApi({ createCard: jest.fn().mockRejectedValue(new Error('API down')) });

    const program = new Command();
    registerCardsCreateCommand(program);

    await expect(
      program.parseAsync(['node', 'test', 'cards', 'create', 'My Card'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API down'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('handles file read error on bulk create', async () => {
    buildMockApi();
    mockFs.readFile.mockRejectedValue(new Error('File not found'));

    const program = new Command();
    registerCardsCreateCommand(program);

    await expect(
      program.parseAsync(['node', 'test', 'cards', 'create', 'ignored', '--bulk', 'missing.json'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('File not found'));
  });

  test('handles malformed JSON in bulk file', async () => {
    buildMockApi();
    mockFs.readFile.mockResolvedValue('not valid json{{{' as any);

    const program = new Command();
    registerCardsCreateCommand(program);

    await expect(
      program.parseAsync(['node', 'test', 'cards', 'create', 'ignored', '--bulk', 'bad.json'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  test('handles rate limiting (429-like API error)', async () => {
    const rateLimitError = new Error('Request rate limit exceeded');
    buildMockApi({ createCard: jest.fn().mockRejectedValue(rateLimitError) });

    const program = new Command();
    registerCardsCreateCommand(program);

    await expect(
      program.parseAsync(['node', 'test', 'cards', 'create', 'Rate Test'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('rate limit'));
  });

  test('handles network timeout error', async () => {
    const timeoutError = new Error('Network timeout');
    buildMockApi({ createCard: jest.fn().mockRejectedValue(timeoutError) });

    const program = new Command();
    registerCardsCreateCommand(program);

    await expect(
      program.parseAsync(['node', 'test', 'cards', 'create', 'Timeout Test'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Network timeout'));
  });
});
