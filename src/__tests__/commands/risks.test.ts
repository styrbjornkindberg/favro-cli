/**
 * Tests for risks command
 * FAVRO-038: Release Check & Risk Dashboard
 */
import { Command } from 'commander';
import { registerRisksCommand } from '../../commands/risks';
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
    name: 'Overdue task',
    status: 'In Progress',
    assignees: ['alice'],
    tags: [],
    dueDate: '2026-03-01', // Overdue
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-15T00:00:00Z',
  },
  {
    cardId: 'card-2',
    name: 'Blocked task',
    status: 'In Progress',
    assignees: ['bob'],
    tags: ['blocked'],
    dueDate: '2026-04-01',
    createdAt: '2026-03-02T00:00:00Z',
    updatedAt: '2026-03-20T00:00:00Z',
  },
  {
    cardId: 'card-3',
    name: 'Stale task',
    status: 'To Do',
    assignees: ['charlie'],
    tags: [],
    dueDate: '2026-05-01',
    createdAt: '2026-02-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z', // 26+ days old on 2026-03-27
  },
  {
    cardId: 'card-4',
    name: 'Unassigned task',
    status: 'To Do',
    assignees: [],
    tags: [],
    dueDate: '2026-06-01',
    createdAt: '2026-03-03T00:00:00Z',
    updatedAt: '2026-03-20T00:00:00Z',
  },
  {
    cardId: 'card-5',
    name: 'Missing fields task',
    status: 'To Do',
    assignees: [],
    tags: [],
    dueDate: undefined,
    createdAt: '2026-03-04T00:00:00Z',
    updatedAt: '2026-03-20T00:00:00Z',
  },
  {
    cardId: 'card-6',
    name: 'Healthy task',
    status: 'In Progress',
    assignees: ['dave'],
    tags: [],
    dueDate: '2027-04-15',
    createdAt: '2026-03-05T00:00:00Z',
    updatedAt: new Date().toISOString(), // Always fresh — prevents stale detection
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
  registerRisksCommand(program);
  return program;
}

