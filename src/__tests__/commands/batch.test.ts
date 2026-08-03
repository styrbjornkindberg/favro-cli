/**
 * Tests for batch command (batch update, move, assign)
 * CLA-1781 / FAVRO-019
 */
import { Command } from 'commander';
import {
  registerBatchCommand,
  registerBatchUpdateCommand,
  registerBatchMoveCommand,
  registerBatchAssignCommand,
} from '../../commands/batch';
import { Card } from '../../lib/cards-api';
import CardsAPI from '../../lib/cards-api';
import FavroHttpClient from '../../lib/http-client';
import * as config from '../../lib/config';
import * as fsPromises from 'fs/promises';
import { STUB_BOARD, stubVocabularyClient } from '../../test-support/filter-vocabulary';

/**
 * `--filter` on `batch move`/`batch assign` is no longer a grammar of its own
 * (#138): it goes through the same `resolveQuery` `cards list` and `cards
 * export` run, so every `status:`/`tag:`/`assignee:` value is settled against
 * the org's real vocabulary. The stub org below is what these tests settle
 * against, so the fixtures speak its column names.
 */
jest.mock('../../lib/client-factory', () => {
  // Required inside the factory, not closed over: `jest.mock` is hoisted above
  // the imports, so a top-level binding is not initialised when it runs. The
  // key check is kept, because two tests below are about a missing one.
  const stub = async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    if (!(await require('../../lib/config').resolveApiKey())) {
      throw new Error('API key not configured. Run `favro auth login`.');
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../test-support/filter-vocabulary').stubVocabularyClient();
  };
  return { __esModule: true, createFavroClient: jest.fn(stub), default: jest.fn(stub) };
});

/**
 * `--to` is resolved to a `userId` before any card is touched — that resolution
 * has its own wire suite, so here it is stubbed with the mapping the fixtures
 * below use. `card.assignees` holds userIds, so ALICE (not "alice") is what the
 * dedupe compares and what the write composes.
 */
const ALICE = 'aB3dE5gH7jK9mN1pQ';
const BOB = 'zY8xW6vU4tS2rQ0oP';
jest.mock('../../lib/assignee', () => ({
  resolveAssignee: jest.fn(async (_client: unknown, value: string) =>
    value === 'alice' ? 'aB3dE5gH7jK9mN1pQ' : value
  ),
}));

jest.mock('../../lib/cards-api');
jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('fs/promises');

const mockResolveApiKey = config.resolveApiKey as jest.MockedFunction<typeof config.resolveApiKey>;
const mockFsReadFile = fsPromises.readFile as jest.MockedFunction<typeof fsPromises.readFile>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    cardId: 'card-default',
    name: 'Default Card',
    status: 'todo',
    assignees: [],
    tags: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// `parseFilterExpression` and `buildFilterFn` no longer live here. They were a
// third `--filter` grammar on a WRITE command whose unknown-field branch was
// `() => false`, so a typo'd field moved or assigned nothing and reported
// success (#138). `--filter` now runs the one protocol every read runs; its
// refusals are pinned against `cards list`'s and `cards export`'s, and the
// no-write guarantee against a real wire, in
// `src/__tests__/batch-filter-fail-closed-wire.test.ts`.

// `resolveAssignee` no longer lives here. It was a placeholder that echoed the
// flag text back, which is what made the dedupe below compare a display name
// against userIds. It now lives in src/lib/assignee.ts and is covered by
// tags-users-assignee-wire.test.ts against a real Favro stand-in.

// ---------------------------------------------------------------------------
// batch update command
// ---------------------------------------------------------------------------

