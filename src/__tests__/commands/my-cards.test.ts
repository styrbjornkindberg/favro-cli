/**
 * `favro my-cards` — behaviour (#100).
 *
 * "Mine" is two fields, not one — assignee OR owner — and the answer is grouped
 * collection → board and topped with one suggestion. The suggestion is the part
 * with real logic in it (a scoring ladder over stage and due date), so it gets
 * the most attention here.
 */
import { Command } from 'commander';
import { registerMyCardsCommand } from '../../commands/my-cards';
import * as config from '../../lib/config';
import AggregateAPI from '../../api/aggregate';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../api/aggregate');

const MockAggregate = AggregateAPI as jest.MockedClass<typeof AggregateAPI>;

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

const DAY = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();

let stdoutSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
let exitSpy: jest.SpyInstance;

async function runCli(args: string[]): Promise<void> {
  const program = new Command();
  program.option('--verbose', 'Show stack traces');
  registerMyCardsCommand(program);
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
  stage: 'queued',
  collectionName: 'Platform',
  boardName: 'Sprint 42',
  ...over,
});

const snapshot = (allCards: unknown[]) => ({ allCards });

beforeEach(() => {
  jest.clearAllMocks();
  stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code ?? 0);
  }) as never);

  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  (config.resolveUserId as jest.Mock).mockResolvedValue('user-me');
  (config.readConfig as jest.Mock).mockResolvedValue({});
  MockAggregate.prototype.getMultiBoardSnapshot = jest.fn().mockResolvedValue(snapshot([]));
  MockAggregate.prototype.getCollectionSnapshot = jest.fn().mockResolvedValue(snapshot([]));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('my-cards — identity', () => {
  test('refuses without a resolved identity — "my" has no meaning yet', async () => {
    (config.resolveUserId as jest.Mock).mockResolvedValue(undefined);

    await runCli(['my-cards']);

    expect(MockAggregate.prototype.getMultiBoardSnapshot).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('userId not configured');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('mine means assignee OR owner — and nobody else\'s cards', async () => {
    MockAggregate.prototype.getMultiBoardSnapshot = jest.fn().mockResolvedValue(
      snapshot([
        card({ id: 'assigned', assignees: ['user-me'] }),
        card({ id: 'owned', owner: 'user-me' }),
        card({ id: 'theirs', assignees: ['user-other'], owner: 'user-other' }),
      ]),
    );

    await runCli(['my-cards']);

    const out = json();
    expect(out.userId).toBe('user-me');
    expect(out.total).toBe(2);
    const ids = out.collections[0].boards[0].cards.map((c: { id: string }) => c.id);
    expect(ids).toEqual(['assigned', 'owned']);
  });
});

describe('my-cards — scope and filters', () => {
  test('a locked collection narrows the sweep, and --collection overrides it', async () => {
    (config.readConfig as jest.Mock).mockResolvedValue({ scopeCollectionId: 'coll-1' });

    await runCli(['my-cards']);
    expect(MockAggregate.prototype.getMultiBoardSnapshot).toHaveBeenCalledWith({ collectionIds: ['coll-1'] }, 1000);

    await runCli(['my-cards', '--collection', 'Other', '--limit', '10']);
    expect(MockAggregate.prototype.getCollectionSnapshot).toHaveBeenCalledWith('Other', 10);
  });

  test('--status filters by workflow stage, case-insensitively', async () => {
    MockAggregate.prototype.getMultiBoardSnapshot = jest.fn().mockResolvedValue(
      snapshot([
        card({ id: 'a', stage: 'active', assignees: ['user-me'] }),
        card({ id: 'q', stage: 'queued', assignees: ['user-me'] }),
      ]),
    );

    await runCli(['my-cards', '--status', 'ACTIVE']);

    expect(json().total).toBe(1);
    expect(json().collections[0].boards[0].cards[0].id).toBe('a');
  });
});

describe('my-cards — grouping', () => {
  test('nests board under collection and keeps cards with their board', async () => {
    MockAggregate.prototype.getMultiBoardSnapshot = jest.fn().mockResolvedValue(
      snapshot([
        card({ id: 'p1', collectionName: 'Platform', boardName: 'Sprint 42', assignees: ['user-me'] }),
        card({ id: 'p2', collectionName: 'Platform', boardName: 'Backlog', assignees: ['user-me'] }),
        card({ id: 'w1', collectionName: 'Web', boardName: 'Sprint 42', assignees: ['user-me'] }),
      ]),
    );

    await runCli(['my-cards']);

    const out = json();
    expect(out.collections.map((c: { name: string }) => c.name)).toEqual(['Platform', 'Web']);
    expect(out.collections[0].boards.map((b: { name: string }) => b.name)).toEqual(['Sprint 42', 'Backlog']);
    expect(out.collections[1].boards[0].cards.map((c: { id: string }) => c.id)).toEqual(['w1']);
  });

  test('a card with no collection or board still lands somewhere, under "Unknown"', async () => {
    MockAggregate.prototype.getMultiBoardSnapshot = jest.fn().mockResolvedValue(
      snapshot([card({ id: 'orphan', collectionName: undefined, boardName: undefined, assignees: ['user-me'] })]),
    );

    await runCli(['my-cards']);

    expect(json().collections[0].name).toBe('Unknown');
    expect(json().collections[0].boards[0].name).toBe('Unknown');
    expect(json().total).toBe(1);
  });
});

describe('my-cards — the suggestion', () => {
  test('an overdue card outranks an in-progress one, and says why', async () => {
    MockAggregate.prototype.getMultiBoardSnapshot = jest.fn().mockResolvedValue(
      snapshot([
        card({ id: 'active', title: 'In flight', stage: 'active', assignees: ['user-me'] }),
        card({ id: 'late', title: 'Late one', stage: 'backlog', due: inDays(-5), assignees: ['user-me'] }),
      ]),
    );

    await runCli(['my-cards']);

    expect(json().suggestedNext).toMatchObject({ id: 'late', title: 'Late one', board: 'Sprint 42' });
    expect(json().suggestedNext.reason).toContain('overdue by 5 days');
  });

  test('with nothing due, the stage ladder decides: active beats queued beats backlog', async () => {
    MockAggregate.prototype.getMultiBoardSnapshot = jest.fn().mockResolvedValue(
      snapshot([
        card({ id: 'backlog', stage: 'backlog', assignees: ['user-me'] }),
        card({ id: 'queued', stage: 'queued', assignees: ['user-me'] }),
        card({ id: 'active', stage: 'active', assignees: ['user-me'] }),
      ]),
    );

    await runCli(['my-cards']);

    expect(json().suggestedNext.id).toBe('active');
    expect(json().suggestedNext.reason).toBe('already in progress');
  });

  test('a card in no schedulable stage is never suggested', async () => {
    MockAggregate.prototype.getMultiBoardSnapshot = jest.fn().mockResolvedValue(
      snapshot([card({ id: 'done', stage: 'done', assignees: ['user-me'] })]),
    );

    await runCli(['my-cards']);

    expect(json().total).toBe(1);
    expect(json().suggestedNext).toBeUndefined();
  });

  test('falls back to a generic reason rather than an empty one', async () => {
    MockAggregate.prototype.getMultiBoardSnapshot = jest.fn().mockResolvedValue(
      snapshot([card({ id: 'q', stage: 'queued', assignees: ['user-me'] })]),
    );

    await runCli(['my-cards']);

    expect(json().suggestedNext.reason).toBe('highest priority in queue');
  });
});

describe('my-cards — output', () => {
  test('--human prints the grouped tree and the suggestion instead of JSON', async () => {
    MockAggregate.prototype.getMultiBoardSnapshot = jest.fn().mockResolvedValue(
      snapshot([card({ id: 'c-1', title: 'Fix login', stage: 'active', due: inDays(10), assignees: ['user-me'] })]),
    );

    await runCli(['my-cards', '--human']);

    expect(written()).toContain('My Cards (1 total)');
    expect(written()).toContain('Platform → Sprint 42');
    expect(written()).toContain('• Fix login (active)');
    expect(written()).toContain('→ Next: Fix login (already in progress)');
    expect(() => json()).toThrow();
  });

  test('a failed snapshot exits 1 and prints no result', async () => {
    MockAggregate.prototype.getMultiBoardSnapshot = jest.fn().mockRejectedValue(new Error('502 upstream'));

    await runCli(['my-cards']);

    expect(written()).toBe('');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
