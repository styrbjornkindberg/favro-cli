/**
 * Tests for release-check command
 * FAVRO-038: Release Check & Risk Dashboard
 */
import { Command } from 'commander';
import { registerReleaseCheckCommand } from '../../commands/release-check';
import CardsAPI, { Card } from '../../lib/cards-api';
import FavroHttpClient from '../../lib/http-client';
import * as config from '../../lib/config';
import BoardsAPI from '../../lib/boards-api';

jest.mock('../../lib/cards-api');
jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../lib/boards-api');

const sampleCards: Card[] = [
  {
    cardId: 'card-1',
    name: 'Feature A',
    status: 'Done',
    assignees: ['alice'],
    tags: [],
    dueDate: '2026-03-20',
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-15T00:00:00Z',
  },
  {
    cardId: 'card-2',
    name: 'Feature B',
    status: 'Review',
    assignees: ['bob'],
    tags: [],
    dueDate: '2026-03-25',
    createdAt: '2026-03-02T00:00:00Z',
    updatedAt: '2026-03-16T00:00:00Z',
  },
  {
    cardId: 'card-3',
    name: 'Feature C',
    status: 'Review',
    assignees: [], // Missing assignees
    tags: [],
    dueDate: '2026-03-30',
    createdAt: '2026-03-03T00:00:00Z',
    updatedAt: '2026-03-17T00:00:00Z',
  },
  {
    cardId: 'card-4',
    name: 'Feature D',
    status: 'Done',
    assignees: ['charlie'],
    tags: ['blocked'], // Blocked
    dueDate: undefined,
    createdAt: '2026-03-04T00:00:00Z',
    updatedAt: '2026-03-18T00:00:00Z',
  },
  {
    cardId: 'card-5',
    name: 'In Progress Task',
    status: 'In Progress',
    assignees: ['dave'],
    tags: [],
    dueDate: '2026-04-01',
    createdAt: '2026-03-05T00:00:00Z',
    updatedAt: '2026-03-19T00:00:00Z',
  },
];

function buildProgram(mockListCards: jest.Mock) {
  (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({} as any));
  (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => ({
    listCards: mockListCards,
    getCard: jest.fn(),
    createCard: jest.fn(),
    createCards: jest.fn(),
    updateCard: jest.fn(),
  } as any));
  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');

  const program = new Command();
  registerReleaseCheckCommand(program);
  return program;
}

describe('release-check command', () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    jest.clearAllMocks();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  it('should report all valid cards', async () => {
    const mockListCards = jest.fn().mockResolvedValue(sampleCards.slice(0, 2)); // card-1 and card-2 are valid
    const program = buildProgram(mockListCards);

    await program.parseAsync(['node', 'favro', 'release-check', 'board-1']);

    expect(mockListCards).toHaveBeenCalledWith('board-1', 10000);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('RELEASE CHECK REPORT'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Valid for release:  2'));
  });

  it('should identify unassigned cards', async () => {
    const mockListCards = jest.fn().mockResolvedValue([sampleCards[2]]); // card-3: Review status but unassigned
    const program = buildProgram(mockListCards);

    await program.parseAsync(['node', 'favro', 'release-check', 'board-1']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Found 1 card(s) with issues'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Unassigned'));
  });

  it('should identify blocked cards as blockers', async () => {
    const mockListCards = jest.fn().mockResolvedValue([sampleCards[3]]); // card-4: blocked tag
    const program = buildProgram(mockListCards);

    await program.parseAsync(['node', 'favro', 'release-check', 'board-1']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('BLOCKERS'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('blocked'));
  });

  it('should output JSON when --json flag is used', async () => {
    const mockListCards = jest.fn().mockResolvedValue(sampleCards.slice(0, 2));
    const program = buildProgram(mockListCards);

    await program.parseAsync(['node', 'favro', 'release-check', 'board-1', '--json']);

    const logCalls = consoleLogSpy.mock.calls;
    expect(logCalls.some(call => call[0].includes('"board"'))).toBe(true);
    expect(logCalls.some(call => call[0].includes('"reviewAndDoneCards"'))).toBe(true);
  });

  it('should filter to Review/Done statuses only', async () => {
    const mockListCards = jest.fn().mockResolvedValue(sampleCards);
    const program = buildProgram(mockListCards);

    await program.parseAsync(['node', 'favro', 'release-check', 'board-1']);

    // Only cards with Done or Review status should be checked
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Review/Done cards:  4')); // card-1,2,3,4
  });

  it('should report missing due dates as warnings', async () => {
    const mockListCards = jest.fn().mockResolvedValue([sampleCards[3]]); // card-4: blocked + no due date
    const program = buildProgram(mockListCards);

    await program.parseAsync(['node', 'favro', 'release-check', 'board-1']);

    // When blocked, card appears in BLOCKERS section
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('BLOCKERS'));
  });

  it('should handle API errors gracefully', async () => {
    const mockListCards = jest.fn().mockRejectedValue(new Error('API failed'));
    const program = buildProgram(mockListCards);

    await expect(program.parseAsync(['node', 'favro', 'release-check', 'board-1'])).rejects.toThrow();
  });

  it('should report release status as READY when no issues', async () => {
    const mockListCards = jest.fn().mockResolvedValue([sampleCards[0], sampleCards[1]]);
    const program = buildProgram(mockListCards);

    await program.parseAsync(['node', 'favro', 'release-check', 'board-1']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('✅ READY'));
  });

  it('should report release status as BLOCKED when blockers exist', async () => {
    const mockListCards = jest.fn().mockResolvedValue([sampleCards[3]]);
    const program = buildProgram(mockListCards);

    await program.parseAsync(['node', 'favro', 'release-check', 'board-1']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('❌ BLOCKED'));
  });

  it('should report release status as REVIEW NEEDED when warnings exist', async () => {
    const mockListCards = jest.fn().mockResolvedValue([sampleCards[2]]);
    const program = buildProgram(mockListCards);

    await program.parseAsync(['node', 'favro', 'release-check', 'board-1']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('⚠️  REVIEW NEEDED'));
  });
});
