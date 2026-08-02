/**
 * Unit tests for cards-get command
 * CLA-1785 (FAVRO-023): Advanced Cards Endpoints
 */
import { registerCardsGetCommand } from '../commands/cards-get';
import { Command } from 'commander';
import CardsAPI, { Card } from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';
import * as config from '../lib/config';

jest.mock('../lib/cards-api');
jest.mock('../lib/http-client');
jest.mock('../lib/config');

const sampleCard: Card = {
  cardId: 'card-abc',
  name: 'Fix login bug',
  status: 'in-progress',
  assignees: ['alice@example.com'],
  tags: ['bug'],
  dueDate: '2026-04-01',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

function buildMockApi(card: Card = sampleCard) {
  const mockGetCard = jest.fn().mockResolvedValue(card);
  (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => ({
    getCard: mockGetCard,
    listCards: jest.fn(),
    createCard: jest.fn(),
    updateCard: jest.fn(),
    deleteCard: jest.fn(),
    searchCards: jest.fn(),
    linkCard: jest.fn(),
    unlinkCard: jest.fn(),
    moveCard: jest.fn(),
  } as any));
  (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({} as any));
  return mockGetCard;
}

/**
 * A `cards` parent carrying the flags the runner owns. `cli.ts` declares them
 * on the root; these tests parse from `cards` down, and `resolveFormat` reads
 * them with globals merged, so declaring them on the parse root is equivalent.
 */
function buildCards(): Command {
  const cards = new Command('cards');
  cards.option('--human').option('--pretty').option('--verbose');
  cards.exitOverride();
  return cards;
}

describe('Cards Get Command', () => {
  let consoleSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let tableSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.exitCode = undefined;
    process.env.FAVRO_API_KEY = 'test-key';
    (config.resolveApiKey as jest.Mock).mockResolvedValue('test-key');
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    tableSpy = jest.spyOn(console, 'table').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = undefined;
    delete process.env.FAVRO_API_KEY;
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    tableSpy.mockRestore();
  });

  // --- Registration ---

  test('registers get command on cards parent', () => {
    const cardsCmd = buildCards();
    registerCardsGetCommand(cardsCmd);
    const cmd = cardsCmd.commands.find(c => c.name() === 'get');
    expect(cmd).toBeDefined();
  });

  test('get command has expected options', () => {
    const cardsCmd = buildCards();
    registerCardsGetCommand(cardsCmd);
    const cmd = cardsCmd.commands.find(c => c.name() === 'get')!;
    const optNames = cmd.options.map(o => o.long);
    expect(optNames).toContain('--include');
    // `--json` is gone: JSON is the default now, `--human` opts out (ADR-0002).
    expect(optNames).not.toContain('--json');
  });

  // --- Happy path ---

  test('fetches card by id and outputs table under --human', async () => {
    const mockGetCard = buildMockApi();
    const cardsCmd = buildCards();
    registerCardsGetCommand(cardsCmd);
    await cardsCmd.parseAsync(['node', 'cards', 'get', 'card-abc', '--human']);

    expect(mockGetCard).toHaveBeenCalledWith('card-abc', { include: [] });
    expect(tableSpy).toHaveBeenCalled();
  });

  test('outputs JSON with no flags at all', async () => {
    buildMockApi();
    const cardsCmd = buildCards();
    registerCardsGetCommand(cardsCmd);
    await cardsCmd.parseAsync(['node', 'cards', 'get', 'card-abc']);

    const calls = consoleSpy.mock.calls.map(c => c[0]);
    const jsonCall = calls.find(c => typeof c === 'string' && c.includes('"cardId"'));
    expect(jsonCall).toBeDefined();
    const parsed = JSON.parse(jsonCall!);
    expect(parsed.cardId).toBe('card-abc');
    expect(tableSpy).not.toHaveBeenCalled();
  });

  test('outputs JSON when --include is used (metadata mode)', async () => {
    const cardWithBoard = {
      ...sampleCard,
      board: { boardId: 'board-1', name: 'Sprint Board' },
    };
    buildMockApi(cardWithBoard);
    const cardsCmd = buildCards();
    registerCardsGetCommand(cardsCmd);
    // Even under --human: with metadata asked for, the one-row summary would
    // hide most of what was fetched, so the formatter steps aside.
    await cardsCmd.parseAsync(['node', 'cards', 'get', 'card-abc', '--include', 'board', '--human']);

    const calls = consoleSpy.mock.calls.map(c => c[0]);
    const jsonCall = calls.find(c => typeof c === 'string' && c.includes('"cardId"'));
    expect(jsonCall).toBeDefined();
    expect(tableSpy).not.toHaveBeenCalled();
  });

  test('passes include list to getCard', async () => {
    const mockGetCard = buildMockApi();
    const cardsCmd = buildCards();
    registerCardsGetCommand(cardsCmd);
    await cardsCmd.parseAsync(['node', 'cards', 'get', 'card-abc', '--include', 'board,collection,links']);

    expect(mockGetCard).toHaveBeenCalledWith('card-abc', {
      include: ['board', 'collection', 'links'],
    });
  });

  // --- Error handling ---

  test('exits with error on invalid include value', async () => {
    buildMockApi();
    const cardsCmd = buildCards();
    registerCardsGetCommand(cardsCmd);

    await cardsCmd.parseAsync(['node', 'cards', 'get', 'card-abc', '--include', 'invalid-field', '--human']);
    expect(process.exitCode).toBe(1);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid include value'));
      });

  test('shows card not found error on 404', async () => {
    const err = Object.assign(new Error('Not Found'), { response: { status: 404 } });
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => ({
      getCard: jest.fn().mockRejectedValue(err),
    } as any));
    (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({} as any));

    const cardsCmd = buildCards();
    registerCardsGetCommand(cardsCmd);

    await cardsCmd.parseAsync(['node', 'cards', 'get', 'bad-card-id', '--human']);
    expect(process.exitCode).toBe(1);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Card 'bad-card-id' not found"));
      });

  test('exits with error when API key missing', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(undefined);
    buildMockApi();

    const cardsCmd = buildCards();
    registerCardsGetCommand(cardsCmd);

    await cardsCmd.parseAsync(['node', 'cards', 'get', 'card-abc', '--human']);
    expect(process.exitCode).toBe(1);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API key not found'));
      });

  test('handles general API errors', async () => {
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => ({
      getCard: jest.fn().mockRejectedValue(new Error('Network timeout')),
    } as any));
    (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({} as any));

    const cardsCmd = buildCards();
    registerCardsGetCommand(cardsCmd);

    await cardsCmd.parseAsync(['node', 'cards', 'get', 'card-abc', '--human']);
    expect(process.exitCode).toBe(1);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Network timeout'));
      });

  // CLA-1785 critic fix: null guard for card.name
  test('handles null card.name without crashing (null guard fix)', async () => {
    const cardWithNullName = { ...sampleCard, name: null as any };
    buildMockApi(cardWithNullName);

    const cardsCmd = buildCards();
    registerCardsGetCommand(cardsCmd);

    // Should NOT throw — null name should be handled gracefully
    await cardsCmd.parseAsync(['node', 'cards', 'get', 'card-abc', '--human']);

    // Table should have been called with em-dash fallback
    expect(tableSpy).toHaveBeenCalled();
    const tableArg = tableSpy.mock.calls[0][0];
    expect(tableArg[0].Title).toBe('—');
    expect(process.exitCode).toBeUndefined();
  });

  test('handles undefined card.name without crashing', async () => {
    const cardWithUndefinedName = { ...sampleCard, name: undefined as any };
    buildMockApi(cardWithUndefinedName);

    const cardsCmd = buildCards();
    registerCardsGetCommand(cardsCmd);

    await cardsCmd.parseAsync(['node', 'cards', 'get', 'card-abc', '--human']);

    expect(tableSpy).toHaveBeenCalled();
    const tableArg = tableSpy.mock.calls[0][0];
    expect(tableArg[0].Title).toBe('—');
    expect(process.exitCode).toBeUndefined();
  });
});
