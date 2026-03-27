/**
 * Tests for batch-smart command
 * CLA-1801 / FAVRO-039: Batch Smart Update Command
 */
import { Command } from 'commander';
import { registerBatchSmartCommand } from '../../commands/batch-smart';
import {
  parseGoal,
  buildCardFilter,
  buildUpdateRequest,
  buildRollbackRequest,
  formatPreview,
  executeOperationsAtomic,
  isOverdue,
  isBlocked,
  CardOperation,
} from '../../commands/batch-smart';
import CardsAPI, { Card } from '../../lib/cards-api';
import FavroHttpClient from '../../lib/http-client';
import * as config from '../../lib/config';

jest.mock('../../lib/cards-api');
jest.mock('../../lib/http-client');
jest.mock('../../lib/config');

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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Overdue card: due 10 days ago */
function overdueCard(): Card {
  const due = new Date();
  due.setDate(due.getDate() - 10);
  due.setHours(0, 0, 0, 0);
  const dueDateStr = due.toISOString().slice(0, 10);
  return makeCard({ cardId: 'card-overdue', name: 'Overdue Card', dueDate: dueDateStr, status: 'In Progress' });
}

/** Future card: due in 10 days */
function futureCard(): Card {
  const due = new Date();
  due.setDate(due.getDate() + 10);
  due.setHours(0, 0, 0, 0);
  const dueDateStr = due.toISOString().slice(0, 10);
  return makeCard({ cardId: 'card-future', name: 'Future Card', dueDate: dueDateStr, status: 'In Progress' });
}

// ---------------------------------------------------------------------------
// parseGoal
// ---------------------------------------------------------------------------

