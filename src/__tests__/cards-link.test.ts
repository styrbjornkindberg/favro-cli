/**
 * Unit tests for cards-link / cards-unlink / cards-move commands
 * CLA-1785 (FAVRO-023): Advanced Cards Endpoints
 */
import { registerCardsLinkCommands } from '../commands/cards-link';
import { Command } from 'commander';
import CardsAPI, { Card, CardLink } from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';
import * as config from '../lib/config';

jest.mock('../lib/cards-api');
jest.mock('../lib/http-client');
jest.mock('../lib/config');

const sampleLink: CardLink = {
  linkId: 'lnk-001',
  type: 'depends',
  cardId: 'card-target',
};

const sampleCard: Card = {
  cardId: 'card-src',
  name: 'Source Card',
  createdAt: '2026-01-01T00:00:00Z',
  boardId: 'board-2',
};

function buildMockApi(overrides: Partial<{
  linkCard: jest.Mock;
  unlinkCard: jest.Mock;
  moveCard: jest.Mock;
}> = {}) {
  const mockLinkCard = overrides.linkCard ?? jest.fn().mockResolvedValue(sampleLink);
  const mockUnlinkCard = overrides.unlinkCard ?? jest.fn().mockResolvedValue(undefined);
  const mockMoveCard = overrides.moveCard ?? jest.fn().mockResolvedValue(sampleCard);

  (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => ({
    getCard: jest.fn(),
    listCards: jest.fn(),
    createCard: jest.fn(),
    createCards: jest.fn(),
    updateCard: jest.fn(),
    deleteCard: jest.fn(),
    searchCards: jest.fn(),
    linkCard: mockLinkCard,
    unlinkCard: mockUnlinkCard,
    moveCard: mockMoveCard,
  } as any));
  (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({} as any));
  return { mockLinkCard, mockUnlinkCard, mockMoveCard };
}

