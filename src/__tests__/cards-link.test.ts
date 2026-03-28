/**
 * Unit tests for cards-link / cards-unlink / cards-move / cards-show /
 * cards-dependencies / cards-blockers / cards-blocked-by commands
 * CLA-1786 (FAVRO-024): Card Relationship Operations
 */
import { registerCardsLinkCommands, VALID_LINK_TYPES } from '../commands/cards-link';
import { Command } from 'commander';
import CardsAPI, { Card, CardLink } from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';
import * as config from '../lib/config';

jest.mock('../lib/cards-api');
jest.mock('../lib/http-client');
jest.mock('../lib/config');

const sampleLink: CardLink = {
  linkId: 'lnk-001',
  type: 'depends-on',
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
  getCard: jest.Mock;
  getCardLinks: jest.Mock;
}> = {}) {
  const mockLinkCard = overrides.linkCard ?? jest.fn().mockResolvedValue(sampleLink);
  const mockUnlinkCard = overrides.unlinkCard ?? jest.fn().mockResolvedValue(undefined);
  const mockMoveCard = overrides.moveCard ?? jest.fn().mockResolvedValue(sampleCard);
  const mockGetCard = overrides.getCard ?? jest.fn().mockResolvedValue(sampleCard);
  const mockGetCardLinks = overrides.getCardLinks ?? jest.fn().mockResolvedValue([]);

  (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => ({
    getCard: mockGetCard,
    getCardLinks: mockGetCardLinks,
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
  return { mockLinkCard, mockUnlinkCard, mockMoveCard, mockGetCard, mockGetCardLinks };
}

describe('Cards Link/Unlink/Move/Show/Dependencies/Blockers/BlockedBy Commands', () => {
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

  test('registers link, unlink, move, show, dependencies, blockers, blocked-by subcommands', () => {
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    const subNames = cardsCmd.commands.map(c => c.name());
    expect(subNames).toContain('link');
    expect(subNames).toContain('unlink');
    expect(subNames).toContain('move');
    expect(subNames).toContain('show');
    expect(subNames).toContain('dependencies');
    expect(subNames).toContain('blockers');
    expect(subNames).toContain('blocked-by');
  });

  test('link command has --type and --json options (no --to)', () => {
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    const linkCmd = cardsCmd.commands.find(c => c.name() === 'link')!;
    const optNames = linkCmd.options.map(o => o.long);
    expect(optNames).not.toContain('--to');
    expect(optNames).toContain('--type');
    expect(optNames).toContain('--json');
  });

  test('unlink command uses positional args (no --from option)', () => {
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    const unlinkCmd = cardsCmd.commands.find(c => c.name() === 'unlink')!;
    const optNames = unlinkCmd.options.map(o => o.long);
    expect(optNames).not.toContain('--from');
  });

  test('move command has --to-board and --position options', () => {
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    const moveCmd = cardsCmd.commands.find(c => c.name() === 'move')!;
    const optNames = moveCmd.options.map(o => o.long);
    expect(optNames).toContain('--to-board');
    expect(optNames).toContain('--position');
  });

  test('show command has --relationships and --json options', () => {
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    const showCmd = cardsCmd.commands.find(c => c.name() === 'show')!;
    const optNames = showCmd.options.map(o => o.long);
    expect(optNames).toContain('--relationships');
    expect(optNames).toContain('--json');
  });

  // ─── VALID_LINK_TYPES ──────────────────────────────────────────────────────

  test('VALID_LINK_TYPES matches spec (depends-on, blocks, related, duplicates)', () => {
    expect(VALID_LINK_TYPES).toEqual(expect.arrayContaining(['depends-on', 'blocks', 'related', 'duplicates']));
    expect(VALID_LINK_TYPES).not.toContain('depends');
    expect(VALID_LINK_TYPES).not.toContain('relates');
  });

  // ─── cards link ─────────────────────────────────────────────────────────────

  test('links card with two positional args and --type depends-on', async () => {
    const { mockLinkCard } = buildMockApi();
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    await cardsCmd.parseAsync(['node', 'cards', 'link', 'card-src', 'card-target', '--type', 'depends-on']);

    expect(mockLinkCard).toHaveBeenCalledWith('card-src', { toCardId: 'card-target', type: 'depends-on' });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('✓ Linked'));
  });

  test('all valid link types are accepted (spec names)', async () => {
    const validTypes = ['depends-on', 'blocks', 'related', 'duplicates'];
    for (const type of validTypes) {
      const { mockLinkCard } = buildMockApi();
      const cardsCmd = new Command('cards');
      registerCardsLinkCommands(cardsCmd);
      await cardsCmd.parseAsync(['node', 'cards', 'link', 'card-src', 'card-target', '--type', type]);
      expect(mockLinkCard).toHaveBeenCalledWith('card-src', { toCardId: 'card-target', type });
      jest.clearAllMocks();
      (config.resolveApiKey as jest.Mock).mockResolvedValue('test-key');
    }
  });

  test('exits with error on old type name "depends"', async () => {
    buildMockApi();
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);

    await expect(
      cardsCmd.parseAsync(['node', 'cards', 'link', 'card-src', 'target', '--type', 'depends'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid link type"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('exits with error on old type name "relates"', async () => {
    buildMockApi();
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);

    await expect(
      cardsCmd.parseAsync(['node', 'cards', 'link', 'card-src', 'target', '--type', 'relates'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid link type"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('exits with error on completely invalid link type', async () => {
    buildMockApi();
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);

    await expect(
      cardsCmd.parseAsync(['node', 'cards', 'link', 'card-src', 'target', '--type', 'invalid-type'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid link type"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // ─── Self-link prevention ──────────────────────────────────────────────────

  test('prevents self-linking a card to itself', async () => {
    buildMockApi();
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);

    await expect(
      cardsCmd.parseAsync(['node', 'cards', 'link', 'CARD-A', 'CARD-A', '--type', 'depends-on'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Cannot link a card to itself"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('allows linking different cards', async () => {
    const { mockLinkCard } = buildMockApi();
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);

    await cardsCmd.parseAsync(['node', 'cards', 'link', 'CARD-A', 'CARD-B', '--type', 'depends-on']);
    expect(mockLinkCard).toHaveBeenCalled();
  });

  // ─── Circular dependency detection ─────────────────────────────────────────

  test('detects circular dependency and rejects link', async () => {
    // A depends-on B, and B depends-on A would be a cycle
    // We're linking B → A (depends-on), and A already depends-on B
    const mockLinks: CardLink[] = [
      { linkId: 'lnk-1', type: 'depends-on', cardId: 'card-b' }  // A depends-on B
    ];
    const mockGetCardLinks = jest.fn().mockResolvedValue(mockLinks);
    buildMockApi({ getCardLinks: mockGetCardLinks });

    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);

    // Trying to link B → A (depends-on) when A already depends-on B
    await expect(
      cardsCmd.parseAsync(['node', 'cards', 'link', 'card-b', 'card-a', '--type', 'depends-on'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("circular dependency"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('circular detection skips non-depends-on link types', async () => {
    // 'blocks' type should NOT trigger circular detection
    const { mockLinkCard } = buildMockApi({ getCardLinks: jest.fn().mockResolvedValue([]) });
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);

    await cardsCmd.parseAsync(['node', 'cards', 'link', 'card-a', 'card-b', '--type', 'blocks']);
    expect(mockLinkCard).toHaveBeenCalled();
  });

  // ─── JSON output ──────────────────────────────────────────────────────────

  test('outputs link JSON when --json flag set', async () => {
    buildMockApi();
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    await cardsCmd.parseAsync(['node', 'cards', 'link', 'card-src', 'card-target', '--type', 'related', '--json']);

    const calls = consoleSpy.mock.calls.map(c => c[0]);
    const jsonCall = calls.find(c => typeof c === 'string' && c.includes('"linkId"'));
    expect(jsonCall).toBeDefined();
  });

  // ─── 404 handling ─────────────────────────────────────────────────────────

  test('handles 404 on link gracefully', async () => {
    const err = Object.assign(new Error('Not Found'), { response: { status: 404 } });
    buildMockApi({ linkCard: jest.fn().mockRejectedValue(err) });
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);

    await expect(
      cardsCmd.parseAsync(['node', 'cards', 'link', 'bad-card', 'bad-target', '--type', 'related'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("not found"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // ─── cards unlink ───────────────────────────────────────────────────────────

  test('unlinks card with two positional args', async () => {
    const { mockUnlinkCard } = buildMockApi();
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    await cardsCmd.parseAsync(['node', 'cards', 'unlink', 'card-src', 'card-linked']);

    expect(mockUnlinkCard).toHaveBeenCalledWith('card-src', 'card-linked');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('✓ Unlinked'));
  });

  test('handles 404 on unlink gracefully', async () => {
    const err = Object.assign(new Error('Not Found'), { response: { status: 404 } });
    buildMockApi({ unlinkCard: jest.fn().mockRejectedValue(err) });
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);

    await expect(
      cardsCmd.parseAsync(['node', 'cards', 'unlink', 'bad-card', 'no-link'])
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

  // ─── cards show ─────────────────────────────────────────────────────────────

  test('shows card with --relationships flag as JSON', async () => {
    const cardWithLinks = { ...sampleCard, links: [sampleLink] };
    buildMockApi({ getCard: jest.fn().mockResolvedValue(cardWithLinks) });
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    await cardsCmd.parseAsync(['node', 'cards', 'show', 'card-src', '--relationships']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"cardId"'));
  });

  test('shows card as table without --relationships', async () => {
    buildMockApi();
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    await cardsCmd.parseAsync(['node', 'cards', 'show', 'card-src']);

    // console.table is called
    const tableSpyCalls = consoleSpy.mock.calls;
    expect(tableSpyCalls.length).toBeGreaterThan(0);
  });

  test('handles 404 on show gracefully', async () => {
    const err = Object.assign(new Error('Not Found'), { response: { status: 404 } });
    buildMockApi({ getCard: jest.fn().mockRejectedValue(err) });
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);

    await expect(
      cardsCmd.parseAsync(['node', 'cards', 'show', 'bad-id'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("not found"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // ─── cards dependencies ─────────────────────────────────────────────────────

  test('lists dependencies (depends-on links)', async () => {
    const links: CardLink[] = [
      { linkId: 'lnk-1', type: 'depends-on', cardId: 'dep-card-1' },
      { linkId: 'lnk-2', type: 'blocks', cardId: 'blocks-card-1' },
    ];
    buildMockApi({ getCardLinks: jest.fn().mockResolvedValue(links) });
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    await cardsCmd.parseAsync(['node', 'cards', 'dependencies', 'card-src']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('dep-card-1'));
    const calls = consoleSpy.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c?.includes('blocks-card-1'))).toBe(false);
  });

  test('shows empty message when no dependencies', async () => {
    buildMockApi({ getCardLinks: jest.fn().mockResolvedValue([]) });
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    await cardsCmd.parseAsync(['node', 'cards', 'dependencies', 'card-src']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('no dependencies'));
  });

  test('outputs dependencies as JSON with --json', async () => {
    const links: CardLink[] = [
      { linkId: 'lnk-1', type: 'depends-on', cardId: 'dep-card-1' },
    ];
    buildMockApi({ getCardLinks: jest.fn().mockResolvedValue(links) });
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    await cardsCmd.parseAsync(['node', 'cards', 'dependencies', 'card-src', '--json']);

    const calls = consoleSpy.mock.calls.map(c => c[0] as string);
    const jsonCall = calls.find(c => c?.includes('"depends-on"'));
    expect(jsonCall).toBeDefined();
  });

  // ─── cards blockers ─────────────────────────────────────────────────────────

  test('lists cards blocked by this card (blocks links)', async () => {
    const links: CardLink[] = [
      { linkId: 'lnk-1', type: 'blocks', cardId: 'blocked-card-1' },
      { linkId: 'lnk-2', type: 'depends-on', cardId: 'dep-card' },
    ];
    buildMockApi({ getCardLinks: jest.fn().mockResolvedValue(links) });
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    await cardsCmd.parseAsync(['node', 'cards', 'blockers', 'card-src']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('blocked-card-1'));
    const calls = consoleSpy.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c?.includes('dep-card'))).toBe(false);
  });

  test('shows empty message when blocking nothing', async () => {
    buildMockApi({ getCardLinks: jest.fn().mockResolvedValue([]) });
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    await cardsCmd.parseAsync(['node', 'cards', 'blockers', 'card-src']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('not blocking'));
  });

  // ─── cards blocked-by ───────────────────────────────────────────────────────

  test('lists cards that are blocking this card (depends-on as blocked-by)', async () => {
    const links: CardLink[] = [
      { linkId: 'lnk-1', type: 'depends-on', cardId: 'blocker-card-1' },
    ];
    buildMockApi({ getCardLinks: jest.fn().mockResolvedValue(links) });
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    await cardsCmd.parseAsync(['node', 'cards', 'blocked-by', 'card-src']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('blocker-card-1'));
  });

  test('shows empty message when not blocked by any card', async () => {
    buildMockApi({ getCardLinks: jest.fn().mockResolvedValue([]) });
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    await cardsCmd.parseAsync(['node', 'cards', 'blocked-by', 'card-src']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('not blocked'));
  });

  // ─── Missing API key ────────────────────────────────────────────────────────

  test('exits when API key missing (link)', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(undefined);
    buildMockApi();
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);

    await expect(
      cardsCmd.parseAsync(['node', 'cards', 'link', 'card-src', 'target', '--type', 'related'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API key not found'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('exits when API key missing (unlink)', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(undefined);
    buildMockApi();
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);

    await expect(
      cardsCmd.parseAsync(['node', 'cards', 'unlink', 'card-src', 'target'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API key not found'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('exits when API key missing (move)', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(undefined);
    buildMockApi();
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);

    await expect(
      cardsCmd.parseAsync(['node', 'cards', 'move', 'card-src', '--to-board', 'board-2'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API key not found'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('exits when API key missing (show)', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(undefined);
    buildMockApi();
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);

    await expect(
      cardsCmd.parseAsync(['node', 'cards', 'show', 'card-src'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API key not found'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('exits when API key missing (dependencies)', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(undefined);
    buildMockApi();
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);

    await expect(
      cardsCmd.parseAsync(['node', 'cards', 'dependencies', 'card-src'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API key not found'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
