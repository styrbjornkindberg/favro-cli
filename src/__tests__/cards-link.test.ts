/**
 * Unit tests for cards-link / cards-unlink / cards-move / cards-show /
 * cards-dependencies / cards-blocking / cards-blocked-by commands
 * CLA-1786 (FAVRO-024): Card Relationship Operations
 */
import { registerCardsLinkCommands, VALID_LINK_TYPES } from '../commands/cards-link';
import { LINK_TYPES, linkTypeToIsBefore } from '../lib/dependency-direction';
import { Command } from 'commander';
import * as os from 'os';
import * as path from 'path';
import * as fsSync from 'fs';
import CardsAPI, { Card, CardLink } from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';
import * as config from '../lib/config';

jest.mock('../lib/cards-api');
jest.mock('../lib/http-client');
jest.mock('../lib/config');

const sampleLink: CardLink = {
  cardId: 'card-target',
  isBefore: true,
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

  const originalConfigDir = process.env.FAVRO_CONFIG_DIR;

  beforeEach(() => {
    jest.clearAllMocks();
    // `resolveBoardId` writes a real name cache — give the suite a throwaway
    // dir so a run never reads or clobbers the developer's own ~/.favro.
    process.env.FAVRO_CONFIG_DIR = fsSync.mkdtempSync(path.join(os.tmpdir(), 'favro-cards-link-test-'));
    (config.resolveApiKey as jest.Mock).mockResolvedValue('test-key');
    // `clearAllMocks` clears calls, not implementations — without this the one
    // scope-locked test below leaks its lock into every test after it.
    (config.readConfig as jest.Mock).mockResolvedValue(undefined);
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.FAVRO_CONFIG_DIR;
    else process.env.FAVRO_CONFIG_DIR = originalConfigDir;
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // ─── Registration ──────────────────────────────────────────────────────────

  test('registers link, unlink, move, show, dependencies, blocking, blocked-by subcommands', () => {
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    const subNames = cardsCmd.commands.map(c => c.name());
    expect(subNames).toContain('link');
    expect(subNames).toContain('unlink');
    expect(subNames).toContain('move');
    expect(subNames).toContain('show');
    expect(subNames).toContain('dependencies');
    // Renamed from `blockers` (#47): it returns what this card BLOCKS.
    expect(subNames).toContain('blocking');
    expect(subNames).not.toContain('blockers');
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

  test('VALID_LINK_TYPES is the two directions Favro can store', () => {
    expect(VALID_LINK_TYPES).toEqual(['depends-on', 'blocks']);
    expect(VALID_LINK_TYPES).not.toContain('depends');
    // 'related' and 'duplicates' have no Favro representation (issue #12).
    expect(VALID_LINK_TYPES).not.toContain('related');
    expect(VALID_LINK_TYPES).not.toContain('duplicates');
  });

  /**
   * The vocabulary is CLOSED, and the translator honours the same closure
   * (#120 item 3).
   *
   * `linkTypeToIsBefore` used to accept a third token, `blocked-by`, that
   * `LINK_TYPES` never published. It mapped to the right direction, so it never
   * gave a wrong answer — but `cards link` validates against `LINK_TYPES` and
   * refused it while `dependencies add` passed it straight to the translator
   * and accepted it. One `--type` flag, two accepted sets, and the wider one
   * was the one nobody had written down.
   *
   * What this file can and cannot hold, said plainly, because the first version
   * of this test got it wrong: it looped over `LINK_TYPES` asserting only that
   * the result was a boolean, which passes for a WRONG DIRECTION, and left the
   * real weight on the two hardcoded lines — the repeat-the-list pattern #120
   * exists to delete. So the direction is asserted per label BY NAME here (a
   * backwards edge is a data-corrupting bug and deserves a literal), while
   * EXHAUSTIVENESS over `LINK_TYPES` is the compiler's job: `IS_BEFORE` is a
   * `Record` keyed on the tuple, so a new label with no direction is TS2741.
   * A test cannot check that; a type can.
   */
  test('linkTypeToIsBefore maps each published label to its own direction', () => {
    expect(linkTypeToIsBefore('depends-on')).toBe(true);
    expect(linkTypeToIsBefore('blocks')).toBe(false);
    // Not a spelling of the two above: the labels disagree, so neither line can
    // be passing by accident on a constant.
    expect(linkTypeToIsBefore('depends-on')).not.toBe(linkTypeToIsBefore('blocks'));
    // Every published label is covered by name — this fails the moment one is
    // added, which is the nudge to decide its direction here too.
    expect([...LINK_TYPES].sort()).toEqual(['blocks', 'depends-on']);
  });

  test('linkTypeToIsBefore refuses every label LINK_TYPES does not publish', () => {
    for (const undeclared of ['blocked-by', 'related', 'duplicates', 'depends', 'precedes']) {
      expect(LINK_TYPES).not.toContain(undeclared);
      expect(() => linkTypeToIsBefore(undeclared)).toThrow(/cannot be stored in Favro/);
    }
  });

  // ─── cards link ─────────────────────────────────────────────────────────────

  // The eight API-asserting tests that lived here asserted `api.linkCard` / `api.unlinkCard`
  // were called with a shape we chose. `cards link` and `cards unlink` now route
  // through the shared dispatch table (#63), so those assertions were pinning
  // the weaker path they replaced — and a mocked `CardsAPI` cannot see the thing
  // that actually changed: whether the reverse-edge write reaches Favro at all.
  // They are replaced by `cli-cards-intents-wire.test.ts`, which drives the same
  // commands over a `node:http` Favro stand-in and reads the wire.
  //
  // What stays here is what commander parsing alone decides: registration, type
  // validation, self-link, and the missing-key path.

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

  // ─── cards move ─────────────────────────────────────────────────────────────

  /**
   * The ✓ names the OBSERVED board. `moveCard` runs its PUT body through
   * `normalizeCard`, so `card.boardId` is the echoed `widgetCommonId` — the same
   * field `widgets add` spends its ✓ on, from the same PUT. The old assertion
   * pinned `✓ Card card-src moved to board board-2`, where `board-2` was the
   * ARGUMENT: it read identically whether the move landed or Favro 200'd and
   * wrote nothing.
   */
  test('moves card to target board and reports the observed board', async () => {
    const { mockMoveCard } = buildMockApi({
      moveCard: jest.fn().mockResolvedValue({ ...sampleCard, boardId: 'board-2' }),
    });
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    await cardsCmd.parseAsync(['node', 'cards', 'move', 'card-src', '--to-board', 'board-2']);

    expect(mockMoveCard).toHaveBeenCalledWith('card-src', { toBoardId: 'board-2', position: undefined });
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('✓ Card card-src moved to board (board-2)'),
    );
  });

  /**
   * No echo, no ✓, and exit 1 — a hole forbids a clean exit code (#148), and
   * `favro cards move … && next-step` reads the code, not the prose.
   */
  test('an unobserved board prints UNCONFIRMED and exits 1', async () => {
    buildMockApi({
      moveCard: jest.fn().mockResolvedValue({ ...sampleCard, boardId: undefined }),
    });
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);

    await expect(
      cardsCmd.parseAsync(['node', 'cards', 'move', 'card-src', '--to-board', 'board-2']),
    ).rejects.toThrow('process.exit');

    const printed = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).not.toMatch(/✓/);
    expect(printed).toContain('UNCONFIRMED');
    expect(printed).toContain('carried no widgetCommonId');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  /**
   * `--to-board` advertises "by name or boardId", and for a scope-LOCKED user
   * the first thing that touches the value is the lock, not `moveCard` (#82).
   * The lock GETs `/widgets/<id>`; handed the name it 404s and prints "Scope
   * check failed: Board Backlog - Web Hub not found" — #82's own complaint,
   * reintroduced at a new seam, and `--force` does not rescue it because the
   * 404 happens before the force branch is reached.
   *
   * Nothing here is stubbed between the flag and the URL: `BoardsAPI`,
   * `checkResolvedScope` and `assertScope` are all real, and the assertion is
   * on the path the client was actually asked for.
   */
  test('a scope-locked user can pass a board NAME to --to-board (#82)', async () => {
    const HUB_ID = 'w-hub-0001';
    const HUB_NAME = 'Backlog - Web Hub';
    const { mockMoveCard } = buildMockApi();

    const requested: string[] = [];
    const notFound = () => {
      const err: any = new Error('Request failed with status code 404');
      err.response = { status: 404 };
      return err;
    };
    (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({
      organizationId: 'org-1',
      get: jest.fn(async (url: string) => {
        requested.push(url);
        if (url === '/widgets') {
          return { entities: [{ widgetCommonId: HUB_ID, name: HUB_NAME, collectionIds: ['coll-1'] }] };
        }
        // The origin board and the settled destination are both in the lock.
        if (url === `/widgets/${HUB_ID}` || url === '/widgets/board-2') {
          return { name: HUB_NAME, collectionIds: ['coll-1'] };
        }
        // Anything else under /widgets/ is an unsettled reference on the wire.
        throw notFound();
      }),
    } as any));
    (config.readConfig as jest.Mock).mockResolvedValue({
      scopeCollectionId: 'coll-1',
      scopeCollectionName: 'Locked',
    });

    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    await cardsCmd.parseAsync(['node', 'cards', 'move', 'card-src', '--to-board', HUB_NAME, '-y']);

    expect(requested).toContain(`/widgets/${HUB_ID}`);
    expect(requested.filter((u) => u.includes(HUB_NAME))).toEqual([]);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockMoveCard).toHaveBeenCalledWith('card-src', { toBoardId: HUB_NAME, position: undefined });
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
      { cardId: 'dep-card-1', isBefore: true },
      { cardId: 'blocks-card-1', isBefore: false },
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
      { cardId: 'dep-card-1', isBefore: true },
    ];
    buildMockApi({ getCardLinks: jest.fn().mockResolvedValue(links) });
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    await cardsCmd.parseAsync(['node', 'cards', 'dependencies', 'card-src', '--json']);

    const calls = consoleSpy.mock.calls.map(c => c[0] as string);
    const jsonCall = calls.find(c => c?.includes('"isBefore"'));
    expect(jsonCall).toBeDefined();
  });

  // ─── cards blocking ─────────────────────────────────────────────────────────

  test('lists cards blocked by this card (blocks links)', async () => {
    const links: CardLink[] = [
      { cardId: 'blocked-card-1', isBefore: false },
      { cardId: 'dep-card', isBefore: true },
    ];
    buildMockApi({ getCardLinks: jest.fn().mockResolvedValue(links) });
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    await cardsCmd.parseAsync(['node', 'cards', 'blocking', 'card-src']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('blocked-card-1'));
    const calls = consoleSpy.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c?.includes('dep-card'))).toBe(false);
  });

  test('shows empty message when blocking nothing', async () => {
    buildMockApi({ getCardLinks: jest.fn().mockResolvedValue([]) });
    const cardsCmd = new Command('cards');
    registerCardsLinkCommands(cardsCmd);
    await cardsCmd.parseAsync(['node', 'cards', 'blocking', 'card-src']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('not blocking'));
  });

  // ─── cards blocked-by ───────────────────────────────────────────────────────

  test('lists cards that are blocking this card (depends-on as blocked-by)', async () => {
    const links: CardLink[] = [
      { cardId: 'blocker-card-1', isBefore: true },
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
      cardsCmd.parseAsync(['node', 'cards', 'link', 'card-src', 'target', '--type', 'depends-on'])
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
