/**
 * Unit tests — favro who-changed command
 * CLA-1802: FAVRO-040: Audit & Change Log Commands
 */
import { Command } from 'commander';
import { registerWhoChangedCommand } from '../../commands/favro-who-changed';
import FavroHttpClient from '../../lib/http-client';
import * as config from '../../lib/config';
import { Card } from '../../lib/cards-api';

jest.mock('../../lib/audit-api', () => {
  const actual = jest.requireActual('../../lib/audit-api');
  const getCardHistory = jest.fn();
  const getBoardAuditLog = jest.fn();
  const getCardActivity = jest.fn();
  class MockAuditAPI {
    getCardHistory = getCardHistory;
    getBoardAuditLog = getBoardAuditLog;
    getCardActivity = getCardActivity;
    static __mocks = { getCardHistory, getBoardAuditLog, getCardActivity };
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
const mockGetCardHistory: jest.Mock = auditMocks.getCardHistory;

const sampleCard: Card = {
  cardId: 'card-login',
  name: 'Fix login bug',
  status: 'Done',
  assignees: ['alice'],
  tags: ['bug'],
  createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
  updatedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
};

const sampleEntries = [
  {
    cardId: 'card-login',
    cardName: 'Fix login bug',
    changeType: 'status-change',
    description: 'Status changed from "In Progress" to "Done"',
    author: 'alice',
    timestamp: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
  },
  {
    cardId: 'card-login',
    cardName: 'Fix login bug',
    changeType: 'created',
    description: 'Card "Fix login bug" was created',
    author: 'bob',
    timestamp: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
  },
];

function buildProgram(): Command {
  (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({} as any));
  const program = new Command();
  program.exitOverride();
  registerWhoChangedCommand(program);
  return program;
}

describe('favro who-changed command', () => {
  let exitSpy: jest.SpyInstance;
  let consoleSpy: jest.SpyInstance;
  let consoleErrSpy: jest.SpyInstance;

  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
    // Reset and set default for mock fn
    mockGetCardHistory.mockReset();
    mockGetCardHistory.mockResolvedValue([{ card: sampleCard, entries: sampleEntries }]);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });

  it('calls getCardHistory with card title', async () => {
    const program = buildProgram();
    await program.parseAsync(['who-changed', 'Fix login bug'], { from: 'user' });
    expect(mockGetCardHistory).toHaveBeenCalledWith('Fix login bug', undefined, 200);
  });

  it('passes --board option to getCardHistory', async () => {
    const program = buildProgram();
    await program.parseAsync(['who-changed', 'Fix login bug', '--board', 'board-123'], { from: 'user' });
    expect(mockGetCardHistory).toHaveBeenCalledWith('Fix login bug', 'board-123', 200);
  });

  it('respects --limit option', async () => {
    const program = buildProgram();
    await program.parseAsync(['who-changed', 'login', '--limit', '50'], { from: 'user' });
    expect(mockGetCardHistory).toHaveBeenCalledWith('login', undefined, 50);
  });

  it('displays card title, author, and timestamp in output', async () => {
    const program = buildProgram();
    await program.parseAsync(['who-changed', 'Fix login bug'], { from: 'user' });

    const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('Fix login bug');
    expect(output).toContain('card-login');
    expect(output).toContain('alice');
    expect(output).toContain('STATUS-CHANGE');
  });

  it('displays relative and absolute timestamps', async () => {
    const program = buildProgram();
    await program.parseAsync(['who-changed', 'Fix login bug'], { from: 'user' });

    const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
    // Relative
    expect(output).toMatch(/hour ago|hours ago|minutes ago|days ago/);
    // Absolute (ISO 8601)
    expect(output).toMatch(/\(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('outputs JSON when --json flag is set', async () => {
    const program = buildProgram();
    await program.parseAsync(['who-changed', 'Fix login bug', '--json'], { from: 'user' });

    const jsonCall = consoleSpy.mock.calls.find(call => call[0]?.startsWith('['));
    expect(jsonCall).toBeDefined();
    const parsed = JSON.parse(jsonCall![0]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].card.cardId).toBe('card-login');
    expect(parsed[0].history).toHaveLength(2);
  });

  it('exits with error when card not found', async () => {
    mockGetCardHistory.mockResolvedValue([]);
    const program = buildProgram();

    await expect(
      program.parseAsync(['who-changed', 'nonexistent card'], { from: 'user' })
    ).rejects.toThrow('process.exit');

    expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining('No cards found matching'));
  });

  it('exits with error when API key is missing', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);
    const program = buildProgram();

    await expect(
      program.parseAsync(['who-changed', 'Fix login bug'], { from: 'user' })
    ).rejects.toThrow('process.exit');

    expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining('Error:'));
  });

  it('shows "no change history" message when card has empty entries', async () => {
    mockGetCardHistory.mockResolvedValue([{ card: sampleCard, entries: [] }]);
    const program = buildProgram();
    await program.parseAsync(['who-changed', 'Fix login bug'], { from: 'user' });

    const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('No change history available');
  });

  it('shows count message when multiple cards match', async () => {
    mockGetCardHistory.mockResolvedValue([
      { card: sampleCard, entries: sampleEntries },
      {
        card: { ...sampleCard, cardId: 'card-login-2', name: 'Fix login bug v2' },
        entries: sampleEntries,
      },
    ]);
    const program = buildProgram();
    await program.parseAsync(['who-changed', 'login'], { from: 'user' });

    const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('2 card(s) matched');
  });
});
