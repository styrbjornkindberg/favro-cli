/**
 * Unit tests — favro audit command
 * CLA-1802: FAVRO-040: Audit & Change Log Commands
 */
import { Command } from 'commander';
import { registerAuditCommand } from '../../commands/favro-audit';
import FavroHttpClient from '../../lib/http-client';
import * as config from '../../lib/config';

// Use a plain spy on AuditAPI — replace prototype method with jest.fn
// so tests can override per-test via mockResolvedValue etc.
jest.mock('../../lib/audit-api', () => {
  const actual = jest.requireActual('../../lib/audit-api');
  const getBoardAuditLog = jest.fn();
  const getCardActivity = jest.fn();
  const getCardHistory = jest.fn();
  class MockAuditAPI {
    getBoardAuditLog = getBoardAuditLog;
    getCardActivity = getCardActivity;
    getCardHistory = getCardHistory;
    static __mocks = { getBoardAuditLog, getCardActivity, getCardHistory };
  }
  return {
    __esModule: true,  // required so esModuleInterop treats this as an ES module
    ...actual,
    default: MockAuditAPI,
    AuditAPI: MockAuditAPI,
    __mocks: MockAuditAPI.__mocks,
  };
});
jest.mock('../../lib/http-client');
jest.mock('../../lib/config');

// Access the mock fns from the mocked module
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mocks: auditMocks } = require('../../lib/audit-api');
const mockGetBoardAuditLog: jest.Mock = auditMocks.getBoardAuditLog;

const sampleEntries = [
  {
    cardId: 'card-1',
    cardName: 'Fix login bug',
    changeType: 'updated',
    description: 'Card "Fix login bug" was updated',
    author: 'alice',
    timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago
  },
  {
    cardId: 'card-2',
    cardName: 'Add feature',
    changeType: 'created',
    description: 'Card "Add feature" was created',
    author: 'bob',
    timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
  },
];

function buildProgram(): Command {
  (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({} as any));
  const program = new Command();
  program.exitOverride();
  registerAuditCommand(program);
  return program;
}

describe('favro audit command', () => {
  let exitSpy: jest.SpyInstance;
  let consoleSpy: jest.SpyInstance;
  let consoleErrSpy: jest.SpyInstance;

  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
    // Reset and set default for mock fn
    mockGetBoardAuditLog.mockReset();
    mockGetBoardAuditLog.mockResolvedValue(sampleEntries);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });

  it('calls getBoardAuditLog with board ID', async () => {
    const program = buildProgram();
    await program.parseAsync(['audit', 'board-123'], { from: 'user' });
    expect(mockGetBoardAuditLog).toHaveBeenCalledWith('board-123', undefined, 500);
  });

  it('passes since date when --since is provided (1h)', async () => {
    const program = buildProgram();
    const before = Date.now();
    await program.parseAsync(['audit', 'board-123', '--since', '1h'], { from: 'user' });
    const after = Date.now();

    const callArgs = mockGetBoardAuditLog.mock.calls[0];
    const since: Date = callArgs[1];
    expect(since).toBeInstanceOf(Date);
    const expectedMs = 60 * 60 * 1000;
    expect(before - since.getTime()).toBeGreaterThanOrEqual(expectedMs - 100);
    expect(after - since.getTime()).toBeLessThanOrEqual(expectedMs + 100);
  });

  it('passes since date for 1d', async () => {
    const program = buildProgram();
    const before = Date.now();
    await program.parseAsync(['audit', 'board-123', '--since', '1d'], { from: 'user' });
    const after = Date.now();

    const since: Date = mockGetBoardAuditLog.mock.calls[0][1];
    const expectedMs = 24 * 60 * 60 * 1000;
    expect(before - since.getTime()).toBeGreaterThanOrEqual(expectedMs - 100);
    expect(after - since.getTime()).toBeLessThanOrEqual(expectedMs + 100);
  });

  it('passes since date for 1w', async () => {
    const program = buildProgram();
    const before = Date.now();
    await program.parseAsync(['audit', 'board-123', '--since', '1w'], { from: 'user' });
    const after = Date.now();

    const since: Date = mockGetBoardAuditLog.mock.calls[0][1];
    const expectedMs = 7 * 24 * 60 * 60 * 1000;
    expect(before - since.getTime()).toBeGreaterThanOrEqual(expectedMs - 100);
    expect(after - since.getTime()).toBeLessThanOrEqual(expectedMs + 100);
  });

  it('outputs JSON when --json flag is set', async () => {
    const program = buildProgram();
    await program.parseAsync(['audit', 'board-123', '--json'], { from: 'user' });

    const jsonOutput = consoleSpy.mock.calls.find(call =>
      call[0] && call[0].startsWith('[')
    );
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse(jsonOutput![0]);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
  });

  it('shows "no entries found" when board has no changes', async () => {
    mockGetBoardAuditLog.mockResolvedValue([]);
    const program = buildProgram();
    await program.parseAsync(['audit', 'board-empty'], { from: 'user' });

    const output = consoleSpy.mock.calls.map(c => c[0]).join(' ');
    expect(output).toContain('No audit entries found');
  });

  it('exits with error when API key is missing', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);
    const program = buildProgram();

    await expect(
      program.parseAsync(['audit', 'board-123'], { from: 'user' })
    ).rejects.toThrow('process.exit');

    expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining('Error:'));
  });

  it('exits with error for invalid --since value', async () => {
    const program = buildProgram();

    await expect(
      program.parseAsync(['audit', 'board-123', '--since', 'bad'], { from: 'user' })
    ).rejects.toThrow('process.exit');

    expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid --since value'));
  });

  it('respects --limit option', async () => {
    const program = buildProgram();
    await program.parseAsync(['audit', 'board-123', '--limit', '10'], { from: 'user' });
    expect(mockGetBoardAuditLog).toHaveBeenCalledWith('board-123', undefined, 10);
  });

  it('paginates output for large result sets', async () => {
    // Create 150 entries
    const manyEntries = Array.from({ length: 150 }, (_, i) => ({
      cardId: `card-${i}`,
      cardName: `Card ${i}`,
      changeType: 'updated',
      description: `Card ${i} was updated`,
      timestamp: new Date(Date.now() - i * 60_000).toISOString(),
    }));
    mockGetBoardAuditLog.mockResolvedValue(manyEntries);

    const program = buildProgram();
    await program.parseAsync(['audit', 'board-123', '--page-size', '100'], { from: 'user' });

    const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('Page 1 / 2');
    expect(output).toContain('Page 2 / 2');
    expect(output).toContain('Total: 150 change(s) shown.');
  });

  it('displays relative and absolute timestamp in output', async () => {
    const program = buildProgram();
    await program.parseAsync(['audit', 'board-123'], { from: 'user' });

    const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
    // Relative time
    expect(output).toMatch(/minutes ago|hours ago|just now/);
    // Absolute time (ISO 8601 format in parens)
    expect(output).toMatch(/\(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
