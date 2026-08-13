/**
 * `favro cards update --from-csv` must take the scope lock (#79), and since #110
 * it takes it the same way every other card write does — inside the `update`
 * intent, through `assertScope`, over EVERY distinct board the file touches.
 *
 * The promise is unchanged and so are these arms; what moved is which helper is
 * asked. The CLI used to build its own `Set` of boards and loop `checkScope`
 * over it before constructing a `BulkTransaction`. That loop is deleted: the
 * intent's `board()` returns every entry's board, the table de-duplicates and
 * checks them all before the first write, and a batch that straddles the lock
 * refuses as a whole.
 *
 * The lock's own semantics are pinned against a real socket in
 * `cards-update-intent-wire.test.ts`. What is CSV-specific, and lives here: that
 * a file of N rows reaches the lock as one batch of N boards rather than N
 * separate transactions, and that `--force` and `--dry-run` behave at this
 * command exactly as #103 settled.
 */
import * as fsPromises from 'fs/promises';
import { buildProgram } from '../cli';
import { Command } from 'commander';
import CardsAPI, { Card } from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';
import * as config from '../lib/config';
import * as safety from '../lib/safety';

jest.mock('../lib/cards-api');
jest.mock('../lib/http-client');
jest.mock('../lib/config');
jest.mock('fs/promises');
jest.mock('../lib/safety', () => ({
  confirmAction: jest.fn(async () => true),
  assertScope: jest.fn(async () => {}),
}));

const mockResolveApiKey = config.resolveApiKey as jest.MockedFunction<typeof config.resolveApiKey>;
const mockReadConfig = config.readConfig as jest.MockedFunction<typeof config.readConfig>;
const mockFsReadFile = fsPromises.readFile as jest.MockedFunction<typeof fsPromises.readFile>;
const mockAssertScope = safety.assertScope as jest.MockedFunction<typeof safety.assertScope>;