describe('batch update command', () => {
  let program: Command;
  let mockApi: jest.Mocked<CardsAPI>;
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FAVRO_API_KEY = 'test-token';

    program = new Command();
    program.exitOverride();
    const batch = program.command('batch');
    registerBatchUpdateCommand(batch);

    mockResolveApiKey.mockResolvedValue('test-token');

    const mockClient = new FavroHttpClient() as jest.Mocked<FavroHttpClient>;
    mockApi = new CardsAPI(mockClient) as jest.Mocked<CardsAPI>;
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => mockApi);

    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    delete process.env.FAVRO_API_KEY;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  it('dry-run shows preview without calling API', async () => {
    const csvContent = 'card_id,status\ncard-1,Done\ncard-2,In Progress';
    mockFsReadFile.mockResolvedValue(csvContent as any);

    await program.parseAsync(['node', 'favro', 'batch', 'update', '--from-csv', 'cards.csv', '--dry-run']);

    expect(mockApi.updateCard).not.toHaveBeenCalled();
    const allOutput = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    expect(allOutput).toContain('Dry-run');
    expect(allOutput).toContain('card-1');
  });

  it('exits with error when CSV file not found', async () => {
    mockFsReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await program.parseAsync(['node', 'favro', 'batch', 'update', '--from-csv', 'missing.csv']);

    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with error for invalid CSV (missing card_id column)', async () => {
    mockFsReadFile.mockResolvedValue('status,owner\nDone,alice' as any);

    await program.parseAsync(['node', 'favro', 'batch', 'update', '--from-csv', 'bad.csv']);

    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('validation errors'));
  });

  it('calls updateCard for each CSV row on success', async () => {
    const csv = 'card_id,status\ncard-1,Done\ncard-2,In Progress';
    mockFsReadFile.mockResolvedValue(csv as any);
    mockApi.updateCard.mockResolvedValue({ cardId: 'card-1', name: 'Test', createdAt: '' });

    await program.parseAsync(['node', 'favro', 'batch', 'update', '--from-csv', 'cards.csv']);

    expect(mockApi.updateCard).toHaveBeenCalledTimes(2);
    expect(mockApi.updateCard).toHaveBeenCalledWith('card-1', expect.objectContaining({ status: 'Done' }));
    expect(mockApi.updateCard).toHaveBeenCalledWith('card-2', expect.objectContaining({ status: 'In Progress' }));
  });

  it('exits with error when no API key', async () => {
    mockResolveApiKey.mockResolvedValue(undefined);

    await program.parseAsync(['node', 'favro', 'batch', 'update', '--from-csv', 'cards.csv']);

    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('--json: first stdout call is parseable JSON (no progress messages)', async () => {
    const csv = 'card_id,status\ncard-1,Done';
    mockFsReadFile.mockResolvedValue(csv as any);
    mockApi.updateCard.mockResolvedValue(makeCard({ cardId: 'card-1', status: 'Done' }));

    await program.parseAsync(['node', 'favro', 'batch', 'update', '--from-csv', 'cards.csv', '--json']);

    // First console.log call must be parseable JSON
    expect(consoleLogSpy.mock.calls.length).toBeGreaterThan(0);
    const firstCall = consoleLogSpy.mock.calls[0][0];
    expect(() => JSON.parse(firstCall)).not.toThrow();
    const parsed = JSON.parse(firstCall);
    expect(parsed).toHaveProperty('total');
    expect(parsed).toHaveProperty('success');
  });

  it('sends dueDate field when CSV has due_date column (BLOCKER 2)', async () => {
    const csv = 'card_id,due_date\ncard-1,2026-12-31';
    mockFsReadFile.mockResolvedValue(csv as any);
    mockApi.updateCard.mockResolvedValue(makeCard({ cardId: 'card-1' }));

    await program.parseAsync(['node', 'favro', 'batch', 'update', '--from-csv', 'cards.csv']);

    expect(mockApi.updateCard).toHaveBeenCalledWith('card-1', expect.objectContaining({ dueDate: '2026-12-31' }));
  });

  it('fetches card previousState before updating (for atomic rollback, BLOCKER 4)', async () => {
    const csv = 'card_id,status\ncard-1,Done';
    mockFsReadFile.mockResolvedValue(csv as any);
    mockApi.getCard.mockResolvedValue(makeCard({ cardId: 'card-1', status: 'todo', dueDate: '2026-01-01', boardId: 'board-x' }));
    mockApi.updateCard.mockResolvedValue(makeCard({ cardId: 'card-1', status: 'Done' }));

    await program.parseAsync(['node', 'favro', 'batch', 'update', '--from-csv', 'cards.csv']);

    // getCard must be called to fetch previousState
    expect(mockApi.getCard).toHaveBeenCalledWith('card-1');
    expect(mockApi.updateCard).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// batch move command
// ---------------------------------------------------------------------------

describe('batch move command', () => {
  let program: Command;
  let mockApi: jest.Mocked<CardsAPI>;
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FAVRO_API_KEY = 'test-token';

    program = new Command();
    program.exitOverride();
    const batch = program.command('batch');
    registerBatchMoveCommand(batch);

    mockResolveApiKey.mockResolvedValue('test-token');

    const mockClient = new FavroHttpClient() as jest.Mocked<FavroHttpClient>;
    mockApi = new CardsAPI(mockClient) as jest.Mocked<CardsAPI>;
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => mockApi);

    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    delete process.env.FAVRO_API_KEY;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  it('requires --to-board or --status', async () => {
    await program.parseAsync(['node', 'favro', 'batch', 'move', '--board', STUB_BOARD]);
    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('--to-board'));
  });

  it('dry-run shows preview without updating cards', async () => {
    mockApi.listCards.mockResolvedValue([
      makeCard({ cardId: 'card-1', status: 'done' }),
      makeCard({ cardId: 'card-2', status: 'todo' }),
    ]);

    await program.parseAsync([
      'node', 'favro', 'batch', 'move',
      '--board', STUB_BOARD,
      '--status', 'Archive',
      '--filter', 'status:done',
      '--dry-run',
    ]);

    expect(mockApi.updateCard).not.toHaveBeenCalled();
    const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('Dry-run');
    expect(output).toContain('card-1');
  });

  it('filters cards and moves only matching ones', async () => {
    mockApi.listCards.mockResolvedValue([
      makeCard({ cardId: 'card-1', status: 'done' }),
      makeCard({ cardId: 'card-2', status: 'todo' }),
      makeCard({ cardId: 'card-3', status: 'done' }),
    ]);
    mockApi.updateCard.mockResolvedValue(makeCard());

    await program.parseAsync([
      'node', 'favro', 'batch', 'move',
      '--board', STUB_BOARD,
      '--status', 'Archive',
      '--filter', 'status:done',
    ]);

    // Should update card-1 and card-3 (Completed), not card-2 (Backlog)
    expect(mockApi.updateCard).toHaveBeenCalledTimes(2);
    expect(mockApi.updateCard).toHaveBeenCalledWith('card-1', expect.objectContaining({ status: 'Archive' }));
    expect(mockApi.updateCard).toHaveBeenCalledWith('card-3', expect.objectContaining({ status: 'Archive' }));
    expect(mockApi.updateCard).not.toHaveBeenCalledWith('card-2', expect.anything());
  });

  it('reports no matching cards gracefully', async () => {
    mockApi.listCards.mockResolvedValue([
      makeCard({ cardId: 'card-1', status: 'todo' }),
    ]);

    await program.parseAsync([
      'node', 'favro', 'batch', 'move',
      '--board', STUB_BOARD,
      '--status', 'Done',
      '--filter', 'status:done',
    ]);

    expect(mockApi.updateCard).not.toHaveBeenCalled();
    const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('No cards match');
  });

  it('exits with error when board not found (404)', async () => {
    const err: any = new Error('Not found');
    err.response = { status: 404 };
    mockApi.listCards.mockRejectedValue(err);

    await program.parseAsync([
      'node', 'favro', 'batch', 'move',
      '--board', 'bad-board',
      '--status', 'Done',
    ]);

    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Board not found'));
  });

  it('outputs JSON when --json flag used', async () => {
    mockApi.listCards.mockResolvedValue([
      makeCard({ cardId: 'card-1', status: 'done' }),
    ]);
    mockApi.updateCard.mockResolvedValue(makeCard({ cardId: 'card-1', status: 'Archive' }));

    await program.parseAsync([
      'node', 'favro', 'batch', 'move',
      '--board', STUB_BOARD,
      '--status', 'Archive',
      '--filter', 'status:done',
      '--json',
    ]);

    const jsonCall = consoleLogSpy.mock.calls.find(c => {
      try { JSON.parse(c[0]); return true; } catch { return false; }
    });
    expect(jsonCall).toBeTruthy();
    const output = JSON.parse(jsonCall![0]);
    expect(output).toHaveProperty('total');
    expect(output).toHaveProperty('success');
  });

  it('--json: first stdout call is parseable JSON with no progress messages (BLOCKER 3)', async () => {
    mockApi.listCards.mockResolvedValue([
      makeCard({ cardId: 'card-1', status: 'done' }),
    ]);
    mockApi.updateCard.mockResolvedValue(makeCard({ cardId: 'card-1', status: 'Archive' }));

    await program.parseAsync([
      'node', 'favro', 'batch', 'move',
      '--board', STUB_BOARD,
      '--status', 'Archive',
      '--filter', 'status:done',
      '--json',
    ]);

    // First stdout call MUST be parseable JSON (no "⚙ Moving..." prefix)
    expect(consoleLogSpy.mock.calls.length).toBeGreaterThan(0);
    const firstCall = consoleLogSpy.mock.calls[0][0];
    expect(() => JSON.parse(firstCall)).not.toThrow();
  });

  it('sends boardId field when --to-board is specified (BLOCKER 1)', async () => {
    mockApi.listCards.mockResolvedValue([
      makeCard({ cardId: 'card-1', status: 'done', boardId: 'board-src' }),
    ]);
    mockApi.updateCard.mockResolvedValue(makeCard({ cardId: 'card-1', boardId: 'board-dst' }));

    await program.parseAsync([
      'node', 'favro', 'batch', 'move',
      '--board', STUB_BOARD,
      '--to-board', 'board-dst',
      '--filter', 'status:done',
    ]);

    expect(mockApi.updateCard).toHaveBeenCalledWith(
      'card-1',
      expect.objectContaining({ boardId: 'board-dst' })
    );
  });

  it('captures boardId in previousState for move rollback (BLOCKER 5)', async () => {
    // card-1 succeeds, card-2 fails → rollback card-1 with boardId restored
    mockApi.listCards.mockResolvedValue([
      makeCard({ cardId: 'card-1', status: 'done', boardId: 'board-src' }),
      makeCard({ cardId: 'card-2', status: 'done', boardId: 'board-src' }),
    ]);
    mockApi.updateCard
      .mockResolvedValueOnce(makeCard({ cardId: 'card-1', boardId: 'board-dst' })) // card-1 succeeds
      .mockRejectedValueOnce(new Error('API error'))                                 // card-2 fails
      .mockResolvedValueOnce(makeCard({ cardId: 'card-1', boardId: 'board-src' })); // rollback

    await program.parseAsync([
      'node', 'favro', 'batch', 'move',
      '--board', STUB_BOARD,
      '--to-board', 'board-dst',
      '--filter', 'status:done',
    ]);

    // Rollback should restore boardId: board-src
    const rollbackCall = mockApi.updateCard.mock.calls[2]; // 3rd call is rollback
    expect(rollbackCall[1]).toMatchObject({ boardId: 'board-src' });
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// batch assign command
// ---------------------------------------------------------------------------

describe('batch assign command', () => {
  let program: Command;
  let mockApi: jest.Mocked<CardsAPI>;
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FAVRO_API_KEY = 'test-token';

    program = new Command();
    program.exitOverride();
    const batch = program.command('batch');
    registerBatchAssignCommand(batch);

    mockResolveApiKey.mockResolvedValue('test-token');

    const mockClient = new FavroHttpClient() as jest.Mocked<FavroHttpClient>;
    mockApi = new CardsAPI(mockClient) as jest.Mocked<CardsAPI>;
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => mockApi);

    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    delete process.env.FAVRO_API_KEY;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  it('dry-run shows preview without assigning', async () => {
    mockApi.listCards.mockResolvedValue([
      makeCard({ cardId: 'card-1', status: 'todo', assignees: [] }),
    ]);

    await program.parseAsync([
      'node', 'favro', 'batch', 'assign',
      '--board', STUB_BOARD,
      '--filter', 'status:todo',
      '--to', 'alice',
      '--dry-run',
    ]);

    expect(mockApi.updateCard).not.toHaveBeenCalled();
    const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('Dry-run');
    expect(output).toContain('card-1');
  });

  it('assigns matching cards to specified user', async () => {
    mockApi.listCards.mockResolvedValue([
      makeCard({ cardId: 'card-1', status: 'todo', assignees: [] }),
      makeCard({ cardId: 'card-2', status: 'Done', assignees: [] }),
    ]);
    mockApi.updateCard.mockResolvedValue(makeCard());

    await program.parseAsync([
      'node', 'favro', 'batch', 'assign',
      '--board', STUB_BOARD,
      '--filter', 'status:todo',
      '--to', 'alice',
    ]);

    // Only card-1 (Backlog) should be assigned
    expect(mockApi.updateCard).toHaveBeenCalledTimes(1);
    expect(mockApi.updateCard).toHaveBeenCalledWith('card-1', expect.objectContaining({ assignees: [ALICE] }));
  });

  it('skips cards already assigned to the target user', async () => {
    mockApi.listCards.mockResolvedValue([
      makeCard({ cardId: 'card-1', status: 'todo', assignees: [ALICE] }),
      makeCard({ cardId: 'card-2', status: 'todo', assignees: [] }),
    ]);
    mockApi.updateCard.mockResolvedValue(makeCard());

    await program.parseAsync([
      'node', 'favro', 'batch', 'assign',
      '--board', STUB_BOARD,
      '--filter', 'status:todo',
      '--to', 'alice',
    ]);

    // card-1 already assigned → skipped; card-2 gets assigned
    expect(mockApi.updateCard).toHaveBeenCalledTimes(1);
    expect(mockApi.updateCard).not.toHaveBeenCalledWith('card-1', expect.anything());
    expect(mockApi.updateCard).toHaveBeenCalledWith('card-2', expect.objectContaining({ assignees: [ALICE] }));
  });

  it('preserves existing assignees when assigning new user', async () => {
    mockApi.listCards.mockResolvedValue([
      makeCard({ cardId: 'card-1', status: 'todo', assignees: [BOB] }),
    ]);
    mockApi.updateCard.mockResolvedValue(makeCard());

    await program.parseAsync([
      'node', 'favro', 'batch', 'assign',
      '--board', STUB_BOARD,
      '--filter', 'status:todo',
      '--to', 'alice',
    ]);

    // Should include both bob AND alice
    expect(mockApi.updateCard).toHaveBeenCalledWith(
      'card-1',
      expect.objectContaining({ assignees: expect.arrayContaining([BOB, ALICE]) })
    );
  });

  it('handles no matching cards gracefully', async () => {
    mockApi.listCards.mockResolvedValue([
      makeCard({ cardId: 'card-1', status: 'Done', assignees: [] }),
    ]);

    await program.parseAsync([
      'node', 'favro', 'batch', 'assign',
      '--board', STUB_BOARD,
      '--filter', 'status:todo',
      '--to', 'alice',
    ]);

    expect(mockApi.updateCard).not.toHaveBeenCalled();
    const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('No cards match');
  });

  it('rolls back on failure and exits with code 1', async () => {
    mockApi.listCards.mockResolvedValue([
      makeCard({ cardId: 'card-1', status: 'todo', assignees: [] }),
      makeCard({ cardId: 'card-2', status: 'todo', assignees: [] }),
    ]);
    mockApi.updateCard
      .mockResolvedValueOnce(makeCard())
      .mockRejectedValueOnce(new Error('API error'))
      .mockResolvedValue(makeCard()); // rollback

    await program.parseAsync([
      'node', 'favro', 'batch', 'assign',
      '--board', STUB_BOARD,
      '--filter', 'status:todo',
      '--to', 'alice',
    ]);

    expect(processExitSpy).toHaveBeenCalledWith(1);
    // 2 attempts + 1 rollback
    expect(mockApi.updateCard).toHaveBeenCalledTimes(3);
  });

  it('exits with error when no API key', async () => {
    mockResolveApiKey.mockResolvedValue(undefined);

    await program.parseAsync([
      'node', 'favro', 'batch', 'assign',
      '--board', STUB_BOARD,
      '--to', 'alice',
    ]);

    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('--json: first stdout call is parseable JSON with no progress messages (BLOCKER 3)', async () => {
    mockApi.listCards.mockResolvedValue([
      makeCard({ cardId: 'card-1', status: 'todo', assignees: [] }),
    ]);
    mockApi.updateCard.mockResolvedValue(makeCard());

    await program.parseAsync([
      'node', 'favro', 'batch', 'assign',
      '--board', STUB_BOARD,
      '--filter', 'status:todo',
      '--to', 'alice',
      '--json',
    ]);

    // First stdout call MUST be parseable JSON (no "⚙ Assigning..." prefix)
    expect(consoleLogSpy.mock.calls.length).toBeGreaterThan(0);
    const firstCall = consoleLogSpy.mock.calls[0][0];
    expect(() => JSON.parse(firstCall)).not.toThrow();
    const parsed = JSON.parse(firstCall);
    expect(parsed).toHaveProperty('total');
    expect(parsed).toHaveProperty('success');
  });
});

// ---------------------------------------------------------------------------
// registerBatchCommand integration
// ---------------------------------------------------------------------------

describe('registerBatchCommand', () => {
  it('registers batch command with update/move/assign subcommands', () => {
    const program = new Command();
    registerBatchCommand(program);

    const batch = program.commands.find(c => c.name() === 'batch');
    expect(batch).toBeDefined();

    const subcommandNames = batch!.commands.map(c => c.name());
    expect(subcommandNames).toContain('update');
    expect(subcommandNames).toContain('move');
    expect(subcommandNames).toContain('assign');
  });
});
