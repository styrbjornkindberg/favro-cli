/**
 * Tests for `favro cards update` batch operations (CLA-1791 / FAVRO-029)
 *
 * Covers:
 *  - `favro cards update --from-csv bulk.csv` (CSV batch update)
 *  - `favro cards update --board Q2-Dev --label urgent --status done` (batch move)
 *  - `favro cards update --board Q2-Dev --assignee alice` (batch assign)
 *  - Dry-run mode
 *  - Atomic handling (failure → rollback)
 *  - Summary output
 */
import * as fsPromises from 'fs/promises';
import { buildProgram } from '../cli';
import { Command } from 'commander';
import CardsAPI, { Card } from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';
import * as config from '../lib/config';

jest.mock('../lib/cards-api');
jest.mock('../lib/http-client');
jest.mock('../lib/config');
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
    status: 'Backlog',
    assignees: [],
    tags: [],
    boardId: 'board-1',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

describe('favro cards update — batch operations (CLA-1791)', () => {
  let program: Command;
  let mockApi: jest.Mocked<CardsAPI>;
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FAVRO_API_KEY = 'test-token';

    mockResolveApiKey.mockResolvedValue('test-token');

    const mockClient = new FavroHttpClient() as jest.Mocked<FavroHttpClient>;
    mockApi = new CardsAPI(mockClient) as jest.Mocked<CardsAPI>;
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => mockApi);

    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    program = buildProgram();
    program.exitOverride();
  });

  afterEach(() => {
    delete process.env.FAVRO_API_KEY;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  // ─── --from-csv batch update ───────────────────────────────────────────────

  describe('--from-csv batch update', () => {
    it('calls updateCard for each CSV row', async () => {
      const csv = 'card_id,status\ncard-1,Done\ncard-2,In Progress';
      mockFsReadFile.mockResolvedValue(csv as any);
      mockApi.getCard.mockResolvedValue(makeCard());
      mockApi.updateCard.mockResolvedValue(makeCard({ cardId: 'card-1', status: 'Done' }));

      await program.parseAsync(['node', 'favro', 'cards', 'update', '--from-csv', 'bulk.csv']);

      expect(mockApi.updateCard).toHaveBeenCalledTimes(2);
      expect(mockApi.updateCard).toHaveBeenCalledWith('card-1', expect.objectContaining({ status: 'Done' }));
      expect(mockApi.updateCard).toHaveBeenCalledWith('card-2', expect.objectContaining({ status: 'In Progress' }));
    });

    it('supports camelCase CSV header aliases (cardId, assignee, dueDate)', async () => {
      const csv = 'cardId,assignee,dueDate\ncard-1,alice,2026-12-31';
      mockFsReadFile.mockResolvedValue(csv as any);
      mockApi.getCard.mockResolvedValue(makeCard({ cardId: 'card-1' }));
      mockApi.updateCard.mockResolvedValue(makeCard({ cardId: 'card-1' }));

      await program.parseAsync(['node', 'favro', 'cards', 'update', '--from-csv', 'bulk.csv']);

      expect(mockApi.updateCard).toHaveBeenCalledWith('card-1', expect.objectContaining({
        assignees: ['alice'],
        dueDate: '2026-12-31',
      }));
    });

    it('dry-run shows preview without calling updateCard', async () => {
      const csv = 'card_id,status\ncard-1,Done\ncard-2,In Progress';
      mockFsReadFile.mockResolvedValue(csv as any);

      await program.parseAsync(['node', 'favro', 'cards', 'update', '--from-csv', 'bulk.csv', '--dry-run']);

      expect(mockApi.updateCard).not.toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('Dry-run');
      expect(output).toContain('card-1');
    });

    it('exits with error when CSV file is missing', async () => {
      mockFsReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      await program.parseAsync(['node', 'favro', 'cards', 'update', '--from-csv', 'missing.csv']);

      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('exits with error for CSV missing card_id column', async () => {
      mockFsReadFile.mockResolvedValue('status,owner\nDone,alice' as any);

      await program.parseAsync(['node', 'favro', 'cards', 'update', '--from-csv', 'bad.csv']);

      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('validation errors'));
    });

    it('atomically rolls back on failure and exits 1', async () => {
      const csv = 'card_id,status\ncard-1,Done\ncard-2,Done';
      mockFsReadFile.mockResolvedValue(csv as any);
      mockApi.getCard.mockResolvedValue(makeCard({ status: 'Backlog' }));
      mockApi.updateCard
        .mockResolvedValueOnce(makeCard({ cardId: 'card-1', status: 'Done' })) // card-1 ok
        .mockRejectedValueOnce(new Error('API error'))                          // card-2 fails
        .mockResolvedValue(makeCard()); // rollback

      await program.parseAsync(['node', 'favro', 'cards', 'update', '--from-csv', 'bulk.csv']);

      // 2 attempts + 1 rollback
      expect(mockApi.updateCard).toHaveBeenCalledTimes(3);
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('outputs JSON when --json flag is used', async () => {
      const csv = 'card_id,status\ncard-1,Done';
      mockFsReadFile.mockResolvedValue(csv as any);
      mockApi.getCard.mockResolvedValue(makeCard({ cardId: 'card-1' }));
      mockApi.updateCard.mockResolvedValue(makeCard({ cardId: 'card-1', status: 'Done' }));

      await program.parseAsync(['node', 'favro', 'cards', 'update', '--from-csv', 'bulk.csv', '--json']);

      const jsonCall = consoleLogSpy.mock.calls.find((c) => {
        try { JSON.parse(c[0]); return true; } catch { return false; }
      });
      expect(jsonCall).toBeTruthy();
      const parsed = JSON.parse(jsonCall![0]);
      expect(parsed).toHaveProperty('total');
      expect(parsed).toHaveProperty('success');
    });

    it('shows summary: "Updated N/N cards"', async () => {
      const csv = 'card_id,status\ncard-1,Done\ncard-2,Done';
      mockFsReadFile.mockResolvedValue(csv as any);
      mockApi.getCard.mockResolvedValue(makeCard());
      mockApi.updateCard.mockResolvedValue(makeCard({ status: 'Done' }));

      await program.parseAsync(['node', 'favro', 'cards', 'update', '--from-csv', 'bulk.csv']);

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join('\n');
      // Bulk summary should show success count
      expect(output).toMatch(/Success|success/);
    });

    it('validates due_date format in CSV', async () => {
      mockFsReadFile.mockResolvedValue('card_id,due_date\ncard-1,04/01/2026' as any);

      await program.parseAsync(['node', 'favro', 'cards', 'update', '--from-csv', 'bulk.csv']);

      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ─── batch move with filter (--board + --label + --status) ────────────────

  describe('--board batch move/assign', () => {
    it('updates all matching cards when --board + --status given', async () => {
      mockApi.listCards.mockResolvedValue([
        makeCard({ cardId: 'card-1', status: 'Backlog', tags: ['urgent'] }),
        makeCard({ cardId: 'card-2', status: 'Done', tags: ['urgent'] }),
        makeCard({ cardId: 'card-3', status: 'Backlog', tags: ['low'] }),
      ]);
      mockApi.updateCard.mockResolvedValue(makeCard({ status: 'done' }));

      await program.parseAsync([
        'node', 'favro', 'cards', 'update',
        '--board', 'Q2-Dev',
        '--label', 'urgent',
        '--status', 'done',
      ]);

      // Only card-1 matches (status:Backlog AND tag:urgent) — card-2 is Done, card-3 is low
      // Wait, --status in a batch filter would match cards with that status...
      // Actually our filter logic: --label + --status filter _which cards to update_
      // But the acceptance criteria says "batch move --board Q2-Dev --label urgent --status done"
      // means "set status to done for cards with label urgent"
      // The filter: label:urgent → card-1 (Backlog,urgent) and card-2 (Done,urgent)
      // Both get status set to "done"
      expect(mockApi.updateCard).toHaveBeenCalledTimes(2);
      expect(mockApi.updateCard).toHaveBeenCalledWith('card-1', expect.objectContaining({ status: 'done' }));
      expect(mockApi.updateCard).toHaveBeenCalledWith('card-2', expect.objectContaining({ status: 'done' }));
      expect(mockApi.updateCard).not.toHaveBeenCalledWith('card-3', expect.anything());
    });

    it('assigns all matching cards when --board + --assignee given', async () => {
      mockApi.listCards.mockResolvedValue([
        makeCard({ cardId: 'card-1', status: 'Backlog', assignees: [] }),
        makeCard({ cardId: 'card-2', status: 'Done', assignees: ['alice'] }),
      ]);
      mockApi.updateCard.mockResolvedValue(makeCard());

      await program.parseAsync([
        'node', 'favro', 'cards', 'update',
        '--board', 'Q2-Dev',
        '--assignee', 'alice',
      ]);

      // card-1 gets assigned (not already assigned); card-2 is skipped
      expect(mockApi.updateCard).toHaveBeenCalledTimes(1);
      expect(mockApi.updateCard).toHaveBeenCalledWith('card-1', expect.objectContaining({
        assignees: expect.arrayContaining(['alice']),
      }));
    });

    it('dry-run batch move shows preview without updating', async () => {
      mockApi.listCards.mockResolvedValue([
        makeCard({ cardId: 'card-1', status: 'Backlog', tags: ['urgent'] }),
      ]);

      await program.parseAsync([
        'node', 'favro', 'cards', 'update',
        '--board', 'Q2-Dev',
        '--label', 'urgent',
        '--status', 'done',
        '--dry-run',
      ]);

      expect(mockApi.updateCard).not.toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('Dry-run');
    });

    it('reports no matching cards gracefully', async () => {
      mockApi.listCards.mockResolvedValue([
        makeCard({ cardId: 'card-1', status: 'Done', tags: [] }),
      ]);

      await program.parseAsync([
        'node', 'favro', 'cards', 'update',
        '--board', 'Q2-Dev',
        '--label', 'urgent',
        '--status', 'done',
      ]);

      expect(mockApi.updateCard).not.toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('No cards match');
    });

    it('exits with error when board not found (404)', async () => {
      const err: any = new Error('Not found');
      err.response = { status: 404 };
      mockApi.listCards.mockRejectedValue(err);

      await program.parseAsync([
        'node', 'favro', 'cards', 'update',
        '--board', 'bad-board',
        '--status', 'Done',
      ]);

      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('JSON output for batch move is parseable', async () => {
      mockApi.listCards.mockResolvedValue([
        makeCard({ cardId: 'card-1', status: 'Backlog', tags: ['urgent'] }),
      ]);
      mockApi.updateCard.mockResolvedValue(makeCard({ status: 'Done' }));

      await program.parseAsync([
        'node', 'favro', 'cards', 'update',
        '--board', 'Q2-Dev',
        '--label', 'urgent',
        '--status', 'done',
        '--json',
      ]);

      const jsonCall = consoleLogSpy.mock.calls.find((c) => {
        try { JSON.parse(c[0]); return true; } catch { return false; }
      });
      expect(jsonCall).toBeTruthy();
      const parsed = JSON.parse(jsonCall![0]);
      expect(parsed).toHaveProperty('total');
      expect(parsed).toHaveProperty('success');
    });
  });

  // ─── single card update (regression — existing behaviour preserved) ────────

  describe('single card update (regression)', () => {
    it('still works: favro cards update <cardId> --status Done', async () => {
      mockApi.updateCard.mockResolvedValue(makeCard({ cardId: 'card-x', status: 'Done' }));

      await program.parseAsync([
        'node', 'favro', 'cards', 'update', 'card-x',
        '--status', 'Done',
      ]);

      expect(mockApi.updateCard).toHaveBeenCalledWith('card-x', { status: 'Done' });
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('✓ Card updated: card-x');
    });

    it('still works: --dry-run on single card', async () => {
      await program.parseAsync([
        'node', 'favro', 'cards', 'update', 'card-x',
        '--status', 'Done',
        '--dry-run',
      ]);

      expect(mockApi.updateCard).not.toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('[dry-run]');
      expect(output).toContain('card-x');
    });

    it('errors when no cardId and no batch flags provided', async () => {
      await program.parseAsync([
        'node', 'favro', 'cards', 'update',
        '--status', 'Done',
      ]);

      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });
});
