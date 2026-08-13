/**
 * Unit tests — dependencies add/delete/delete-all CLI commands
 *
 * All three are routed through the shared dispatch table since #109 — the same
 * `add-blocking-edge` / `remove-blocking-edge` intents `cards link` / `cards
 * unlink` use, plus `clear-blocking-edges` for the wipe. So the lock they take is
 * the table's `assertScope`, and the writes they make go through `TxCards`, which
 * PRE-READS the edge set before touching it. The stand below has to answer
 * `getCardLinks` for that reason: an intent that cannot see the edges cannot
 * decide whether there is anything to write.
 */
import { Command } from 'commander';
import { registerDependenciesCommands } from '../../commands/dependencies';
import * as config from '../../lib/config';
import * as safety from '../../lib/safety';
import CardsAPI from '../../lib/cards-api';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../lib/safety');
jest.mock('../../lib/cards-api');

const MockCardsAPI = CardsAPI as jest.MockedClass<typeof CardsAPI>;

function buildProgram(): Command {
  const program = new Command();
  program.option('--verbose', 'Show stack traces');
  registerDependenciesCommands(program);
  return program;
}

async function runCli(args: string[]): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  await program.parseAsync(['node', 'favro', ...args]);
}

beforeEach(() => {
  jest.clearAllMocks();
  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  (config.readConfig as jest.Mock).mockResolvedValue({});
  (safety.checkScope as jest.Mock).mockResolvedValue(undefined);
  // Reset per arm: `clearAllMocks` clears calls, not implementations, so an arm
  // that makes the lock reject would leak into every arm after it.
  (safety.assertScope as jest.Mock).mockResolvedValue(undefined);
  (safety.confirmAction as jest.Mock).mockResolvedValue(true);
  MockCardsAPI.prototype.getCard = jest.fn().mockResolvedValue({ cardId: 'card-1', boardId: 'board-1' });
  MockCardsAPI.prototype.resolveCardId = jest.fn(async (ref: string) => ref);
  // No edges, unless an arm says otherwise.
  MockCardsAPI.prototype.getCardLinks = jest.fn().mockResolvedValue([]);
});

/**
 * The fourth site of the argument-echo family (`widgets add`, `custom-fields
 * set`, `cards move` are the other three). `✓ Dependency added: A -> B (blocks)`
 * was built from the three ARGUMENTS while `linkCard`'s returned edge set — the
 * server's own answer — was discarded.
 *
 * Routing settles it differently and better: the intent PRE-READS the pair, so
 * "created" and "already there" are decided by an observation of the edge rather
 * than by whether a response echoed anything.
 */