describe('parseGoal', () => {
  describe('move goal', () => {
    it('parses "move all overdue cards to Review"', () => {
      const goal = parseGoal('move all overdue cards to Review');
      expect(goal.description).toContain('Review');
      expect(goal.actionSummary).toContain('Review');
    });

    it('parses "move all Backlog cards to In Progress"', () => {
      const goal = parseGoal('move all Backlog cards to In Progress');
      expect(goal.description).toContain('In Progress');
      expect(goal.actionSummary).toContain('In Progress');
    });

    it('filters cards already in target status', () => {
      const goal = parseGoal('move all Backlog cards to Done');
      const alreadyDone = makeCard({ status: 'Done' });
      expect(goal.cardFilter(alreadyDone)).toBe(false);
    });

    it('matches cards in matching status', () => {
      const goal = parseGoal('move all backlog cards to Done');
      const backlogCard = makeCard({ status: 'Backlog' });
      expect(goal.cardFilter(backlogCard)).toBe(true);
    });

    it('builds a move operation with correct type and target', () => {
      const goal = parseGoal('move all overdue cards to Review');
      const card = overdueCard();
      const op = goal.buildOperation(card);
      expect(op.type).toBe('move');
      expect(op.cardId).toBe('card-overdue');
      expect(op.targetStatus).toBe('Review');
      expect(op.previousState?.status).toBe('In Progress');
    });
  });

  describe('assign goal', () => {
    it('parses "assign all Backlog cards with no owner to alice"', () => {
      const goal = parseGoal('assign all Backlog cards with no owner to alice');
      expect(goal.description).toContain('alice');
      expect(goal.actionSummary).toContain('alice');
    });

    it('skips cards already assigned to target user', () => {
      const goal = parseGoal('assign all Backlog cards with no owner to alice');
      const alreadyAssigned = makeCard({ assignees: ['alice'] });
      expect(goal.cardFilter(alreadyAssigned)).toBe(false);
    });

    it('matches unassigned Backlog cards', () => {
      const goal = parseGoal('assign all Backlog cards with no owner to alice');
      const unassignedBacklog = makeCard({ status: 'Backlog', assignees: [] });
      expect(goal.cardFilter(unassignedBacklog)).toBe(true);
    });

    it('skips non-Backlog cards', () => {
      const goal = parseGoal('assign all Backlog cards with no owner to alice');
      const inProgressCard = makeCard({ status: 'In Progress', assignees: [] });
      expect(goal.cardFilter(inProgressCard)).toBe(false);
    });

    it('builds assign operation', () => {
      const goal = parseGoal('assign all Backlog cards with no owner to alice');
      const card = makeCard({ status: 'Backlog', assignees: [] });
      const op = goal.buildOperation(card);
      expect(op.type).toBe('assign');
      expect(op.targetAssignee).toBe('alice');
      expect(op.previousState?.assignees).toEqual([]);
    });
  });

  describe('close goal', () => {
    it('parses "close all Done cards"', () => {
      const goal = parseGoal('close all Done cards');
      expect(goal.description.toLowerCase()).toContain('close');
    });

    it('skips already-closed cards', () => {
      const goal = parseGoal('close all In Progress cards');
      const doneCard = makeCard({ status: 'Done' });
      expect(goal.cardFilter(doneCard)).toBe(false);
    });

    it('builds close operation with Done status', () => {
      const goal = parseGoal('close all In Progress cards');
      const card = makeCard({ status: 'In Progress' });
      const op = goal.buildOperation(card);
      expect(op.type).toBe('close');
      expect(op.targetStatus).toBe('Done');
    });
  });

  describe('unassign goal', () => {
    it('parses "unassign all Backlog cards"', () => {
      const goal = parseGoal('unassign all Backlog cards');
      expect(goal.description.toLowerCase()).toContain('unassign');
    });

    it('skips cards with no assignees', () => {
      const goal = parseGoal('unassign all Backlog cards');
      const noAssignee = makeCard({ assignees: [] });
      expect(goal.cardFilter(noAssignee)).toBe(false);
    });

    it('matches cards with assignees', () => {
      const goal = parseGoal('unassign all Backlog cards');
      const withAssignee = makeCard({ status: 'Backlog', assignees: ['alice'] });
      expect(goal.cardFilter(withAssignee)).toBe(true);
    });

    it('builds unassign operation', () => {
      const goal = parseGoal('unassign all Backlog cards');
      const card = makeCard({ status: 'Backlog', assignees: ['alice', 'bob'] });
      const op = goal.buildOperation(card);
      expect(op.type).toBe('unassign');
      expect(op.previousState?.assignees).toEqual(['alice', 'bob']);
    });
  });

  describe('error handling', () => {
    it('throws a helpful error for unknown patterns', () => {
      expect(() => parseGoal('do something weird')).toThrow('Cannot parse goal');
    });

    it('error message includes supported patterns', () => {
      try {
        parseGoal('delete all cards');
      } catch (err: any) {
        expect(err.message).toContain('move all');
        expect(err.message).toContain('assign all');
        expect(err.message).toContain('close all');
      }
    });

    it('error message includes examples', () => {
      try {
        parseGoal('???');
      } catch (err: any) {
        expect(err.message).toContain('Examples:');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// buildCardFilter
// ---------------------------------------------------------------------------

describe('buildCardFilter', () => {
  it('"all" matches everything', () => {
    const f = buildCardFilter('all');
    expect(f(makeCard())).toBe(true);
  });

  it('"overdue" matches overdue cards', () => {
    const f = buildCardFilter('overdue');
    expect(f(overdueCard())).toBe(true);
    expect(f(futureCard())).toBe(false);
  });

  it('"blocked" matches blocked cards', () => {
    const f = buildCardFilter('blocked');
    const blockedCard = makeCard({ tags: ['blocked'] });
    const normalCard = makeCard();
    expect(f(blockedCard)).toBe(true);
    expect(f(normalCard)).toBe(false);
  });

  it('"unassigned" matches cards with no assignees', () => {
    const f = buildCardFilter('unassigned');
    expect(f(makeCard({ assignees: [] }))).toBe(true);
    expect(f(makeCard({ assignees: ['alice'] }))).toBe(false);
  });

  it('status name matches by status (case-insensitive)', () => {
    const f = buildCardFilter('backlog');
    expect(f(makeCard({ status: 'Backlog' }))).toBe(true);
    expect(f(makeCard({ status: 'Done' }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isOverdue
// ---------------------------------------------------------------------------

describe('isOverdue', () => {
  it('returns true for past due date', () => {
    const card = overdueCard();
    expect(isOverdue(card)).toBe(true);
  });

  it('returns false for future due date', () => {
    const card = futureCard();
    expect(isOverdue(card)).toBe(false);
  });

  it('returns false for card with no dueDate', () => {
    const card = makeCard({ dueDate: undefined });
    expect(isOverdue(card)).toBe(false);
  });

  it('returns false for today (not yet overdue)', () => {
    // Use local date formatting to avoid UTC offset issues (lesson from CLA-1780)
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const todayStr = `${year}-${month}-${day}`;
    const card = makeCard({ dueDate: todayStr });
    expect(isOverdue(card)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isBlocked
// ---------------------------------------------------------------------------

describe('isBlocked', () => {
  it('returns true if tags include "blocked"', () => {
    expect(isBlocked(makeCard({ tags: ['blocked', 'urgent'] }))).toBe(true);
  });

  it('returns true if status includes "blocked"', () => {
    expect(isBlocked(makeCard({ status: 'Blocked' }))).toBe(true);
  });

  it('returns false for normal cards', () => {
    expect(isBlocked(makeCard({ tags: ['urgent'], status: 'In Progress' }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildUpdateRequest / buildRollbackRequest
// ---------------------------------------------------------------------------

describe('buildUpdateRequest', () => {
  it('builds status update for move operations', () => {
    const op: CardOperation = {
      type: 'move', cardId: 'c1', cardName: 'Card', targetStatus: 'Review',
      previousState: { status: 'Backlog' },
    };
    expect(buildUpdateRequest(op)).toEqual({ status: 'Review' });
  });

  it('builds assignees update for assign operations', () => {
    const op: CardOperation = {
      type: 'assign', cardId: 'c1', cardName: 'Card', targetAssignee: 'alice',
      previousState: { assignees: [] },
    };
    expect(buildUpdateRequest(op)).toEqual({ assignees: ['alice'] });
  });

  it('appends to existing assignees for assign', () => {
    const op: CardOperation = {
      type: 'assign', cardId: 'c1', cardName: 'Card', targetAssignee: 'bob',
      previousState: { assignees: ['alice'] },
    };
    expect(buildUpdateRequest(op)).toEqual({ assignees: ['alice', 'bob'] });
  });

  it('builds empty assignees for unassign', () => {
    const op: CardOperation = {
      type: 'unassign', cardId: 'c1', cardName: 'Card',
      previousState: { assignees: ['alice'] },
    };
    expect(buildUpdateRequest(op)).toEqual({ assignees: [] });
  });

  it('builds status Done for close operations', () => {
    const op: CardOperation = {
      type: 'close', cardId: 'c1', cardName: 'Card', targetStatus: 'Done',
      previousState: { status: 'In Progress' },
    };
    expect(buildUpdateRequest(op)).toEqual({ status: 'Done' });
  });
});

describe('buildRollbackRequest', () => {
  it('returns previous state', () => {
    const op: CardOperation = {
      type: 'move', cardId: 'c1', cardName: 'Card', targetStatus: 'Review',
      previousState: { status: 'Backlog', assignees: ['alice'] },
    };
    const rollback = buildRollbackRequest(op);
    expect(rollback.status).toBe('Backlog');
    expect(rollback.assignees).toEqual(['alice']);
  });
});

// ---------------------------------------------------------------------------
// formatPreview
// ---------------------------------------------------------------------------

describe('formatPreview', () => {
  it('includes card count in preview', () => {
    const ops: CardOperation[] = [
      { type: 'move', cardId: 'c1', cardName: 'Card One', targetStatus: 'Review' },
      { type: 'move', cardId: 'c2', cardName: 'Card Two', targetStatus: 'Review' },
    ];
    const preview = formatPreview(ops, '→ status: Review');
    expect(preview).toContain('2 cards');
  });

  it('includes card names in preview', () => {
    const ops: CardOperation[] = [
      { type: 'move', cardId: 'c1', cardName: 'My Important Card', targetStatus: 'Done' },
    ];
    const preview = formatPreview(ops, '→ status: Done');
    expect(preview).toContain('My Important Card');
  });

  it('includes action summary in preview', () => {
    const ops: CardOperation[] = [
      { type: 'move', cardId: 'c1', cardName: 'Card', targetStatus: 'Review' },
    ];
    const preview = formatPreview(ops, '→ status: Review');
    expect(preview).toContain('→ status: Review');
  });

  it('handles singular card count', () => {
    const ops: CardOperation[] = [
      { type: 'move', cardId: 'c1', cardName: 'Single Card', targetStatus: 'Done' },
    ];
    const preview = formatPreview(ops, '→ status: Done');
    expect(preview).toContain('1 card');
    expect(preview).not.toContain('1 cards');
  });

  it('truncates long card names', () => {
    const longName = 'A'.repeat(60);
    const ops: CardOperation[] = [
      { type: 'move', cardId: 'c1', cardName: longName, targetStatus: 'Done' },
    ];
    const preview = formatPreview(ops, '→ status: Done');
    expect(preview).toContain('...');
  });
});

// ---------------------------------------------------------------------------
// executeOperationsAtomic
// ---------------------------------------------------------------------------

describe('executeOperationsAtomic', () => {
  let mockApi: jest.Mocked<CardsAPI>;

  beforeEach(() => {
    mockApi = new (CardsAPI as any)() as jest.Mocked<CardsAPI>;
    mockApi.updateCard = jest.fn();
  });

  it('executes all operations and returns success summary', async () => {
    const ops: CardOperation[] = [
      { type: 'move', cardId: 'c1', cardName: 'Card One', targetStatus: 'Review', previousState: { status: 'Backlog' } },
      { type: 'move', cardId: 'c2', cardName: 'Card Two', targetStatus: 'Review', previousState: { status: 'Backlog' } },
    ];

    mockApi.updateCard.mockResolvedValue(makeCard());

    const summary = await executeOperationsAtomic(ops, mockApi);
    expect(summary.success).toBe(2);
    expect(summary.failure).toBe(0);
    expect(mockApi.updateCard).toHaveBeenCalledTimes(2);
  });

  it('rolls back on failure and returns failure summary', async () => {
    const ops: CardOperation[] = [
      { type: 'move', cardId: 'c1', cardName: 'Card One', targetStatus: 'Review', previousState: { status: 'Backlog' } },
      { type: 'move', cardId: 'c2', cardName: 'Card Two', targetStatus: 'Review', previousState: { status: 'Backlog' } },
      { type: 'move', cardId: 'c3', cardName: 'Bad Card', targetStatus: 'Review', previousState: { status: 'Backlog' } },
    ];

    mockApi.updateCard
      .mockResolvedValueOnce(makeCard({ cardId: 'c1' })) // c1 succeeds
      .mockResolvedValueOnce(makeCard({ cardId: 'c2' })) // c2 succeeds
      .mockRejectedValueOnce(new Error('Network error'))  // c3 fails
      .mockResolvedValue(makeCard()); // rollbacks succeed

    const summary = await executeOperationsAtomic(ops, mockApi);
    expect(summary.success).toBe(0);
    expect(summary.failure).toBe(3);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0].cardId).toBe('c3');

    // Rollbacks: c1 and c2 should be rolled back
    // Total calls: 2 success + 1 fail + 2 rollbacks = 5
    expect(mockApi.updateCard).toHaveBeenCalledTimes(5);
  });

  it('handles immediate first-card failure (no rollback needed)', async () => {
    const ops: CardOperation[] = [
      { type: 'move', cardId: 'c1', cardName: 'Card One', targetStatus: 'Review', previousState: { status: 'Backlog' } },
    ];

    mockApi.updateCard.mockRejectedValueOnce(new Error('Server error'));

    const summary = await executeOperationsAtomic(ops, mockApi);
    expect(summary.success).toBe(0);
    expect(summary.failure).toBe(1);
    expect(mockApi.updateCard).toHaveBeenCalledTimes(1); // only the failed attempt, no rollback
  });

  it('returns empty error list on full success', async () => {
    const ops: CardOperation[] = [
      { type: 'assign', cardId: 'c1', cardName: 'Card', targetAssignee: 'alice', previousState: { assignees: [] } },
    ];
    mockApi.updateCard.mockResolvedValue(makeCard());
    const summary = await executeOperationsAtomic(ops, mockApi);
    expect(summary.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CLI integration — registerBatchSmartCommand
// ---------------------------------------------------------------------------

describe('registerBatchSmartCommand (CLI)', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let consoleSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  const mockResolveApiKey = config.resolveApiKey as jest.MockedFunction<typeof config.resolveApiKey>;

  beforeEach(() => {
    jest.clearAllMocks();
    program = new Command();
    registerBatchSmartCommand(program);
    mockResolveApiKey.mockResolvedValue('test-token');

    // Suppress console output
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // Mock process.exit to throw instead of actually exiting the test process
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with error when no --goal provided', async () => {
    await expect(
      program.parseAsync(['node', 'favro', 'batch-smart', 'board-1'])
    ).rejects.toThrow();
  });

  it('registers the batch-smart command', () => {
    const cmd = program.commands.find(c => c.name() === 'batch-smart');
    expect(cmd).toBeDefined();
  });

  it('dry-run mode does not call api.updateCard', async () => {
    const MockedCardsAPI = CardsAPI as jest.MockedClass<typeof CardsAPI>;
    const mockUpdateCard = jest.fn();
    const mockListCards = jest.fn().mockResolvedValue([
      makeCard({ cardId: 'c1', status: 'Backlog' }),
    ]);
    MockedCardsAPI.mockImplementation(() => ({
      listCards: mockListCards,
      updateCard: mockUpdateCard,
      getCard: jest.fn(),
      createCard: jest.fn(),
      createCards: jest.fn(),
      deleteCard: jest.fn(),
      searchCards: jest.fn(),
    } as any));

    (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({} as any));

    try {
      await program.parseAsync([
        'node', 'favro', 'batch-smart', 'board-1',
        '--goal', 'move all Backlog cards to Review',
        '--dry-run',
      ]);
    } catch {
      // process.exit(0) throws via our exitSpy
    }

    expect(mockUpdateCard).not.toHaveBeenCalled();
  });

  it('handles no matching cards gracefully', async () => {
    const MockedCardsAPI = CardsAPI as jest.MockedClass<typeof CardsAPI>;
    MockedCardsAPI.mockImplementation(() => ({
      listCards: jest.fn().mockResolvedValue([
        makeCard({ cardId: 'c1', status: 'Done' }), // already in target state
      ]),
      updateCard: jest.fn(),
    } as any));

    (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({} as any));

    try {
      await program.parseAsync([
        'node', 'favro', 'batch-smart', 'board-1',
        '--goal', 'move all Backlog cards to Done', // No Backlog cards exist
        '--yes',
      ]);
    } catch {
      // expected: process.exit(0) throws via our exitSpy
    }

    const logCalls = consoleSpy.mock.calls.flat().join(' ');
    expect(logCalls).toMatch(/No cards match/i);
  });
});
