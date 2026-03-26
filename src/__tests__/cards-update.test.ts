/**
 * Comprehensive tests for cards-update command
 * CLA-1774: Unit Tests — All Commands
 */
import { registerCardsUpdateCommand } from '../commands/cards-update';
import { Command } from 'commander';
import CardsAPI from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';

jest.mock('../lib/cards-api');
jest.mock('../lib/http-client');

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
  });

  // --- Happy path ---

  test('updates card name', async () => {
    const updatedCard = { cardId: 'card-123', name: 'New Name', createdAt: '2026-01-01', updatedAt: '2026-01-02' };
    const api = buildMockApi({ updateCard: jest.fn().mockResolvedValue(updatedCard) });

    const program = new Command();
    registerCardsUpdateCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'update', 'card-123', '--name', 'New Name']);

    expect(api.updateCard).toHaveBeenCalledWith('card-123', { name: 'New Name' });
    expect(consoleSpy).toHaveBeenCalledWith('✓ Card updated: card-123');
  });

  test('updates card status', async () => {
    const updatedCard = { cardId: 'card-123', name: 'Task', status: 'done', createdAt: '2026-01-01', updatedAt: '2026-01-02' };
    const api = buildMockApi({ updateCard: jest.fn().mockResolvedValue(updatedCard) });

    const program = new Command();
    registerCardsUpdateCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'update', 'card-123', '--status', 'done']);

    expect(api.updateCard).toHaveBeenCalledWith('card-123', { status: 'done' });
  });

  test('updates card description', async () => {
    const updatedCard = { cardId: 'card-abc', name: 'Task', description: 'New desc', createdAt: '2026-01-01', updatedAt: '2026-01-02' };
    const api = buildMockApi({ updateCard: jest.fn().mockResolvedValue(updatedCard) });

    const program = new Command();
    registerCardsUpdateCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'update', 'card-abc', '--description', 'New desc']);

    expect(api.updateCard).toHaveBeenCalledWith('card-abc', { description: 'New desc' });
  });

  test('updates card with comma-separated assignees', async () => {
    const updatedCard = { cardId: 'card-abc', name: 'Task', assignees: ['alice', 'bob'], createdAt: '2026-01-01', updatedAt: '2026-01-02' };
    const api = buildMockApi({ updateCard: jest.fn().mockResolvedValue(updatedCard) });

    const program = new Command();
    registerCardsUpdateCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'update', 'card-abc', '--assignees', 'alice,bob']);

    expect(api.updateCard).toHaveBeenCalledWith('card-abc', { assignees: ['alice', 'bob'] });
  });

  test('updates card with comma-separated tags', async () => {
    const updatedCard = { cardId: 'card-abc', name: 'Task', tags: ['bug', 'urgent'], createdAt: '2026-01-01', updatedAt: '2026-01-02' };
    const api = buildMockApi({ updateCard: jest.fn().mockResolvedValue(updatedCard) });

    const program = new Command();
    registerCardsUpdateCommand(program);
    await program.parseAsync(['node', 'test', 'cards', 'update', 'card-abc', '--tags', 'bug,urgent']);

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
    await program.parseAsync(['node', 'test', 'cards', 'update', 'card-json', '--name', 'JSON Card', '--json']);

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
    await program.parseAsync(['node', 'test', 'cards', 'update', 'card-partial', '--name', 'Partial']);

    // Should NOT include description, status, assignees, tags
    expect(api.updateCard).toHaveBeenCalledWith('card-partial', { name: 'Partial' });
    const callArg = (api.updateCard as jest.Mock).mock.calls[0][1];
    expect(callArg).not.toHaveProperty('description');
    expect(callArg).not.toHaveProperty('status');
    expect(callArg).not.toHaveProperty('assignees');
    expect(callArg).not.toHaveProperty('tags');
  });

  // --- Error cases ---

  test('handles API error gracefully', async () => {
    buildMockApi({ updateCard: jest.fn().mockRejectedValue(new Error('Not found')) });

    const program = new Command();
    registerCardsUpdateCommand(program);

    await expect(
      program.parseAsync(['node', 'test', 'cards', 'update', 'bad-id', '--name', 'New'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Not found'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('handles rate limiting error (429)', async () => {
    buildMockApi({ updateCard: jest.fn().mockRejectedValue(new Error('Rate limit exceeded')) });

    const program = new Command();
    registerCardsUpdateCommand(program);

    await expect(
      program.parseAsync(['node', 'test', 'cards', 'update', 'card-x', '--status', 'done'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  test('handles network timeout error', async () => {
    buildMockApi({ updateCard: jest.fn().mockRejectedValue(new Error('ECONNABORTED')) });

    const program = new Command();
    registerCardsUpdateCommand(program);

    await expect(
      program.parseAsync(['node', 'test', 'cards', 'update', 'card-x', '--name', 'Test'])
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
      await program.parseAsync(['node', 'test', 'cards', 'update', cardId, '--status', 'done']);
    }

    expect(api.updateCard).toHaveBeenCalledTimes(cardIds.length);
    cardIds.forEach((id, idx) => {
      expect((api.updateCard as jest.Mock).mock.calls[idx][0]).toBe(id);
    });
  });
});