describe('favro dependencies add', () => {
  let consoleSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => { jest.restoreAllMocks(); });

  it('writes the edge and spends the ✓ on it', async () => {
    MockCardsAPI.prototype.linkCard = jest.fn().mockResolvedValue([{ cardId: 'card-2', isBefore: true }]);

    await runCli(['dependencies', 'add', 'card-1', 'card-2', '--type', 'blocks', '--yes']);

    // `blocks` means card-1 comes BEFORE card-2, so the edge is recorded on
    // card-2 with card-1 as its blocker — the arguments swap.
    expect(MockCardsAPI.prototype.linkCard).toHaveBeenCalledWith('card-2', { toCardId: 'card-1', isBefore: true });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('✓ Dependency added'));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('an edge already there is reported as such and NOT rewritten', async () => {
    // The old path had no pre-read at all: it POSTed regardless, and Favro's
    // `403 Dependency already exists` came back as a failure.
    MockCardsAPI.prototype.getCardLinks = jest.fn().mockResolvedValue([{ cardId: 'card-1', isBefore: true }]);
    MockCardsAPI.prototype.linkCard = jest.fn();

    await runCli(['dependencies', 'add', 'card-1', 'card-2', '--type', 'blocks', '--yes']);

    expect(MockCardsAPI.prototype.linkCard).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Already linked'));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('the REVERSE edge refuses rather than claiming the direction it asked for', async () => {
    // At most one edge per pair, undirected identity and directed semantics: the
    // pair can never take the forward edge, so writing it would be a lie.
    MockCardsAPI.prototype.getCardLinks = jest.fn().mockResolvedValue([{ cardId: 'card-1', isBefore: false }]);
    MockCardsAPI.prototype.linkCard = jest.fn();

    await runCli(['dependencies', 'add', 'card-1', 'card-2', '--type', 'blocks', '--yes']);

    expect(MockCardsAPI.prototype.linkCard).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  /**
   * WHICH END THE LOCK CHECKS FLIPPED FOR `--type blocks`, and it is pinned here
   * rather than discovered later.
   *
   * The intent boards off `args.card`, and `blocks` swaps the arguments —
   * "A blocks B" is the edge recorded on B with A as its blocker — so the board
   * checked is the TARGET's. This command used to check the SOURCE's (behind a
   * truthiness guard that a fork slipped through). Consequences, both directions:
   * source-inside/target-outside now REFUSES where it used to pass, and
   * source-outside/target-inside now PASSES where it used to refuse.
   *
   * One end is unchecked either way — that is pre-existing, and shared with
   * `cards link`, which has always used these arguments. Closing it means
   * `add-blocking-edge`'s `board()` returning BOTH cards' boards, which is two
   * lines and one extra read; it is not taken here because it would also tighten
   * `cards link` for every existing caller, and that is a decision about the lock
   * rather than about routing. `--type depends-on` is unaffected: there the source
   * IS `args.card`.
   */
  it('--type blocks checks the TARGET card\'s board, not the source\'s', async () => {
    (config.readConfig as jest.Mock).mockResolvedValue({ scopeCollectionId: 'coll-1' });
    MockCardsAPI.prototype.getCard = jest.fn(async (ref: string) => ({
      cardId: ref,
      boardId: ref === 'card-1' ? 'board-source' : 'board-target',
    })) as never;
    MockCardsAPI.prototype.linkCard = jest.fn().mockResolvedValue([{ cardId: 'card-1', isBefore: true }]);

    await runCli(['dependencies', 'add', 'card-1', 'card-2', '--type', 'blocks', '--yes']);

    expect(safety.assertScope).toHaveBeenCalledWith('board-target', expect.anything(), expect.anything(), undefined);
    expect(safety.assertScope).not.toHaveBeenCalledWith('board-source', expect.anything(), expect.anything(), undefined);
  });

  it('--type depends-on checks the SOURCE card\'s board — the arguments do not swap', async () => {
    (config.readConfig as jest.Mock).mockResolvedValue({ scopeCollectionId: 'coll-1' });
    MockCardsAPI.prototype.getCard = jest.fn(async (ref: string) => ({
      cardId: ref,
      boardId: ref === 'card-1' ? 'board-source' : 'board-target',
    })) as never;
    MockCardsAPI.prototype.linkCard = jest.fn().mockResolvedValue([{ cardId: 'card-2', isBefore: true }]);

    await runCli(['dependencies', 'add', 'card-1', 'card-2', '--type', 'depends-on', '--yes']);

    expect(safety.assertScope).toHaveBeenCalledWith('board-source', expect.anything(), expect.anything(), undefined);
  });

  it('takes the lock on the source card even when it has NO board', async () => {
    // The hole this file's command used to have: the check sat behind
    // `if (sourceCard && sourceCard.boardId)`, so a fork — a card with no
    // widgetCommonId — skipped it and the write went out unchecked. The table
    // refuses a boardless write outright under a lock.
    (config.readConfig as jest.Mock).mockResolvedValue({ scopeCollectionId: 'coll-1' });
    MockCardsAPI.prototype.getCard = jest.fn().mockResolvedValue({ cardId: 'card-2' });
    MockCardsAPI.prototype.linkCard = jest.fn();

    await runCli(['dependencies', 'add', 'card-1', 'card-2', '--type', 'blocks', '--yes']);

    expect(MockCardsAPI.prototype.linkCard).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('favro dependencies delete', () => {
  let consoleSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    MockCardsAPI.prototype.getCardLinks = jest.fn().mockResolvedValue([{ cardId: 'card-2', isBefore: true }]);
  });

  afterEach(() => { jest.restoreAllMocks(); });

  it('removes a single dependency', async () => {
    MockCardsAPI.prototype.unlinkCard = jest.fn().mockResolvedValue(undefined);

    await runCli(['dependencies', 'delete', 'card-1', 'card-2', '--yes']);

    expect(MockCardsAPI.prototype.unlinkCard).toHaveBeenCalledWith('card-1', 'card-2');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Dependency removed'));
  });

  it('no edge to remove is reported, not invented — and nothing is written', async () => {
    MockCardsAPI.prototype.getCardLinks = jest.fn().mockResolvedValue([]);
    MockCardsAPI.prototype.unlinkCard = jest.fn();

    await runCli(['dependencies', 'delete', 'card-1', 'card-2', '--yes']);

    expect(MockCardsAPI.prototype.unlinkCard).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('nothing written'));
  });

  it('dry-run previews', async () => {
    await runCli(['dependencies', 'delete', 'card-1', 'card-2', '--dry-run']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[dry-run] remove the edge'));
    expect(MockCardsAPI.prototype.unlinkCard).not.toHaveBeenCalled();
  });

  it('still runs the scope check on a card with no board', async () => {
    // A boardless card is what an assignment fork looks like, and a write to one
    // is a write the lock cannot see — so the table refuses it rather than
    // exempting it. `--force` deliberately does not rescue that.
    (config.readConfig as jest.Mock).mockResolvedValue({ scopeCollectionId: 'coll-1' });
    MockCardsAPI.prototype.getCard = jest.fn().mockResolvedValue({ cardId: 'card-1' });
    MockCardsAPI.prototype.unlinkCard = jest.fn().mockResolvedValue(undefined);

    await runCli(['dependencies', 'delete', 'card-1', 'card-2', '--yes']);

    expect(MockCardsAPI.prototype.unlinkCard).not.toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('with NO lock configured a --dry-run reads no card at all — the preview is free', async () => {
    // The cost the gate exists to avoid, kept across the routing (#109): with
    // nothing locked there is no verdict to produce, so the preview comes from
    // the intent's own pure `preview()` and touches no wire.
    await runCli(['dependencies', 'delete', 'card-1', 'card-2', '--dry-run']);

    expect(MockCardsAPI.prototype.getCard).not.toHaveBeenCalled();
    expect(MockCardsAPI.prototype.getCardLinks).not.toHaveBeenCalled();
    expect(safety.assertScope).not.toHaveBeenCalled();
  });
});

describe('favro dependencies delete-all', () => {
  let consoleSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => { jest.restoreAllMocks(); });

  it('removes every edge one at a time, so each one has an inverse', async () => {
    // It used to be ONE `DELETE /cards/{id}/dependencies` — unbounded, with no
    // record of what it removed and no way back.
    MockCardsAPI.prototype.getCardLinks = jest.fn().mockResolvedValue([
      { cardId: 'card-2', isBefore: true },
      { cardId: 'card-3', isBefore: false },
    ]);
    MockCardsAPI.prototype.unlinkCard = jest.fn().mockResolvedValue(undefined);

    await runCli(['dependencies', 'delete-all', 'card-1', '--yes']);

    // `CardsAPI.deleteAllDependencies` is GONE, not merely unused: the bulk
    // `DELETE /cards/{id}/dependencies` had no per-edge record and no inverse,
    // and leaving it reachable meant the next command could take it without
    // touching the table. `git-sync-intent-wire.test.ts` keeps the route alive on
    // its stand so the socket can still prove nothing reaches it.
    expect(MockCardsAPI.prototype.unlinkCard).toHaveBeenCalledWith('card-1', 'card-2');
    expect(MockCardsAPI.prototype.unlinkCard).toHaveBeenCalledWith('card-1', 'card-3');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Removed 2 dependencies'));
  });

  it('a card with no dependencies writes nothing and says so', async () => {
    MockCardsAPI.prototype.getCardLinks = jest.fn().mockResolvedValue([]);
    MockCardsAPI.prototype.unlinkCard = jest.fn();

    await runCli(['dependencies', 'delete-all', 'card-1', '--yes']);

    expect(MockCardsAPI.prototype.unlinkCard).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('no dependencies'));
  });

  it('REFUSES above the cap rather than wiping, and names it', async () => {
    // The whole point of routing this one. Twenty-one edges is a blast radius
    // nobody sees until afterwards, so the intent refuses the batch whole — it
    // does not remove the first twenty.
    MockCardsAPI.prototype.getCardLinks = jest.fn().mockResolvedValue(
      Array.from({ length: 21 }, (_, i) => ({ cardId: `far-${i}`, isBefore: true })),
    );
    MockCardsAPI.prototype.unlinkCard = jest.fn();

    await runCli(['dependencies', 'delete-all', 'card-1', '--yes']);

    expect(MockCardsAPI.prototype.unlinkCard).not.toHaveBeenCalled();
    const said = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toMatch(/capped at 20/);
    expect(said).toMatch(/21 dependency edges/);
    expect(said).toMatch(/not a page size/);
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('aborts when user declines', async () => {
    (safety.confirmAction as jest.Mock).mockResolvedValue(false);
    MockCardsAPI.prototype.unlinkCard = jest.fn();

    await runCli(['dependencies', 'delete-all', 'card-1']);

    expect(MockCardsAPI.prototype.unlinkCard).not.toHaveBeenCalled();
  });
});
