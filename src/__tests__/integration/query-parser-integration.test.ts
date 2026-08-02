/**
 * Integration Tests for Enhanced Query Parser in CLI Commands
 * CLA-1780 / FIX #1: Verify parser is wired into CLI commands
 */
import { applyFilter, applyFilters } from '../../commands/cards-export';
import { Card } from '../../lib/cards-api';
import { ParseError } from '../../lib/query-parser';
import { stubFilterContext, useTempConfigDir } from '../../test-support/filter-vocabulary';

useTempConfigDir();

/** The org every filter here is settled against — see #83. */
const ctx = () => stubFilterContext();

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
    test('filters by status with : operator', async () => {
      const result = await applyFilter(sampleCards, 'status:done', ctx());
      expect(result).toHaveLength(1);
      expect(result[0].cardId).toBe('card-001');
    });

    test('filters by status with = operator', async () => {
      const result = await applyFilter(sampleCards, 'status=done', ctx());
      expect(result).toHaveLength(1);
      expect(result[0].cardId).toBe('card-001');
    });

    test('filters by assignee using ~ (contains)', async () => {
      const result = await applyFilter(sampleCards, 'assignee~alice', ctx());
      expect(result).toHaveLength(2);
      expect(result.map(c => c.cardId).sort()).toEqual(['card-001', 'card-003']);
    });

    test('filters by tag', async () => {
      const result = await applyFilter(sampleCards, 'tag:bug', ctx());
      expect(result).toHaveLength(1);
      expect(result[0].cardId).toBe('card-002');
    });
  });

  describe('AND operator (CRITICAL FIX #1)', () => {
    test('filters with AND: "status:done AND assignee~alice"', async () => {
      const result = await applyFilter(sampleCards, 'status:done AND assignee~alice', ctx());
      expect(result).toHaveLength(1);
      expect(result[0].cardId).toBe('card-001');
    });

    test('filters with multiple AND: "status:in-progress AND tag:bug AND assignee~bob"', async () => {
      const result = await applyFilter(sampleCards, 'status:in-progress AND tag:bug AND assignee~bob', ctx());
      expect(result).toHaveLength(1);
      expect(result[0].cardId).toBe('card-002');
    });

    test('AND with no matching cards returns empty', async () => {
      const result = await applyFilter(sampleCards, 'status:done AND tag:bug', ctx());
      expect(result).toHaveLength(0);
    });
  });

  describe('OR operator (CRITICAL FIX #1)', () => {
    test('filters with OR: "status:done OR status:in-progress"', async () => {
      const result = await applyFilter(sampleCards, 'status:done OR status:in-progress', ctx());
      expect(result).toHaveLength(2);
      expect(result.map(c => c.cardId).sort()).toEqual(['card-001', 'card-002']);
    });

    test('filters with OR across fields: "status:done OR assignee~carol"', async () => {
      const result = await applyFilter(sampleCards, 'status:done OR assignee~carol', ctx());
      expect(result).toHaveLength(2);
      expect(result.map(c => c.cardId).sort()).toEqual(['card-001', 'card-003']);
    });

    test('OR with no matches returns empty', async () => {
      // Both arms name real columns, so this is a true empty — not a typo
      // dressed up as one. `status:completed` refuses now (#83).
      const result = await applyFilter(sampleCards, 'status:todo AND tag:release', ctx());
      expect(result).toHaveLength(0);
    });

    test('OR over a column this board does not have refuses (#83)', async () => {
      await expect(
        applyFilter(sampleCards, 'status:completed OR status:archived', ctx())
      ).rejects.toThrow(/completed/);
    });
  });

  describe('Parentheses (CRITICAL FIX #1)', () => {
    test('filters with parentheses: "(status:done OR status:in-progress) AND assignee~alice"', async () => {
      const result = await applyFilter(sampleCards, '(status:done OR status:in-progress) AND assignee~alice', ctx());
      expect(result).toHaveLength(1);
      expect(result[0].cardId).toBe('card-001');
    });

    test('filters with nested parentheses: "status:done OR (assignee~alice AND tag:docs)"', async () => {
      const result = await applyFilter(sampleCards, 'status:done OR (assignee~alice AND tag:docs)', ctx());
      expect(result).toHaveLength(2);
      expect(result.map(c => c.cardId).sort()).toEqual(['card-001', 'card-003']);
    });
  });

  describe('applyFilters — Multiple filter expressions with AND logic', () => {
    test('applies filters as AND: ["status:done", "assignee~alice"]', async () => {
      const result = await applyFilters(sampleCards, ['status:done', 'assignee~alice'], ctx());
      expect(result).toHaveLength(1);
      expect(result[0].cardId).toBe('card-001');
    });

    test('applies three filters with AND: ["status:in-progress", "tag:bug", "assignee~bob"]', async () => {
      const result = await applyFilters(sampleCards, ['status:in-progress', 'tag:bug', 'assignee~bob'], ctx());
      expect(result).toHaveLength(1);
      expect(result[0].cardId).toBe('card-002');
    });

    test('returns all cards when filters array is empty', async () => {
      const result = await applyFilters(sampleCards, [], ctx());
      expect(result).toHaveLength(sampleCards.length);
    });
  });

  describe('Complex queries combining all features', () => {
    test('complex: "(status:done OR status:in-progress) AND (assignee~alice OR tag:urgent)"', async () => {
      const result = await applyFilter(
        sampleCards,
        '(status:done OR status:in-progress) AND (assignee~alice OR tag:urgent)',
        ctx()
      );
      // card-001 (done, alice) ✓
      // card-002 (in-progress, urgent) ✓
      // card-003 (todo) ✗
      expect(result).toHaveLength(2);
      expect(result.map(c => c.cardId).sort()).toEqual(['card-001', 'card-002']);
    });

    test('complex with contains and exact match: "assignee~alice AND tag:docs"', async () => {
      const result = await applyFilter(sampleCards, 'assignee~alice AND tag:docs', ctx());
      expect(result).toHaveLength(1);
      expect(result[0].cardId).toBe('card-003');
    });
  });

  describe('Operator precedence (AND > OR)', () => {
    test('AND has higher precedence than OR: "status:done OR status:in-progress AND tag:bug"', async () => {
      // Should parse as: status:done OR (status:in-progress AND tag:bug)
      // card-001 (done) ✓
      // card-002 (in-progress AND bug) ✓
      // card-003 (todo) ✗
      const result = await applyFilter(sampleCards, 'status:done OR status:in-progress AND tag:bug', ctx());
      expect(result).toHaveLength(2);
      expect(result.map(c => c.cardId).sort()).toEqual(['card-001', 'card-002']);
    });
  });

  describe('Error handling', () => {
    // The refusal is RAISED, not printed and exited (#83): the command's own
    // catch reports it, so export and list say the same words about the same
    // input and both carry the structured `detail` an agent can read.
    test('invalid syntax refuses', async () => {
      await expect(applyFilter(sampleCards, 'status:done AND AND', ctx()))
        .rejects.toBeInstanceOf(ParseError);
    });

    test('unclosed parenthesis refuses', async () => {
      await expect(applyFilter(sampleCards, '(status:done', ctx()))
        .rejects.toThrow(/Unclosed parenthesis/i);
    });
  });

  describe('Real-world use cases', () => {
    test('export active work: "status:in-progress OR status:todo"', async () => {
      const result = await applyFilter(sampleCards, 'status:in-progress OR status:todo', ctx());
      expect(result).toHaveLength(2);
    });

    test('export alice\'s work: "assignee~alice"', async () => {
      const result = await applyFilter(sampleCards, 'assignee~alice', ctx());
      expect(result).toHaveLength(2);
    });

    test('export urgent high-priority: "tag:urgent OR tag:high-priority"', async () => {
      const result = await applyFilter(sampleCards, 'tag:urgent OR tag:high-priority', ctx());
      expect(result).toHaveLength(1);
      expect(result[0].cardId).toBe('card-002');
    });

    test('export release-ready (done + release): "status:done AND tag:release"', async () => {
      const result = await applyFilter(sampleCards, 'status:done AND tag:release', ctx());
      expect(result).toHaveLength(1);
      expect(result[0].cardId).toBe('card-001');
    });
  });
});