describe('risks command', () => {
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

  it('should identify overdue cards', async () => {
    const mockListCards = jest.fn().mockResolvedValue([sampleCards[0]]);
    const program = buildProgram(mockListCards);

    await program.parseAsync(['node', 'favro', 'risks', 'board-1']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('RISK DASHBOARD REPORT'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('🔴 Overdue'));
  });

  it('should identify blocked cards', async () => {
    const mockListCards = jest.fn().mockResolvedValue([sampleCards[1]]);
    const program = buildProgram(mockListCards);

    await program.parseAsync(['node', 'favro', 'risks', 'board-1']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('🚫 BLOCKED'));
  });

  it('should identify stale cards', async () => {
    const mockListCards = jest.fn().mockResolvedValue([sampleCards[2]]);
    const program = buildProgram(mockListCards);

    await program.parseAsync(['node', 'favro', 'risks', 'board-1']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('⏳ STALE'));
  });

  it('should identify unassigned cards', async () => {
    const mockListCards = jest.fn().mockResolvedValue([sampleCards[3]]);
    const program = buildProgram(mockListCards);

    await program.parseAsync(['node', 'favro', 'risks', 'board-1']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('👤 UNASSIGNED'));
  });

  it('should identify cards with missing fields', async () => {
    const mockListCards = jest.fn().mockResolvedValue([sampleCards[4]]);
    const program = buildProgram(mockListCards);

    await program.parseAsync(['node', 'favro', 'risks', 'board-1']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('⚠️  MISSING FIELDS'));
  });

  it('should report healthy board correctly', async () => {
    const mockListCards = jest.fn().mockResolvedValue([sampleCards[5]]);
    const program = buildProgram(mockListCards);

    await program.parseAsync(['node', 'favro', 'risks', 'board-1']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('All cards are healthy'));
  });

  it('should output JSON when --json flag is used', async () => {
    const mockListCards = jest.fn().mockResolvedValue([sampleCards[0]]);
    const program = buildProgram(mockListCards);

    await program.parseAsync(['node', 'favro', 'risks', 'board-1', '--json']);

    const logCalls = consoleLogSpy.mock.calls;
    expect(logCalls.some(call => call[0].includes('"board"'))).toBe(true);
    expect(logCalls.some(call => call[0].includes('"overdue"'))).toBe(true);
  });

  it('should respect custom --stale-days flag', async () => {
    const notStaleDate = new Date();
    notStaleDate.setDate(notStaleDate.getDate() - 25); // 25 days ago
    const mockListCards = jest.fn().mockResolvedValue([{
      ...sampleCards[2],
      updatedAt: notStaleDate.toISOString()
    }]);
    const program = buildProgram(mockListCards);

    await program.parseAsync(['node', 'favro', 'risks', 'board-1', '--stale-days', '30']);

    // Card should NOT be stale with 30-day threshold (it's 25 days old)
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('⏳ STALE'));
  });

  it('should report risk levels correctly', async () => {
    const mockListCards = jest.fn().mockResolvedValue([
      sampleCards[0], // Overdue
      sampleCards[1], // Blocked
    ]);
    const program = buildProgram(mockListCards);

    await program.parseAsync(['node', 'favro', 'risks', 'board-1']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('🔴 CRITICAL'));
  });

  it('should handle multiple risk categories for single card', async () => {
    const multiRiskCard: Card = {
      cardId: 'card-multi',
      name: 'Multiple risks',
      status: 'In Progress',
      assignees: [], // Unassigned
      tags: ['blocked'], // Blocked
      dueDate: '2026-03-01', // Overdue
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-01T00:00:00Z', // Stale
    };

    const mockListCards = jest.fn().mockResolvedValue([multiRiskCard]);
    const program = buildProgram(mockListCards);

    await program.parseAsync(['node', 'favro', 'risks', 'board-1']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('🔴 Overdue'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('🚫 BLOCKED'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('👤 UNASSIGNED'));
  });

  it('should handle empty board', async () => {
    const mockListCards = jest.fn().mockResolvedValue([]);
    const program = buildProgram(mockListCards);

    await program.parseAsync(['node', 'favro', 'risks', 'board-1']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Total cards:  0'));
  });

  it('should report high risk level for many at-risk cards', async () => {
    const mockListCards = jest
      .fn()
      .mockResolvedValue(Array(15).fill(null).map((_, i) => ({
        ...sampleCards[0],
        cardId: `card-${i}`,
      })));
    const program = buildProgram(mockListCards);

    await program.parseAsync(['node', 'favro', 'risks', 'board-1']);

    // When 15 overdue cards, risk is CRITICAL (>10 at-risk cards)
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('🔴 CRITICAL'));
  });

  it('should handle missing updatedAt as stale', async () => {
    const noUpdateCard: Card = {
      cardId: 'card-no-update',
      name: 'Never updated',
      status: 'To Do',
      assignees: ['user'],
      tags: [],
      dueDate: '2026-05-01',
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: undefined, // No update
    };

    const mockListCards = jest.fn().mockResolvedValue([noUpdateCard]);
    const program = buildProgram(mockListCards);

    await program.parseAsync(['node', 'favro', 'risks', 'board-1']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('⏳ STALE'));
  });

  it('should handle API errors gracefully', async () => {
    const mockListCards = jest.fn().mockRejectedValue(new Error('API failed'));
    const program = buildProgram(mockListCards);

    await expect(program.parseAsync(['node', 'favro', 'risks', 'board-1'])).rejects.toThrow();
  });

  it('should include card IDs and names in risk reports', async () => {
    const mockListCards = jest.fn().mockResolvedValue([sampleCards[0]]);
    const program = buildProgram(mockListCards);

    await program.parseAsync(['node', 'favro', 'risks', 'board-1']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('card-1'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Overdue task'));
  });
});
