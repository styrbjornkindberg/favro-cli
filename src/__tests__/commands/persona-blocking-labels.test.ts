/**
 * Persona commands must not report an unjudged dependency edge as "blocked" (#61).
 *
 * Nothing clears a Favro `isBefore` edge when the blocker finishes, so a
 * length-of-edges read is a permanent over-count. These commands do not judge
 * doneness (that costs `readTrackerMapping` + a per-blocker sweep — see
 * `judgeBlockers`), so they must report the edge COUNT under an honest name and
 * leave the blocked *state* to the signals they can actually verify.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Before any require that might touch the real ~/.favro.
process.env.FAVRO_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'favro-blocking-labels-'));

import { Command } from 'commander';
import { registerMyStandupCommand } from '../../commands/my-standup';
import { registerHealthCommand } from '../../commands/health';
import { registerWorkloadCommand } from '../../commands/workload';
import { registerTeamCommand } from '../../commands/team';
import { isBlocked, classifyCard } from '../../api/standup';
import type { ContextCard } from '../../api/context';
import AggregateAPI, { AggregateCard } from '../../api/aggregate';
import * as config from '../../lib/config';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../api/aggregate');

const MockAggregateAPI = AggregateAPI as jest.MockedClass<typeof AggregateAPI>;

const USER = 'user-1';

function makeCard(overrides: Partial<AggregateCard> = {}): AggregateCard {
  return {
    id: 'card-1',
    title: 'Test Card',
    assignees: [USER],
    tags: [],
    blockedBy: [],
    blocking: [],
    boardName: 'Board A',
    ...overrides,
  } as AggregateCard;
}

function snapshotOf(cards: AggregateCard[]) {
  return {
    collections: [],
    allCards: cards,
    members: [{ id: USER, name: 'Alice', email: 'alice@example.com' }],
    stats: { total: cards.length, by_collection: {}, by_board: {}, by_status: {}, by_owner: {} },
    generatedAt: '2026-07-31T00:00:00.000Z',
  };
}

// `console.log`, not `process.stdout.write`: the runner writes through the
// former, and under jest that is a BufferedConsole which never reaches the
// latter (#115).
let logSpy: jest.SpyInstance;

async function runCli(
  register: (p: Command) => void,
  args: string[],
  cards: AggregateCard[],
): Promise<any> {
  MockAggregateAPI.prototype.getMultiBoardSnapshot.mockResolvedValue(snapshotOf(cards) as any);
  MockAggregateAPI.prototype.getCollectionSnapshot.mockResolvedValue(snapshotOf(cards) as any);
  const program = new Command();
  // Before the first `.command()`: `copyInheritedSettings` copies
  // `_exitCallback` when the subcommand is created, not when it runs.
  program.exitOverride();
  program.option('--verbose');
  register(program);
  await program.parseAsync(['node', 'favro', ...args]);
  const written = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
  return JSON.parse(written);
}

beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = undefined;
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  (config.resolveUserId as jest.Mock).mockResolvedValue(USER);
  (config.readConfig as jest.Mock).mockResolvedValue({});
});

afterEach(() => {
  jest.restoreAllMocks();
  process.exitCode = undefined;
});

// A card parked in a column literally named "Blocked". `detectStage` has no
// 'blocked' member and falls through to 'queued', so the stage cannot carry this
// signal — the column name is the only evidence, and it is free on the snapshot.
const BLOCKED_COLUMN_CARD: Partial<AggregateCard> = {
  id: 'cBlockedColumn',
  title: 'Waiting on ops',
  status: 'Blocked',
  column: 'Blocked',
  stage: 'queued',
};

describe('favro my-standup', () => {
  // Each case carries a real blocked card alongside the card under test, so
  // `blocked` is a reachable group — asserting the subject is absent from it
  // cannot pass vacuously.
  it('reports a finished card as completed even when it still carries a blocker edge', async () => {
    const result = await runCli(registerMyStandupCommand, ['my-standup'], [
      makeCard({ id: 'c1', title: 'Shipped', stage: 'done', blockedBy: ['stale-blocker'] }),
      makeCard(BLOCKED_COLUMN_CARD),
    ]);

    expect(result.completed.map((c: any) => c.id)).toEqual(['c1']);
    expect(result.blocked.map((c: any) => c.id)).toEqual(['cBlockedColumn']);
  });

  it('does not divert an in-progress card into blocked on an edge alone', async () => {
    const result = await runCli(registerMyStandupCommand, ['my-standup'], [
      makeCard({ id: 'c3', title: 'Working', stage: 'active', blockedBy: ['stale-blocker'] }),
      makeCard(BLOCKED_COLUMN_CARD),
    ]);

    expect(result.inProgress.map((c: any) => c.id)).toEqual(['c3']);
    expect(result.blocked.map((c: any) => c.id)).toEqual(['cBlockedColumn']);
  });

  it('agrees with `favro standup` on a card sitting in a column named "Blocked"', async () => {
    const card = makeCard(BLOCKED_COLUMN_CARD);

    const result = await runCli(registerMyStandupCommand, ['my-standup'], [card]);
    const sibling = classifyCard(card as ContextCard);

    expect(sibling?.group).toBe('blocked');
    expect(result.blocked.map((c: any) => c.id)).toEqual(['cBlockedColumn']);
    expect(result.inProgress).toEqual([]);
  });

  it('reads the column name when status hydration did not fill it in', async () => {
    const result = await runCli(registerMyStandupCommand, ['my-standup'], [
      makeCard({ id: 'cNoStatus', column: 'Blocked', stage: 'queued' }),
    ]);

    expect(result.blocked.map((c: any) => c.id)).toEqual(['cNoStatus']);
  });
});

describe('favro health', () => {
  it('reports the edge count as a dependencies score, not a blocked score', async () => {
    const result = await runCli(registerHealthCommand, ['health'], [
      makeCard({ id: 'c1', stage: 'active', blockedBy: ['x'] }),
      makeCard({ id: 'c2', stage: 'active' }),
    ]);

    const board = result.boards[0];
    expect(board.breakdown.dependencies).toBe(50);
    expect(board.breakdown).not.toHaveProperty('blocked');
  });
});

describe('favro workload', () => {
  it('counts cards carrying dependency edges under an edge-count name', async () => {
    const result = await runCli(registerWorkloadCommand, ['workload'], [
      makeCard({ id: 'c1', blockedBy: ['x'] }),
      makeCard({ id: 'c2' }),
    ]);

    const member = result.members[0];
    expect(member.dependencyCards).toBe(1);
    expect(member).not.toHaveProperty('blockedCards');
  });
});

describe('favro team', () => {
  it('counts dependency edges per member and names the bottleneck by them', async () => {
    const result = await runCli(registerTeamCommand, ['team'], [
      makeCard({ id: 'c1', blockedBy: ['x'] }),
      makeCard({ id: 'c2' }),
    ]);

    const member = result.members[0];
    expect(member.dependencyCount).toBe(1);
    expect(member).not.toHaveProperty('blockedCount');
    expect(result.bottleneck).toEqual({ name: 'Alice', dependencyCount: 1 });
  });
});

describe('StandupAPI classification', () => {
  const ctxCard = (o: Partial<ContextCard> = {}): ContextCard => ({
    id: 'card-1',
    title: 'Test Card',
    status: 'In Progress',
    assignees: [],
    tags: [],
    blockedBy: [],
    blocking: [],
    ...o,
  });

  it('treats a blocked status as blocked', () => {
    expect(isBlocked(ctxCard({ status: 'Blocked' }))).toBe(true);
    expect(isBlocked(ctxCard({ status: 'On Hold' }))).toBe(true);
  });

  it('does not treat an unjudged dependency edge as a blocked state', () => {
    expect(isBlocked(ctxCard({ blockedBy: ['card-99'] }))).toBe(false);
  });

  it('keeps a done card done when it still carries a dependency edge', () => {
    expect(classifyCard(ctxCard({ status: 'Done', blockedBy: ['card-99'] }))?.group).toBe(
      'completed',
    );
  });

  it('surfaces the edge count on the card so the signal is not lost', () => {
    expect(classifyCard(ctxCard({ blockedBy: ['a', 'b'] }))?.dependencies).toBe(2);
    expect(classifyCard(ctxCard({}))?.dependencies).toBe(0);
  });
});
