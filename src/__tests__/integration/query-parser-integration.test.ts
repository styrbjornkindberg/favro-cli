/**
 * Integration Tests for Enhanced Query Parser in CLI Commands
 * CLA-1780 / FIX #1: Verify parser is wired into CLI commands
 */
import { applyFilter, applyFilters } from '../../commands/cards-export';
import { Card } from '../../lib/cards-api';

describe('Query Parser CLI Integration', () => {
  const sampleCards: Card[] = [
    {
      cardId: 'card-001',
      name: 'Deploy to production',
      status: 'done',
      assignees: ['alice@example.com'],
      tags: ['release'],
      description: 'Production release',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    },
    {
      cardId: 'card-002',
      name: 'Fix login bug',
      status: 'in-progress',
      assignees: ['bob@example.com'],
      tags: ['bug', 'urgent'],
      description: 'Users cannot log in',
      createdAt: '2026-01-03T00:00:00Z',
      updatedAt: '2026-01-04T00:00:00Z',
    },
    {
      cardId: 'card-003',
      name: 'Update docs',
      status: 'todo',
      assignees: ['alice@example.com', 'carol@example.com'],
      tags: ['docs'],
      description: 'Update README',
      createdAt: '2026-01-05T00:00:00Z',
      updatedAt: '2026-01-06T00:00:00Z',
    },
  ];

  describe('Basic field filtering', () => {
    test('filters by status with : operator', () => {
      const result = applyFilter(sampleCards, 'status:done');
      expect(result).toHaveLength(1);
      expect(result[0].cardId).toBe('card-001');
    });

    test('filters by status with = operator', () => {
      const result = applyFilter(sampleCards, 'status=done');
      expect(result).toHaveLength(1);
      expect(result[0].cardId).toBe('card-001');
    });

    test('filters by assignee using ~ (contains)', () => {
      const result = applyFilter(sampleCards, 'assignee~alice');
      expect(result).toHaveLength(2);
      expect(result.map(c => c.cardId).sort()).toEqual(['card-001', 'card-003']);
    });

    test('filters by tag', () => {
      const result = applyFilter(sampleCards, 'tag:bug');
      expect(result).toHaveLength(1);
      expect(result[0].cardId).toBe('card-002');
    });
  });

  describe('AND operator (CRITICAL FIX #1)', () => {
    test('filters with AND: "status:done AND assignee~alice"', () => {
      const result = applyFilter(sampleCards, 'status:done AND assignee~alice');
      expect(result).toHaveLength(1);
      expect(result[0].cardId).toBe('card-001');
    });

    test('filters with multiple AND: "status:in-progress AND tag:bug AND assignee~bob"', () => {
      const result = applyFilter(sampleCards, 'status:in-progress AND tag:bug AND assignee~bob');
      expect(result).toHaveLength(1);
      expect(result[0].cardId).toBe('card-002');
    });

    test('AND with no matching cards returns empty', () => {
      const result = applyFilter(sampleCards, 'status:done AND tag:bug');
      expect(result).toHaveLength(0);
    });
  });

  describe('OR operator (CRITICAL FIX #1)', () => {
    test('filters with OR: "status:done OR status:in-progress"', () => {
      const result = applyFilter(sampleCards, 'status:done OR status:in-progress');
      expect(result).toHaveLength(2);
      expect(result.map(c => c.cardId).sort()).toEqual(['card-001', 'card-002']);
    });

    test('filters with OR across fields: "status:done OR assignee~carol"', () => {
      const result = applyFilter(sampleCards, 'status:done OR assignee~carol');
      expect(result).toHaveLength(2);
      expect(result.map(c => c.cardId).sort()).toEqual(['card-001', 'card-003']);
    });

    test('OR with no matches returns empty', () => {
      const result = applyFilter(sampleCards, 'status:completed OR status:archived');
      expect(result).toHaveLength(0);
    });
  });

  describe('Parentheses (CRITICAL FIX #1)', () => {
    test('filters with parentheses: "(status:done OR status:in-progress) AND assignee~alice"', () => {
      const result = applyFilter(sampleCards, '(status:done OR status:in-progress) AND assignee~alice');
      expect(result).toHaveLength(1);
      expect(result[0].cardId).toBe('card-001');
    });

    test('filters with nested parentheses: "status:done OR (assignee~alice AND tag:docs)"', () => {
      const result = applyFilter(sampleCards, 'status:done OR (assignee~alice AND tag:docs)');
      expect(result).toHaveLength(2);
      expect(result.map(c => c.cardId).sort()).toEqual(['card-001', 'card-003']);
    });
  });

  describe('applyFilters — Multiple filter expressions with AND logic', () => {
    test('applies filters as AND: ["status:done", "assignee~alice"]', () => {
      const result = applyFilters(sampleCards, ['status:done', 'assignee~alice']);
      expect(result).toHaveLength(1);
      expect(result[0].cardId).toBe('card-001');
    });

    test('applies three filters with AND: ["status:in-progress", "tag:bug", "assignee~bob"]', () => {
      const result = applyFilters(sampleCards, ['status:in-progress', 'tag:bug', 'assignee~bob']);
      expect(result).toHaveLength(1);
      expect(result[0].cardId).toBe('card-002');
    });

    test('returns all cards when filters array is empty', () => {
      const result = applyFilters(sampleCards, []);
      expect(result).toHaveLength(sampleCards.length);
    });
  });

  describe('Complex queries combining all features', () => {
    test('complex: "(status:done OR status:in-progress) AND (assignee~alice OR tag:urgent)"', () => {
      const result = applyFilter(
        sampleCards,
        '(status:done OR status:in-progress) AND (assignee~alice OR tag:urgent)'
      );
      // card-001 (done, alice) ✓
      // card-002 (in-progress, urgent) ✓
      // card-003 (todo) ✗
      expect(result).toHaveLength(2);
      expect(result.map(c => c.cardId).sort()).toEqual(['card-001', 'card-002']);
    });

    test('complex with contains and exact match: "assignee~alice AND tag:docs"', () => {
      const result = applyFilter(sampleCards, 'assignee~alice AND tag:docs');
      expect(result).toHaveLength(1);
      expect(result[0].cardId).toBe('card-003');
    });
  });

  describe('Operator precedence (AND > OR)', () => {
    test('AND has higher precedence than OR: "status:done OR status:in-progress AND tag:bug"', () => {
      // Should parse as: status:done OR (status:in-progress AND tag:bug)
      // card-001 (done) ✓
      // card-002 (in-progress AND bug) ✓
      // card-003 (todo) ✗
      const result = applyFilter(sampleCards, 'status:done OR status:in-progress AND tag:bug');
      expect(result).toHaveLength(2);
      expect(result.map(c => c.cardId).sort()).toEqual(['card-001', 'card-002']);
    });
  });

  describe('Error handling', () => {
    test('invalid syntax exits process (tested via mock)', () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

      expect(() => applyFilter(sampleCards, 'status:done AND AND')).toThrow('exit');
      expect(errorSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
      exitSpy.mockRestore();
    });

    test('unclosed parenthesis exits process', () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

      expect(() => applyFilter(sampleCards, '(status:done')).toThrow('exit');

      errorSpy.mockRestore();
      exitSpy.mockRestore();
    });
  });

  describe('Real-world use cases', () => {
    test('export active work: "status:in-progress OR status:todo"', () => {
      const result = applyFilter(sampleCards, 'status:in-progress OR status:todo');
      expect(result).toHaveLength(2);
    });

    test('export alice\'s work: "assignee~alice"', () => {
      const result = applyFilter(sampleCards, 'assignee~alice');
      expect(result).toHaveLength(2);
    });

    test('export urgent high-priority: "tag:urgent OR tag:high-priority"', () => {
      const result = applyFilter(sampleCards, 'tag:urgent OR tag:high-priority');
      expect(result).toHaveLength(1);
      expect(result[0].cardId).toBe('card-002');
    });

    test('export release-ready (done + release): "status:done AND tag:release"', () => {
      const result = applyFilter(sampleCards, 'status:done AND tag:release');
      expect(result).toHaveLength(1);
      expect(result[0].cardId).toBe('card-001');
    });
  });
});
