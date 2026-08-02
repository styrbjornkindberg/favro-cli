/**
 * `favro stale` — behaviour (#100).
 *
 * Three things decide what this command says: which snapshot it asks for (board
 * / collection / locked collection / everything), which cards it drops, and how
 * it splits what is left. All three are asserted through the JSON the command
 * writes to stdout, not through the API mock.
 */
import { Command } from 'commander';
import { registerStaleCommand } from '../../commands/stale';
import * as config from '../../lib/config';
import AggregateAPI from '../../api/aggregate';
import ContextAPI from '../../api/context';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../api/aggregate');
jest.mock('../../api/context');

const MockAggregate = AggregateAPI as jest.MockedClass<typeof AggregateAPI>;
const MockContext = ContextAPI as jest.MockedClass<typeof ContextAPI>;

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

// `console.log`, not `process.stdout.write`: the runner writes through the
// former, and under jest that is a BufferedConsole which never reaches the
// latter (#115).
let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

async function runCli(args: string[]): Promise<void> {
  const program = new Command();
  // Before the first `.command()`: `copyInheritedSettings` copies
  // `_exitCallback` when the subcommand is created, not when it runs.
  program.exitOverride();
  program
    .option('--verbose', 'Show stack traces')
    // The runner owns both, and `cli.ts` declares them here. A leaf that also
    // declared `--human` would never see it: commander binds the flag to the
    // ancestor, which is why only `optsWithGlobals()` resolves it.
    .option('--human', 'Human-readable output instead of the default JSON')
    .option('--pretty', 'Indent JSON output (default: compact)');
  registerStaleCommand(program);
  await program.parseAsync(['node', 'favro', ...args]);
}

const written = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const json = () => JSON.parse(written());

const card = (over: Record<string, unknown>) => ({
  id: 'c-1',
  title: 'A card',
  stage: 'active',
  createdAt: daysAgo(30),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = undefined;
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  (config.readConfig as jest.Mock).mockResolvedValue({});
  MockAggregate.prototype.getMultiBoardSnapshot = jest.fn().mockResolvedValue({ allCards: [] });
  MockAggregate.prototype.getCollectionSnapshot = jest.fn().mockResolvedValue({ allCards: [] });
  MockContext.prototype.getSnapshot = jest.fn().mockResolvedValue({ board: { name: 'Platform' }, cards: [] });
});

afterEach(() => {
  jest.restoreAllMocks();
  // `process.exitCode` is global and leaks between tests.
  process.exitCode = undefined;
});

describe('stale — which snapshot it asks for', () => {
  test('no flags and no lock: everything', async () => {
    await runCli(['stale']);

    expect(MockAggregate.prototype.getMultiBoardSnapshot).toHaveBeenCalledWith({}, 1000);
    expect(json().scope).toBe('all collections');
  });

  test('a locked collection narrows the sweep without being asked', async () => {
    (config.readConfig as jest.Mock).mockResolvedValue({
      scopeCollectionId: 'coll-1',
      scopeCollectionName: 'Platform',
    });

    await runCli(['stale']);

    expect(MockAggregate.prototype.getMultiBoardSnapshot).toHaveBeenCalledWith({ collectionIds: ['coll-1'] }, 1000);
    expect(json().scope).toBe('Platform');
  });

  test('--collection overrides the lock', async () => {
    (config.readConfig as jest.Mock).mockResolvedValue({ scopeCollectionId: 'coll-1' });

    await runCli(['stale', '--collection', 'Other']);

    expect(MockAggregate.prototype.getCollectionSnapshot).toHaveBeenCalledWith('Other', 1000);
    expect(MockAggregate.prototype.getMultiBoardSnapshot).not.toHaveBeenCalled();
    expect(json().scope).toBe('Other');
  });

  test('--board takes the single-board path and stamps the board name onto every card', async () => {
    MockContext.prototype.getSnapshot = jest.fn().mockResolvedValue({
      board: { name: 'Platform' },
      cards: [card({ id: 'c-1', assignees: ['alice'] })],
    });

    await runCli(['stale', '--board', 'Platform', '--limit', '25']);

    expect(MockContext.prototype.getSnapshot).toHaveBeenCalledWith('Platform', 25);
    expect(json().scope).toBe('Platform');
    expect(json().assignedStale[0].board).toBe('Platform');
  });
});