const LOCKED_CONFIG = {
  scopeCollectionId: 'col-locked',
  scopeCollectionName: 'Locked',
} as any;

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    cardId: 'card-default',
    name: 'Default Card',
    status: 'Backlog',
    assignees: [],
    tags: [],
    boardId: 'board-1',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('cards update --from-csv — scope lock (#79)', () => {
  let program: Command;
  let mockApi: jest.Mocked<CardsAPI>;
  let calls: string[];

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FAVRO_API_KEY = 'test-token';
    mockResolveApiKey.mockResolvedValue('test-token');
    mockReadConfig.mockResolvedValue(LOCKED_CONFIG);

    const mockClient = new FavroHttpClient() as jest.Mocked<FavroHttpClient>;
    mockApi = new CardsAPI(mockClient) as jest.Mocked<CardsAPI>;
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => mockApi);

    calls = [];
    // `clearAllMocks` clears calls, not implementations: an arm that makes the
    // lock reject would otherwise leak into every arm after it.
    mockAssertScope.mockImplementation(async (boardId: string) => {
      calls.push(`scope:${boardId}`);
    });
    mockApi.resolveColumnId.mockImplementation(async (name: string) => `col-${name}`);

    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    program = buildProgram();
    program.exitOverride();
  });

  afterEach(() => {
    delete process.env.FAVRO_API_KEY;
    jest.restoreAllMocks();
  });

  /** A stand that answers writes back, so `moveColumn`'s confirming read passes. */
  function seed(boardOf: (cardId: string) => string): void {
    const store = new Map<string, Card>();
    mockApi.getCard.mockImplementation(async (cardId: string) => {
      if (!store.has(cardId)) store.set(cardId, makeCard({ cardId, boardId: boardOf(cardId) }));
      return store.get(cardId)!;
    });
    mockApi.updateCard.mockImplementation(async (cardId: string, data: any) => {
      calls.push(`write:${cardId}`);
      const next = { ...store.get(cardId)!, ...data } as Card;
      store.set(cardId, next);
      return next;
    });
  }

  it('consults the scope lock for the resolved board before any write', async () => {
    mockFsReadFile.mockResolvedValue('card_id,status\ncard-1,Done' as any);
    seed(() => 'board-A');

    await program.parseAsync(['node', 'favro', '--human', 'cards', 'update', '--from-csv', 'bulk.csv']);

    expect(mockAssertScope).toHaveBeenCalledWith('board-A', expect.anything(), LOCKED_CONFIG, undefined);
    expect(calls).toEqual(['scope:board-A', 'write:card-1']);
  });

  it('checks every distinct board a multi-board CSV touches', async () => {
    mockFsReadFile.mockResolvedValue('card_id,status\ncard-1,Done\ncard-2,Done\ncard-3,Done' as any);
    seed((cardId) => (cardId === 'card-3' ? 'board-B' : 'board-A'));

    await program.parseAsync(['node', 'favro', '--human', 'cards', 'update', '--from-csv', 'bulk.csv']);

    expect(mockAssertScope.mock.calls.map((c) => c[0])).toEqual(['board-A', 'board-B']);
    expect(calls.slice(0, 2)).toEqual(['scope:board-A', 'scope:board-B']);
  });

  it('two rows on the same board collapse to ONE check', async () => {
    mockFsReadFile.mockResolvedValue('card_id,status\ncard-1,Done\ncard-2,Done' as any);
    seed(() => 'board-A');

    await program.parseAsync(['node', 'favro', '--human', 'cards', 'update', '--from-csv', 'bulk.csv']);

    expect(mockAssertScope.mock.calls.map((c) => c[0])).toEqual(['board-A']);
  });

  it('refuses the WHOLE batch with zero writes when one row is out of scope', async () => {
    mockFsReadFile.mockResolvedValue('card_id,status\ncard-1,Done\ncard-2,Done' as any);
    seed((cardId) => (cardId === 'card-2' ? 'board-OUTSIDE' : 'board-A'));
    mockAssertScope.mockImplementation(async (boardId: string) => {
      calls.push(`scope:${boardId}`);
      if (boardId === 'board-OUTSIDE') throw new Error('Scope violation');
    });

    await program.parseAsync(['node', 'favro', '--human', 'cards', 'update', '--from-csv', 'bulk.csv']);

    expect(mockApi.updateCard).not.toHaveBeenCalled();
    expect(calls).toEqual(['scope:board-A', 'scope:board-OUTSIDE']);
  });

  it('fails closed when a row card cannot be fetched', async () => {
    mockFsReadFile.mockResolvedValue('card_id,status\ncard-1,Done' as any);
    mockApi.getCard.mockRejectedValue(new Error('404 Not Found'));

    await program.parseAsync(['node', 'favro', '--human', 'cards', 'update', '--from-csv', 'bulk.csv']);

    // The intent makes the read itself, so an unreadable row is the wire's own
    // error rather than an empty boardId handed to the check — and it names the
    // real problem instead of "this write names no board". Nothing is written
    // either way, which is the property #79 bought.
    expect(mockApi.updateCard).not.toHaveBeenCalled();
    const stderr = (console.error as jest.Mock).mock.calls.map((c) => String(c[0])).join('\n');
    expect(stderr).toContain('404 Not Found');
  });

  it('forwards --force to the scope check', async () => {
    mockFsReadFile.mockResolvedValue('card_id,status\ncard-1,Done' as any);
    seed(() => 'board-A');

    await program.parseAsync([
      'node', 'favro', '--human', 'cards', 'update', '--from-csv', 'bulk.csv', '--force',
    ]);

    expect(mockAssertScope).toHaveBeenCalledWith('board-A', expect.anything(), LOCKED_CONFIG, true);
  });

  /**
   * The dry-run arm of the same path must take the lock too (#103).
   *
   * `dispatch.ts` runs its scope loop before the `dryRun` return. This branch
   * used to be the exception: it resolved no boards and checked nothing, so a
   * preview happily printed "would update CLA-999" for a card the real run
   * refuses.
   */
  describe('--dry-run under a lock', () => {
    it('checks the resolved board BEFORE printing the preview', async () => {
      mockFsReadFile.mockResolvedValue('card_id,status\ncard-1,Done' as any);
      seed(() => 'board-A');
      (console.log as jest.Mock).mockImplementation((line?: any) => {
        calls.push(`print:${String(line).slice(0, 20)}`);
      });

      await program.parseAsync([
        'node', 'favro', '--human', 'cards', 'update', '--from-csv', 'bulk.csv', '--dry-run',
      ]);

      expect(mockAssertScope).toHaveBeenCalledWith('board-A', expect.anything(), LOCKED_CONFIG, undefined);
      expect(calls[0]).toBe('scope:board-A');
      expect(calls.some((c) => c.startsWith('print:'))).toBe(true);
      expect(calls.some((c) => c.startsWith('write:'))).toBe(false);
    });

    it('an out-of-scope row refuses in dry-run, with no preview and no writes', async () => {
      mockFsReadFile.mockResolvedValue('card_id,status\ncard-1,Done' as any);
      seed(() => 'board-OUTSIDE');
      mockAssertScope.mockImplementation(async (boardId: string) => {
        calls.push(`scope:${boardId}`);
        throw new Error('Scope violation');
      });
      (console.log as jest.Mock).mockImplementation((line?: any) => {
        calls.push(`print:${String(line).slice(0, 20)}`);
      });

      await program.parseAsync([
        'node', 'favro', '--human', 'cards', 'update', '--from-csv', 'bulk.csv', '--dry-run',
      ]);

      expect(mockApi.updateCard).not.toHaveBeenCalled();
      expect(calls.filter((c) => c.startsWith('print:'))).toEqual([]);
    });

    it('forwards --force on the dry-run path too', async () => {
      mockFsReadFile.mockResolvedValue('card_id,status\ncard-1,Done' as any);
      seed(() => 'board-A');

      await program.parseAsync([
        'node', 'favro', '--human', 'cards', 'update', '--from-csv', 'bulk.csv', '--dry-run', '--force',
      ]);

      expect(mockAssertScope).toHaveBeenCalledWith('board-A', expect.anything(), LOCKED_CONFIG, true);
    });
  });
});
