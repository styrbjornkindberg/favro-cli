/**
 * The TUI surfaces must not report an unjudged dependency edge as "blocked" (#61).
 *
 * Same treatment as `health` / `workload` / `team` / `standup`: nothing clears a
 * Favro `isBefore` edge when the blocker finishes, and these paths do not pay
 * for `judgeBlockers`, so an edge is reported as a dependency — never as a
 * blocked state, and never as a reason to drop a card out of another bucket.
 */
import { join } from 'node:path';
import { tempConfigDir } from '../../test-support/config-dir';

// Before any require that might touch the real ~/.favro.
tempConfigDir('favro-tui-labels-');

import { Command } from 'commander';
import { registerBoardTuiCommand } from '../../commands/board-tui';
import { runMainMenu } from '../../commands/main-menu';
import { ContextAPI } from '../../api/context';
import AggregateAPI from '../../api/aggregate';
import * as config from '../../lib/config';

jest.mock('../../lib/http-client');
jest.mock('../../lib/client-factory');
jest.mock('../../lib/config');
jest.mock('../../api/context');
jest.mock('../../api/aggregate');
jest.mock('enquirer', () => ({
  Select: jest.fn().mockImplementation(() => ({ run: () => Promise.resolve(nextAnswer()) })),
  AutoComplete: jest.fn().mockImplementation(() => ({ run: () => Promise.resolve(nextAnswer()) })),
}));

const MockContextAPI = ContextAPI as jest.MockedClass<typeof ContextAPI>;
const MockAggregateAPI = AggregateAPI as jest.MockedClass<typeof AggregateAPI>;

const USER = 'user-1';

// ─── enquirer answer queue ───────────────────────────────────────────────────

let answers: string[] = [];
function nextAnswer(): string {
  // Falling off the end returns the Exit index, so a mis-scripted test ends the
  // menu loop instead of hanging.
  return answers.shift() ?? '5';
}

// ─── Output capture ──────────────────────────────────────────────────────────

let logSpy: jest.SpyInstance;
function output(): string {
  return logSpy.mock.calls.map(cl => cl.map(String).join(' ')).join('\n');
}

