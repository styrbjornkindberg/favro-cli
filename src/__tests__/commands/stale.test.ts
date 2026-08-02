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

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

let stdoutSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
let exitSpy: jest.SpyInstance;

async function runCli(args: string[]): Promise<void> {
  const program = new Command();
  program.option('--verbose', 'Show stack traces');
  registerStaleCommand(program);
  program.exitOverride();
  await program.parseAsync(['node', 'favro', ...args]).catch((e) => {
    if (!(e instanceof ExitCalled)) throw e;
  });
}

const written = () => stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
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
  stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code ?? 0);
  }) as never);

  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  (config.readConfig as jest.Mock).mockResolvedValue({});
  MockAggregate.prototype.getMultiBoardSnapshot = jest.fn().mockResolvedValue({ allCards: [] });
  MockAggregate.prototype.getCollectionSnapshot = jest.fn().mockResolvedValue({ allCards: [] });
  MockContext.prototype.getSnapshot = jest.fn().mockResolvedValue({ board: { name: 'Platform' }, cards: [] });
});

afterEach(() => {
  jest.restoreAllMocks();
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

  test('a card with no creation date is reported stale with -1 days', async () => {
    // Favro sends no last-modified field, so age is measured from creation, and
    // a card without one has an unknown age. Current behaviour: it is INCLUDED
    // (Infinity >= any threshold) and carries -1 as its day count.
    MockAggregate.prototype.getMultiBoardSnapshot = jest.fn().mockResolvedValue({
      allCards: [card({ id: 'undated', createdAt: undefined })],
    });

    await runCli(['stale']);

    expect(json().total).toBe(1);
    expect(json().unassignedStale[0].daysSinceUpdate).toBe(-1);
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

    expect(written()).toBe('');
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('502 upstream');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
