/**
 * Comprehensive tests for cards-update command
 * CLA-1774: Unit Tests — All Commands
 */
import { registerCardsUpdateCommand, BATCH_LIMIT, confirmPrompt } from '../commands/cards-update';
import { Command } from 'commander';
import CardsAPI from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';
import * as readline from 'readline';

jest.mock('../lib/cards-api');
jest.mock('../lib/http-client');
jest.mock('readline');

const mockReadline = readline as jest.Mocked<typeof readline>;

function buildMockApi(overrides: Record<string, jest.Mock> = {}) {
  const base: Record<string, jest.Mock> = {
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

function mockConfirmAnswer(answer: string) {
  // Mock readline.createInterface to auto-answer with the given string
  (mockReadline.createInterface as jest.Mock).mockReturnValue({
    question: jest.fn((_q: string, cb: (answer: string) => void) => cb(answer)),
    close: jest.fn(),
  });
}

describe('Cards Update Command', () => {
  let consoleSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;
  const originalEnv = process.env.FAVRO_API_TOKEN;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FAVRO_API_TOKEN = 'test-token';
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    // Default: auto-confirm 'y'
    mockConfirmAnswer('y');
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

  // --- Constants ---

  test('BATCH_LIMIT is 100', () => {
    expect(BATCH_LIMIT).toBe(100);
  });

  // --- Registration ---

  test('registers update command on program', () => {
    const program = new Command();
    registerCardsUpdateCommand(program);
    expect(program.commands.length).toBeGreaterThan(0);
  });

  test('update command has expected options', () => {
    const program = new Command();
    registerCardsUpdateCommand(program);
    const cmd = program.commands.find(c => c.name() === 'cards');
    const optionNames = cmd!.options.map(o => o.long);
    expect(optionNames).toContain('--name');
    expect(optionNames).toContain('--description');
    expect(optionNames).toContain('--status');
    expect(optionNames).toContain('--assignees');
    expect(optionNames).toContain('--tags');
    expect(optionNames).toContain('--json');
    expect(optionNames).toContain('--dry-run');
    expect(optionNames).toContain('--yes');
  });

  // --- Happy path (with --yes to skip confirmation) ---

  test('updates card name', async () => {
    const updatedCard = { cardId: 'card-123', name: 'New Name', createdAt: '2026-01-01', updatedAt: '2026-01-02' };
    const api = buildMockApi({ updateCard: jest.fn().mockResolvedValue(updatedCard) });

    const program = new Command();
    registerCardsUpdateCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'update', 'card-123', '--name', 'New Name', '--yes']);

    expect(api.updateCard).toHaveBeenCalledWith('card-123', { name: 'New Name' });
    expect(consoleSpy).toHaveBeenCalledWith('✓ Card updated: card-123');
  });

  test('updates card status', async () => {
    const updatedCard = { cardId: 'card-123', name: 'Task', status: 'done', createdAt: '2026-01-01', updatedAt: '2026-01-02' };
    const api = buildMockApi({ updateCard: jest.fn().mockResolvedValue(updatedCard) });

    const program = new Command();
    registerCardsUpdateCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'update', 'card-123', '--status', 'done', '--yes']);

    expect(api.updateCard).toHaveBeenCalledWith('card-123', { status: 'done' });
  });

  test('updates card description', async () => {
    const updatedCard = { cardId: 'card-abc', name: 'Task', description: 'New desc', createdAt: '2026-01-01', updatedAt: '2026-01-02' };
    const api = buildMockApi({ updateCard: jest.fn().mockResolvedValue(updatedCard) });

    const program = new Command();
    registerCardsUpdateCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'update', 'card-abc', '--description', 'New desc', '--yes']);

    expect(api.updateCard).toHaveBeenCalledWith('card-abc', { description: 'New desc' });
  });

  test('updates card with comma-separated assignees', async () => {
    const updatedCard = { cardId: 'card-abc', name: 'Task', assignees: ['alice', 'bob'], createdAt: '2026-01-01', updatedAt: '2026-01-02' };
    const api = buildMockApi({ updateCard: jest.fn().mockResolvedValue(updatedCard) });

    const program = new Command();
    registerCardsUpdateCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'update', 'card-abc', '--assignees', 'alice,bob', '--yes']);

    expect(api.updateCard).toHaveBeenCalledWith('card-abc', { assignees: ['alice', 'bob'] });
  });

  test('updates card with comma-separated tags', async () => {
    const updatedCard = { cardId: 'card-abc', name: 'Task', tags: ['bug', 'urgent'], createdAt: '2026-01-01', updatedAt: '2026-01-02' };
    const api = buildMockApi({ updateCard: jest.fn().mockResolvedValue(updatedCard) });

    const program = new Command();
    registerCardsUpdateCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'update', 'card-abc', '--tags', 'bug,urgent', '--yes']);

    expect(api.updateCard).toHaveBeenCalledWith('card-abc', { tags: ['bug', 'urgent'] });
  });

  test('updates card with all options at once', async () => {
    const updatedCard = {
      cardId: 'card-all', name: 'Updated', description: 'Desc', status: 'in-progress',
      assignees: ['alice'], tags: ['feature'], createdAt: '2026-01-01', updatedAt: '2026-01-02'
    };
    const api = buildMockApi({ updateCard: jest.fn().mockResolvedValue(updatedCard) });

    const program = new Command();
    registerCardsUpdateCommand(program);
    await program.parseAsync([
      'node', 'test', 'cards', 'update', 'card-all',
      '--name', 'Updated',
      '--description', 'Desc',
      '--status', 'in-progress',
      '--assignees', 'alice',
      '--tags', 'feature',
      '--yes',
    ]);

    expect(api.updateCard).toHaveBeenCalledWith('card-all', {
      name: 'Updated',
      description: 'Desc',
      status: 'in-progress',
      assignees: ['alice'],
      tags: ['feature'],
    });
  });

  test('outputs JSON when --json flag is used', async () => {
    const updatedCard = { cardId: 'card-json', name: 'JSON Card', createdAt: '2026-01-01', updatedAt: '2026-01-02' };
    buildMockApi({ updateCard: jest.fn().mockResolvedValue(updatedCard) });

    const program = new Command();
    registerCardsUpdateCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'update', 'card-json', '--name', 'JSON Card', '--json', '--yes']);

    const calls = consoleSpy.mock.calls.map(c => c[0]);
    const jsonCall = calls.find(c => typeof c === 'string' && c.startsWith('{'));
    expect(jsonCall).toBeDefined();
    const parsed = JSON.parse(jsonCall!);
    expect(parsed.cardId).toBe('card-json');
  });

  test('sends only provided fields in update payload', async () => {
    const updatedCard = { cardId: 'card-partial', name: 'Partial', createdAt: '2026-01-01', updatedAt: '2026-01-02' };
    const api = buildMockApi({ updateCard: jest.fn().mockResolvedValue(updatedCard) });

    const program = new Command();
    registerCardsUpdateCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'update', 'card-partial', '--name', 'Partial', '--yes']);

    // Should NOT include description, status, assignees, tags
    expect(api.updateCard).toHaveBeenCalledWith('card-partial', { name: 'Partial' });
    const callArg = (api.updateCard as jest.Mock).mock.calls[0][1];
    expect(callArg).not.toHaveProperty('description');
    expect(callArg).not.toHaveProperty('status');
    expect(callArg).not.toHaveProperty('assignees');
    expect(callArg).not.toHaveProperty('tags');
  });

  // --- Dry-run mode ---

  test('dry-run shows what would be updated without calling API', async () => {
    const api = buildMockApi({ updateCard: jest.fn() });

    const program = new Command();
    registerCardsUpdateCommand(program);
    await program.parseAsync([
      'node', 'test', 'cards', 'update', 'card-123',
      '--name', 'New Name',
      '--dry-run',
    ]);

    expect(api.updateCard).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[dry-run]'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('card-123'));
  });

  test('dry-run shows the changes that would be applied', async () => {
    buildMockApi({ updateCard: jest.fn() });

    const program = new Command();
    registerCardsUpdateCommand(program);
    await program.parseAsync([
      'node', 'test', 'cards', 'update', 'card-dry',
      '--status', 'done',
      '--dry-run',
    ]);

    expect(consoleSpy).toHaveBeenCalledWith(
      '[dry-run] Changes:',
      JSON.stringify({ status: 'done' }, null, 2)
    );
  });

  // --- Confirmation prompt ---

  test('cancels update when user answers no to confirmation', async () => {
    mockConfirmAnswer('n');
    const api = buildMockApi({ updateCard: jest.fn() });

    const program = new Command();
    registerCardsUpdateCommand(program);
    await program.parseAsync([
      'node', 'test', 'cards', 'update', 'card-123',
      '--name', 'New Name',
    ]);

    expect(api.updateCard).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith('Update cancelled.');
  });

  test('proceeds with update when user answers yes to confirmation', async () => {
    mockConfirmAnswer('yes');
    const updatedCard = { cardId: 'card-123', name: 'Confirmed', createdAt: '2026-01-01', updatedAt: '2026-01-02' };
    const api = buildMockApi({ updateCard: jest.fn().mockResolvedValue(updatedCard) });

    const program = new Command();
    registerCardsUpdateCommand(program);
    await program.parseAsync([
      'node', 'test', 'cards', 'update', 'card-123',
      '--name', 'Confirmed',
    ]);

    expect(api.updateCard).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith('✓ Card updated: card-123');
  });

  test('--yes flag skips confirmation prompt', async () => {
    const updatedCard = { cardId: 'card-skip', name: 'Skipped', createdAt: '2026-01-01', updatedAt: '2026-01-02' };
    const api = buildMockApi({ updateCard: jest.fn().mockResolvedValue(updatedCard) });

    const program = new Command();
    registerCardsUpdateCommand(program);
    await program.parseAsync([
      'node', 'test', 'cards', 'update', 'card-skip',
      '--name', 'Skipped',
      '--yes',
    ]);

    // readline.createInterface should NOT have been called since --yes skips it
    expect(mockReadline.createInterface).not.toHaveBeenCalled();
    expect(api.updateCard).toHaveBeenCalled();
  });

  // --- Error cases ---

  test('handles API error gracefully', async () => {
    buildMockApi({ updateCard: jest.fn().mockRejectedValue(new Error('Not found')) });

    const program = new Command();
    registerCardsUpdateCommand(program);

    await expect(
      program.parseAsync(['node', 'test', 'cards', 'update', 'bad-id', '--name', 'New', '--yes'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Not found'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('handles rate limiting error (429)', async () => {
    buildMockApi({ updateCard: jest.fn().mockRejectedValue(new Error('Rate limit exceeded')) });

    const program = new Command();
    registerCardsUpdateCommand(program);

    await expect(
      program.parseAsync(['node', 'test', 'cards', 'update', 'card-x', '--status', 'done', '--yes'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  test('handles network timeout error', async () => {
    buildMockApi({ updateCard: jest.fn().mockRejectedValue(new Error('ECONNABORTED')) });

    const program = new Command();
    registerCardsUpdateCommand(program);

    await expect(
      program.parseAsync(['node', 'test', 'cards', 'update', 'card-x', '--name', 'Test', '--yes'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('ECONNABORTED'));
  });

  // --- Batch operation simulation ---

  test('updates multiple cards in sequence (simulated batch)', async () => {
    const cardIds = Array.from({ length: 5 }, (_, i) => `card-${i}`);
    const api = buildMockApi({
      updateCard: jest.fn().mockImplementation(async (id) => ({
        cardId: id, name: 'Updated', createdAt: '2026-01-01', updatedAt: '2026-01-02'
      }))
    });

    for (const cardId of cardIds) {
      const program = new Command();
      registerCardsUpdateCommand(program);
      await program.parseAsync(['node', 'test', 'cards', 'update', cardId, '--status', 'done', '--yes']);
    }

    expect(api.updateCard).toHaveBeenCalledTimes(cardIds.length);
    cardIds.forEach((id, idx) => {
      expect((api.updateCard as jest.Mock).mock.calls[idx][0]).toBe(id);
    });
  });

  // --- confirmPrompt unit test ---

  test('confirmPrompt returns true for "y"', async () => {
    mockConfirmAnswer('y');
    const result = await confirmPrompt('Are you sure? (y/n) ');
    expect(result).toBe(true);
  });

  test('confirmPrompt returns true for "yes"', async () => {
    mockConfirmAnswer('yes');
    const result = await confirmPrompt('Are you sure? (y/n) ');
    expect(result).toBe(true);
  });

  test('confirmPrompt returns false for "n"', async () => {
    mockConfirmAnswer('n');
    const result = await confirmPrompt('Are you sure? (y/n) ');
    expect(result).toBe(false);
  });

  test('confirmPrompt returns false for any non-yes answer', async () => {
    mockConfirmAnswer('maybe');
    const result = await confirmPrompt('Are you sure? (y/n) ');
    expect(result).toBe(false);
  });
});