beforeEach(() => {
  jest.clearAllMocks();
  answers = [];
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  // `pause()` waits on one stdin 'data' event — deliver it immediately.
  jest.spyOn(process.stdin, 'once').mockImplementation(((_e: string, cb: () => void) => {
    setImmediate(cb);
    return process.stdin;
  }) as any);
  jest.spyOn(process.stdin, 'removeListener').mockImplementation((() => process.stdin) as any);
  jest.spyOn(process.stdin, 'resume').mockImplementation((() => process.stdin) as any);
  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  (config.resolveUserId as jest.Mock).mockResolvedValue(USER);
  (config.readConfig as jest.Mock).mockResolvedValue({});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── favro board --json ──────────────────────────────────────────────────────

describe('favro board --json', () => {
  function snapshot(cards: any[]) {
    return {
      board: { id: 'b1', name: 'Board A', members: [] },
      columns: [{ id: 'col-done', name: 'Done' }, { id: 'col-blocked', name: 'Blocked' }],
      workflow: [],
      customFields: [],
      members: [],
      cards,
      stats: { total: cards.length, by_status: {}, by_owner: {}, by_tag: {} },
      generatedAt: '2026-07-31T00:00:00.000Z',
    };
  }

  async function renderJson(cards: any[]): Promise<any> {
    MockContextAPI.prototype.getSnapshot.mockResolvedValue(snapshot(cards) as any);
    const program = new Command();
    program.option('--verbose');
    registerBoardTuiCommand(program);
    program.exitOverride();
    await program.parseAsync(['node', 'favro', 'board', 'b1', '--json']);
    return JSON.parse(output());
  }

  it('does not mark a done card blocked because it still carries a dependency edge', async () => {
    const result = await renderJson([
      { id: 'c1', title: 'Shipped', status: 'Done', columnId: 'col-done', blockedBy: ['stale'] },
    ]);

    const done = result.columns.find((col: any) => col.name === 'Done');
    // The card must actually be there — otherwise "not blocked" is vacuous.
    expect(done.cards.map((ca: any) => ca.id)).toEqual(['c1']);
    expect(done.cards[0].blocked).toBeFalsy();
  });

  it('does not render the blocked glyph on an edge, only on a blocked column', async () => {
    MockContextAPI.prototype.getSnapshot.mockResolvedValue(snapshot([
      { id: 'c1', title: 'Shipped', status: 'Done', columnId: 'col-done', blockedBy: ['stale'] },
    ]) as any);
    const program = new Command();
    program.option('--verbose');
    registerBoardTuiCommand(program);
    program.exitOverride();
    await program.parseAsync(['node', 'favro', 'board', 'b1']);

    const rendered = output();
    // `board-renderer.ts:43` prints ◆ for a blocked card, ahead of every other
    // status icon. The card is on screen; the glyph must not be.
    expect(rendered).toContain('Shipped');
    expect(rendered).not.toContain('◆');
  });
});

// ─── Interactive menu ────────────────────────────────────────────────────────

function menuSnapshot(cards: any[]) {
  return {
    collections: [],
    allCards: cards,
    members: [{ id: USER, name: 'Alice', email: 'alice@example.com' }],
    stats: { total: cards.length, by_collection: {}, by_board: {}, by_status: {}, by_owner: {} },
    generatedAt: '2026-07-31T00:00:00.000Z',
  };
}

async function runMenu(menuIndex: string, cards: any[]): Promise<string> {
  MockAggregateAPI.prototype.getMultiBoardSnapshot.mockResolvedValue(menuSnapshot(cards) as any);
  answers = [menuIndex, '5']; // the screen under test, then Exit
  // The menu takes the root `Command` now (#118) — the runner resolves the
  // format off it, and 'Help' calls `outputHelp()` on it.
  const program = new Command();
  program.exitOverride();
  await runMainMenu('0.0.0-test', program);
  return output();
}

describe('main menu — My Work', () => {
  it('does not call a card blocked, or hide it, on a dependency edge alone', async () => {
    const out = await runMenu('0', [
      { id: 'c1', title: 'Queued with an edge', assignees: [USER], stage: 'queued', blockedBy: ['stale'] },
    ]);

    expect(out).toContain('1 with dependencies');
    expect(out).not.toMatch(/\bblocked\b/i);
  });

  it('keeps an edge-carrying card in the queued count instead of subtracting it', async () => {
    const out = await runMenu('0', [
      { id: 'c1', title: 'Queued with an edge', assignees: [USER], stage: 'queued', blockedBy: ['stale'] },
      { id: 'c2', title: 'Queued clean', assignees: [USER], stage: 'queued' },
    ]);

    expect(out).toContain('2 queued');
  });

  it('says nothing about dependencies when no card carries an edge', async () => {
    const out = await runMenu('0', [
      { id: 'c2', title: 'Queued clean', assignees: [USER], stage: 'queued' },
    ]);

    expect(out).toContain('1 queued');
    expect(out).not.toContain('dependencies');
  });

  /**
   * The done half of this screen's stage filter was UNTESTED before #98.
   *
   * `queued` here is "assigned to me and neither active nor finished", and the
   * finished half of that was the fifth copy of `['done','approved','archived']`
   * — inlined and fused with the active list. Every existing case above feeds
   * cards in stage `queued` only, so no card in a done stage ever reached the
   * filter: deleting the three done strings from it passed all 3334 tests.
   * Found by running the sibling-site mutation at all five call sites rather
   * than the four that had coverage.
   *
   * Each done stage is a separate arm on purpose — asserted as a set, dropping
   * one member would hide behind the other two.
   */
  it.each(['done', 'approved', 'archived'])(
    'leaves a card in the finished stage `%s` out of the queued count',
    async (stage) => {
      const out = await runMenu('0', [
        { id: 'c1', title: 'Finished', assignees: [USER], stage },
        { id: 'c2', title: 'Queued clean', assignees: [USER], stage: 'queued' },
      ]);

      // Both cards are mine, so the total proves the finished one was present
      // and filtered — not simply absent from the fixture.
      expect(out).toContain('2 cards');
      expect(out).toContain('1 queued');
    },
  );

  it('counts an active card as active, not queued', async () => {
    // The foreign arm for the same filter: without it, `other` returning
    // everything-not-done would still pass the finished arms above.
    const out = await runMenu('0', [
      { id: 'c1', title: 'Working', assignees: [USER], stage: 'active' },
      { id: 'c2', title: 'Queued clean', assignees: [USER], stage: 'queued' },
    ]);

    expect(out).toContain('1 active');
    expect(out).toContain('1 queued');
  });
});

describe('main menu — Team Dashboard', () => {
  it('reports per-member edges as a dependency count, not a blocked count', async () => {
    const out = await runMenu('1', [
      { id: 'c1', title: 'One', assignees: [USER], stage: 'queued', blockedBy: ['stale'] },
      { id: 'c2', title: 'Two', assignees: [USER], stage: 'active' },
    ]);

    expect(out).toContain('1 with deps');
    expect(out).not.toMatch(/\bblocked\b/i);
  });
});