describe('Cards Link/Unlink/Move Commands', () => {
  let consoleSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    (config.resolveApiKey as jest.Mock).mockResolvedValue('test-key');
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // ─── Registration ──────────────────────────────────────────────────────────

  test('registers link, unlink, move subcommands', () => {
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    const subNames = cardsCmd.commands.map(c => c.name());
    expect(subNames).toContain('link');
    expect(subNames).toContain('unlink');
    expect(subNames).toContain('move');
  });

  test('link command has --to and --type options', () => {
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    const linkCmd = cardsCmd.commands.find(c => c.name() === 'link')!;
    const optNames = linkCmd.options.map(o => o.long);
    expect(optNames).toContain('--to');
    expect(optNames).toContain('--type');
    expect(optNames).toContain('--json');
  });

  test('unlink command has --from option', () => {
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    const unlinkCmd = cardsCmd.commands.find(c => c.name() === 'unlink')!;
    expect(unlinkCmd.options.map(o => o.long)).toContain('--from');
  });

  test('move command has --to-board and --position options', () => {
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    const moveCmd = cardsCmd.commands.find(c => c.name() === 'move')!;
    const optNames = moveCmd.options.map(o => o.long);
    expect(optNames).toContain('--to-board');
    expect(optNames).toContain('--position');
  });

  // ─── cards link ─────────────────────────────────────────────────────────────

  test('links card with specified type', async () => {
    const { mockLinkCard } = buildMockApi();
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    await cardsCmd.parseAsync(['node', 'cards', 'link', 'card-src', '--to', 'card-target', '--type', 'depends']);

    expect(mockLinkCard).toHaveBeenCalledWith('card-src', { toCardId: 'card-target', type: 'depends' });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('✓ Linked'));
  });

  test('all valid link types are accepted', async () => {
    const validTypes = ['depends', 'blocks', 'duplicates', 'relates'];
    for (const type of validTypes) {
      const { mockLinkCard } = buildMockApi();
      const cardsCmd = new Command('cards');
      registerCardsLinkCommands(cardsCmd);
      await cardsCmd.parseAsync(['node', 'cards', 'link', 'card-src', '--to', 'card-target', '--type', type]);
      expect(mockLinkCard).toHaveBeenCalledWith('card-src', { toCardId: 'card-target', type });
      jest.clearAllMocks();
    }
  });

  test('exits with error on invalid link type', async () => {
    buildMockApi();
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);

    await expect(
      cardsCmd.parseAsync(['node', 'cards', 'link', 'card-src', '--to', 'target', '--type', 'invalid-type'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid link type"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('outputs link JSON when --json flag set', async () => {
    buildMockApi();
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    await cardsCmd.parseAsync(['node', 'cards', 'link', 'card-src', '--to', 'card-target', '--type', 'relates', '--json']);

    const calls = consoleSpy.mock.calls.map(c => c[0]);
    const jsonCall = calls.find(c => typeof c === 'string' && c.includes('"linkId"'));
    expect(jsonCall).toBeDefined();
  });

  test('handles 404 on link gracefully', async () => {
    const err = Object.assign(new Error('Not Found'), { response: { status: 404 } });
    buildMockApi({ linkCard: jest.fn().mockRejectedValue(err) });
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);

    await expect(
      cardsCmd.parseAsync(['node', 'cards', 'link', 'bad-card', '--to', 'bad-target', '--type', 'relates'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("not found"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // ─── cards unlink ───────────────────────────────────────────────────────────

  test('unlinks card from another card', async () => {
    const { mockUnlinkCard } = buildMockApi();
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    await cardsCmd.parseAsync(['node', 'cards', 'unlink', 'card-src', '--from', 'card-linked']);

    expect(mockUnlinkCard).toHaveBeenCalledWith('card-src', 'card-linked');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('✓ Unlinked'));
  });

  test('handles 404 on unlink gracefully', async () => {
    const err = Object.assign(new Error('Not Found'), { response: { status: 404 } });
    buildMockApi({ unlinkCard: jest.fn().mockRejectedValue(err) });
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);

    await expect(
      cardsCmd.parseAsync(['node', 'cards', 'unlink', 'bad-card', '--from', 'no-link'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("not found"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // ─── cards move ─────────────────────────────────────────────────────────────

  test('moves card to target board', async () => {
    const { mockMoveCard } = buildMockApi();
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    await cardsCmd.parseAsync(['node', 'cards', 'move', 'card-src', '--to-board', 'board-2']);

    expect(mockMoveCard).toHaveBeenCalledWith('card-src', { toBoardId: 'board-2', position: undefined });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('✓ Card card-src moved'));
  });

  test('moves card to target board with position top', async () => {
    const { mockMoveCard } = buildMockApi();
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    await cardsCmd.parseAsync(['node', 'cards', 'move', 'card-src', '--to-board', 'board-2', '--position', 'top']);

    expect(mockMoveCard).toHaveBeenCalledWith('card-src', { toBoardId: 'board-2', position: 'top' });
  });

  test('moves card to target board with position bottom', async () => {
    const { mockMoveCard } = buildMockApi();
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    await cardsCmd.parseAsync(['node', 'cards', 'move', 'card-src', '--to-board', 'board-2', '--position', 'bottom']);

    expect(mockMoveCard).toHaveBeenCalledWith('card-src', { toBoardId: 'board-2', position: 'bottom' });
  });

  test('exits with error on invalid position', async () => {
    buildMockApi();
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);

    await expect(
      cardsCmd.parseAsync(['node', 'cards', 'move', 'card-src', '--to-board', 'board-2', '--position', 'middle'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid position"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('outputs moved card JSON when --json flag set', async () => {
    buildMockApi();
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    await cardsCmd.parseAsync(['node', 'cards', 'move', 'card-src', '--to-board', 'board-2', '--json']);

    const calls = consoleSpy.mock.calls.map(c => c[0]);
    const jsonCall = calls.find(c => typeof c === 'string' && c.includes('"cardId"'));
    expect(jsonCall).toBeDefined();
  });

  test('handles 404 on move gracefully', async () => {
    const err = Object.assign(new Error('Not Found'), { response: { status: 404 } });
    buildMockApi({ moveCard: jest.fn().mockRejectedValue(err) });
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);

    await expect(
      cardsCmd.parseAsync(['node', 'cards', 'move', 'bad-card', '--to-board', 'bad-board'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("not found"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // ─── Missing API key ────────────────────────────────────────────────────────

  test('exits when API key missing (link)', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(undefined);
    buildMockApi();
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);

    await expect(
      cardsCmd.parseAsync(['node', 'cards', 'link', 'card-src', '--to', 'target', '--type', 'relates'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API key not found'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
