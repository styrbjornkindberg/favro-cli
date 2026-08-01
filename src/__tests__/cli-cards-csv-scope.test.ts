/**
 * `favro cards update --from-csv` must take the scope lock (#79).
 *
 * The help topic ("NOT EVERY WRITE IS A SAGA") promises that `cards update`
 * takes the same scope lock as every other write. The CSV path used to skip it
 * entirely, so the same command was locked on one branch and wide open on the
 * other. These tests pin the promise: the lock is consulted for every distinct
 * target board, before the first write, and a batch that straddles it refuses
 * as a whole.
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
  checkScope: jest.fn(async () => {}),
}));

const mockResolveApiKey = config.resolveApiKey as jest.MockedFunction<typeof config.resolveApiKey>;
const mockReadConfig = config.readConfig as jest.MockedFunction<typeof config.readConfig>;
const mockFsReadFile = fsPromises.readFile as jest.MockedFunction<typeof fsPromises.readFile>;
const mockCheckScope = safety.checkScope as jest.MockedFunction<typeof safety.checkScope>;

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
    mockCheckScope.mockImplementation(async (boardId: string) => {
      calls.push(`scope:${boardId}`);
    });
    mockApi.updateCard.mockImplementation(async (cardId: string) => {
      calls.push(`write:${cardId}`);
      return makeCard({ cardId });
    });

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

  it('consults the scope lock for the resolved board before any write', async () => {
    mockFsReadFile.mockResolvedValue('card_id,status\ncard-1,Done' as any);
    mockApi.getCard.mockResolvedValue(makeCard({ cardId: 'card-1', boardId: 'board-A' }));

    await program.parseAsync(['node', 'favro', 'cards', 'update', '--from-csv', 'bulk.csv']);

    expect(mockCheckScope).toHaveBeenCalledWith('board-A', expect.anything(), LOCKED_CONFIG, undefined);
    expect(calls).toEqual(['scope:board-A', 'write:card-1']);
  });

  it('checks every distinct board a multi-board CSV touches', async () => {
    mockFsReadFile.mockResolvedValue('card_id,status\ncard-1,Done\ncard-2,Done\ncard-3,Done' as any);
    mockApi.getCard.mockImplementation(async (cardId: string) =>
      makeCard({ cardId, boardId: cardId === 'card-3' ? 'board-B' : 'board-A' })
    );

    await program.parseAsync(['node', 'favro', 'cards', 'update', '--from-csv', 'bulk.csv']);

    const scoped = mockCheckScope.mock.calls.map((c) => c[0]);
    expect(scoped).toEqual(['board-A', 'board-B']);
    expect(calls.slice(0, 2)).toEqual(['scope:board-A', 'scope:board-B']);
  });

  it('refuses the WHOLE batch with zero writes when one row is out of scope', async () => {
    mockFsReadFile.mockResolvedValue('card_id,status\ncard-1,Done\ncard-2,Done' as any);
    mockApi.getCard.mockImplementation(async (cardId: string) =>
      makeCard({ cardId, boardId: cardId === 'card-2' ? 'board-OUTSIDE' : 'board-A' })
    );
    mockCheckScope.mockImplementation(async (boardId: string) => {
      calls.push(`scope:${boardId}`);
      if (boardId === 'board-OUTSIDE') throw new Error('Scope violation');
    });

    await program.parseAsync(['node', 'favro', 'cards', 'update', '--from-csv', 'bulk.csv']);

    expect(mockApi.updateCard).not.toHaveBeenCalled();
    expect(calls).toEqual(['scope:board-A', 'scope:board-OUTSIDE']);
  });

  it('fails closed when a row card cannot be fetched (board unresolved)', async () => {
    mockFsReadFile.mockResolvedValue('card_id,status\ncard-1,Done' as any);
    mockApi.getCard.mockRejectedValue(new Error('404'));

    await program.parseAsync(['node', 'favro', 'cards', 'update', '--from-csv', 'bulk.csv']);

    // An unfetchable card must reach the shared check as an empty boardId, not
    // be quietly skipped — #77 makes the empty string an explicit refusal.
    expect(mockCheckScope).toHaveBeenCalledWith('', expect.anything(), LOCKED_CONFIG, undefined);
  });

  it('names the unreadable row and the real fetch error instead of swallowing it', async () => {
    mockFsReadFile.mockResolvedValue('card_id,status\ncard-1,Done' as any);
    mockApi.getCard.mockRejectedValue(new Error('404 Not Found'));

    await program.parseAsync(['node', 'favro', 'cards', 'update', '--from-csv', 'bulk.csv']);

    const stderr = (console.error as jest.Mock).mock.calls.map((c) => String(c[0])).join('\n');
    expect(stderr).toContain('card-1');
    expect(stderr).toContain('404 Not Found');
  });

  it('forwards --force to the scope check', async () => {
    mockFsReadFile.mockResolvedValue('card_id,status\ncard-1,Done' as any);
    mockApi.getCard.mockResolvedValue(makeCard({ cardId: 'card-1', boardId: 'board-A' }));

    await program.parseAsync(['node', 'favro', 'cards', 'update', '--from-csv', 'bulk.csv', '--force']);

    expect(mockCheckScope).toHaveBeenCalledWith('board-A', expect.anything(), LOCKED_CONFIG, true);
  });

  it('leaves the dry-run preview alone — no GETs, no scope check', async () => {
    mockFsReadFile.mockResolvedValue('card_id,status\ncard-1,Done' as any);

    await program.parseAsync(['node', 'favro', 'cards', 'update', '--from-csv', 'bulk.csv', '--dry-run']);

    expect(mockApi.getCard).not.toHaveBeenCalled();
    expect(mockCheckScope).not.toHaveBeenCalled();
    expect(mockApi.updateCard).not.toHaveBeenCalled();
  });
});