describe('stale — which cards survive', () => {
  test('a card younger than the threshold is not stale', async () => {
    MockAggregate.prototype.getMultiBoardSnapshot = jest.fn().mockResolvedValue({
      allCards: [card({ id: 'fresh', createdAt: daysAgo(3) })],
    });

    await runCli(['stale', '--days', '14']);

    expect(json().total).toBe(0);
  });

  test('exactly at the threshold counts as stale', async () => {
    MockAggregate.prototype.getMultiBoardSnapshot = jest.fn().mockResolvedValue({
      allCards: [card({ id: 'edge', createdAt: daysAgo(14) })],
    });

    await runCli(['stale', '--days', '14']);

    expect(json().total).toBe(1);
    expect(json().unassignedStale[0].daysSinceUpdate).toBe(14);
  });

  test('done, approved and archived cards are never stale, however old', async () => {
    MockAggregate.prototype.getMultiBoardSnapshot = jest.fn().mockResolvedValue({
      allCards: [
        card({ id: 'd', stage: 'done', createdAt: daysAgo(400) }),
        card({ id: 'a', stage: 'approved', createdAt: daysAgo(400) }),
        card({ id: 'z', stage: 'archived', createdAt: daysAgo(400) }),
        card({ id: 'live', stage: 'active', createdAt: daysAgo(400) }),
      ],
    });

    await runCli(['stale']);

    expect(json().total).toBe(1);
    expect(json().unassignedStale[0].id).toBe('live');
  });

  test('a card with no creation date is reported stale with -1 days — BUG #130', async () => {
    // NOT intended design — this documents the bug in #130, it does not bless it.
    //
    // Favro sends no last-modified field, so age is measured from creation, and
    // a card without one has an unknown age. `daysSince` answers `Infinity`,
    // and `Infinity >= staleDays` is true for every threshold, so an undated
    // card is ALWAYS stale however recent it really is — `--days` cannot
    // exclude it.
    //
    // The second-order symptom is the worse half: the day count is flattened to
    // -1, and both groups sort most-stale-first (`stale.ts:142-143`), so -1
    // sorts LAST. The cards whose freshness is least known are ranked least
    // urgent — the exact inversion of what the command is for. Asserted below
    // so this stays evidence rather than prose.
    MockAggregate.prototype.getMultiBoardSnapshot = jest.fn().mockResolvedValue({
      allCards: [
        card({ id: 'undated', createdAt: undefined }),
        card({ id: 'dated', createdAt: daysAgo(20) }),
      ],
    });

    await runCli(['stale']);

    expect(json().total).toBe(2);
    const undated = json().unassignedStale.find((c: { id: string }) => c.id === 'undated');
    expect(undated.daysSinceUpdate).toBe(-1);
    expect(json().unassignedStale.map((c: { id: string }) => c.id)).toEqual(['dated', 'undated']);
  });

  test('a non-numeric --days falls back to 14 rather than letting NaN pass everything', async () => {
    MockAggregate.prototype.getMultiBoardSnapshot = jest.fn().mockResolvedValue({
      allCards: [card({ id: 'young', createdAt: daysAgo(5) })],
    });

    await runCli(['stale', '--days', 'soon']);

    expect(json().staleDays).toBe(14);
    expect(json().total).toBe(0);
  });
});

describe('stale — how the survivors are split and ordered', () => {
  beforeEach(() => {
    MockAggregate.prototype.getMultiBoardSnapshot = jest.fn().mockResolvedValue({
      allCards: [
        card({ id: 'a-new', title: 'Assigned recent', assignees: ['alice'], createdAt: daysAgo(20) }),
        card({ id: 'a-old', title: 'Assigned ancient', assignees: ['alice'], createdAt: daysAgo(90) }),
        card({ id: 'u-1', title: 'Nobody', assignees: [], createdAt: daysAgo(60), boardName: 'Platform' }),
      ],
    });
  });

  test('splits on whether anyone owns the card, and orders each group most-stale first', async () => {
    await runCli(['stale']);

    const out = json();
    expect(out.assignedStale.map((c: { id: string }) => c.id)).toEqual(['a-old', 'a-new']);
    expect(out.unassignedStale.map((c: { id: string }) => c.id)).toEqual(['u-1']);
    expect(out.total).toBe(3);
  });

  test('--human prints both groups with counts instead of JSON', async () => {
    await runCli(['stale', '--human']);

    expect(written()).toContain('Assigned but stale (2):');
    expect(written()).toContain('Unassigned and stale (1):');
    expect(written()).toContain('• Nobody — Platform (60d ago)');
    expect(() => json()).toThrow();
  });

  test('--human says so plainly when nothing is stale', async () => {
    MockAggregate.prototype.getMultiBoardSnapshot = jest.fn().mockResolvedValue({ allCards: [] });

    await runCli(['stale', '--human']);

    expect(written()).toContain('No stale cards found.');
  });
});

describe('stale — failures', () => {
  test('a failed snapshot exits 1 rather than reporting an empty board', async () => {
    MockAggregate.prototype.getMultiBoardSnapshot = jest.fn().mockRejectedValue(new Error('502 upstream'));

    await runCli(['stale']);

    // Never an empty report: JSON is the default, so the failure is the error
    // envelope on stdout rather than a `total: 0` a caller would believe.
    expect(json()).toEqual({ error: { message: '502 upstream', retryable: true } });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test('in --human mode the failure stays on stderr, and stdout says nothing', async () => {
    MockAggregate.prototype.getMultiBoardSnapshot = jest.fn().mockRejectedValue(new Error('502 upstream'));

    await runCli(['stale', '--human']);

    expect(written()).toBe('');
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('502 upstream');
    expect(process.exitCode).toBe(1);
  });
});
