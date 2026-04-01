/**
 * Tests for ai-prompt.ts
 * Prompt template builders, board context serialization, and response parsing
 */
import {
  serializeBoardContext,
  buildAskPrompt,
  buildDoPrompt,
  buildExplainPrompt,
  parseDoResponse,
  SYSTEM_PROMPT_ASK,
  SYSTEM_PROMPT_DO,
  SYSTEM_PROMPT_EXPLAIN,
} from '../../lib/ai-prompt';
import { BoardContextSnapshot } from '../../api/context';

// ─── Test Fixtures ────────────────────────────────────────────────────────────

function makeSnapshot(overrides?: Partial<BoardContextSnapshot>): BoardContextSnapshot {
  return {
    board: {
      id: 'board-1',
      name: 'Sprint 42',
      description: 'Current sprint board',
      type: 'kanban',
      members: ['user-1', 'user-2'],
    },
    columns: [
      { id: 'col-1', name: 'To Do', cardCount: 3 },
      { id: 'col-2', name: 'In Progress', cardCount: 2 },
      { id: 'col-3', name: 'Done', cardCount: 5 },
    ],
    members: [
      { id: 'user-1', name: 'Alice', email: 'alice@test.com', role: 'admin' },
      { id: 'user-2', name: 'Bob', email: 'bob@test.com' },
    ],
    customFields: [
      { id: 'cf-1', name: 'Priority', type: 'single-select', values: ['P1', 'P2', 'P3'] },
    ],
    cards: [
      {
        id: 'card-1',
        title: 'Fix login bug',
        status: 'In Progress',
        owner: 'Alice',
        assignees: ['Alice'],
        tags: ['bug'],
        due: '2025-02-01',
      },
      {
        id: 'card-2',
        title: 'Add dark mode',
        status: 'To Do',
        owner: 'Bob',
        assignees: ['Bob', 'Alice'],
        tags: ['feature', 'ui'],
        blockedBy: ['card-1'],
      },
      {
        id: 'card-3',
        title: 'Update docs',
        status: 'Done',
        owner: 'Alice',
      },
    ],
    stats: {
      total: 3,
      by_status: { 'To Do': 1, 'In Progress': 1, 'Done': 1 },
      by_owner: { 'Alice': 2, 'Bob': 1 },
    },
    generatedAt: '2025-01-15T12:00:00Z',
    ...overrides,
  };
}

// ─── serializeBoardContext Tests ───────────────────────────────────────────────

describe('serializeBoardContext', () => {
  test('includes board name and ID', () => {
    const result = serializeBoardContext(makeSnapshot());
    expect(result).toContain('# Board: Sprint 42');
    expect(result).toContain('ID: board-1');
  });

  test('includes columns with card counts', () => {
    const result = serializeBoardContext(makeSnapshot());
    expect(result).toContain('To Do (col-1)');
    expect(result).toContain('3 cards');
  });

  test('includes members with email and role', () => {
    const result = serializeBoardContext(makeSnapshot());
    expect(result).toContain('Alice <alice@test.com>');
    expect(result).toContain('[admin]');
    expect(result).toContain('Bob <bob@test.com>');
  });

  test('includes custom fields', () => {
    const result = serializeBoardContext(makeSnapshot());
    expect(result).toContain('Priority (single-select)');
    expect(result).toContain('P1, P2, P3');
  });

  test('includes stats', () => {
    const result = serializeBoardContext(makeSnapshot());
    expect(result).toContain('Total cards: 3');
    expect(result).toContain('In Progress:1');
  });

  test('serializes cards with all fields', () => {
    const result = serializeBoardContext(makeSnapshot());
    expect(result).toContain('[card-1] "Fix login bug"');
    expect(result).toContain('status:In Progress');
    expect(result).toContain('owner:Alice');
    expect(result).toContain('tags:bug');
    expect(result).toContain('due:2025-02-01');
  });

  test('includes blockedBy relationships', () => {
    const result = serializeBoardContext(makeSnapshot());
    expect(result).toContain('blockedBy:card-1');
  });

  test('shows multiple assignees', () => {
    const result = serializeBoardContext(makeSnapshot());
    expect(result).toContain('assignees:Bob,Alice');
  });

  test('truncates cards when exceeding token budget', () => {
    const manyCards = Array.from({ length: 500 }, (_, i) => ({
      id: `card-${i}`,
      title: `Card number ${i} with a reasonably long title to consume tokens`,
      status: 'To Do',
      owner: 'User',
    }));
    const snapshot = makeSnapshot({ cards: manyCards, stats: { total: 500, by_status: { 'To Do': 500 }, by_owner: { 'User': 500 } } });

    // Tiny budget to force truncation
    const result = serializeBoardContext(snapshot, 200);
    expect(result).toContain('more cards truncated for token budget');
  });

  test('handles empty custom fields', () => {
    const snapshot = makeSnapshot({ customFields: [] });
    const result = serializeBoardContext(snapshot);
    expect(result).not.toContain('## Custom Fields');
  });
});

// ─── Prompt Builder Tests ─────────────────────────────────────────────────────

describe('buildAskPrompt', () => {
  test('includes system prompt and board context', () => {
    const { system, user } = buildAskPrompt(makeSnapshot(), 'What is blocked?');
    expect(system).toContain(SYSTEM_PROMPT_ASK);
    expect(system).toContain('Sprint 42');
    expect(user).toBe('What is blocked?');
  });
});

describe('buildDoPrompt', () => {
  test('includes system prompt and board context', () => {
    const { system, user } = buildDoPrompt(makeSnapshot(), 'Move bugs to Done');
    expect(system).toContain(SYSTEM_PROMPT_DO);
    expect(system).toContain('Sprint 42');
    expect(user).toContain('Move bugs to Done');
    expect(user).toContain('JSON execution plan');
  });
});

describe('buildExplainPrompt', () => {
  test('uses card data as user message', () => {
    const { system, user } = buildExplainPrompt('# Card: Fix login bug\nStatus: In Progress');
    expect(system).toBe(SYSTEM_PROMPT_EXPLAIN);
    expect(user).toContain('Fix login bug');
  });
});

// ─── parseDoResponse Tests ────────────────────────────────────────────────────

describe('parseDoResponse', () => {
  test('parses clean JSON array', () => {
    const response = JSON.stringify([
      { method: 'PATCH', path: '/cards/card-1', data: { status: 'Done' }, description: 'Move card to Done' },
    ]);
    const result = parseDoResponse(response);
    expect(result).toHaveLength(1);
    expect(result[0].method).toBe('PATCH');
    expect(result[0].path).toBe('/cards/card-1');
    expect(result[0].data).toEqual({ status: 'Done' });
    expect(result[0].description).toBe('Move card to Done');
  });

  test('strips markdown code fences', () => {
    const response = '```json\n[{"method":"POST","path":"/cards","data":{"name":"test"},"description":"Create card"}]\n```';
    const result = parseDoResponse(response);
    expect(result).toHaveLength(1);
    expect(result[0].method).toBe('POST');
  });

  test('extracts JSON array from surrounding text', () => {
    const response = 'Here is the plan:\n\n[{"method":"DELETE","path":"/cards/card-1","description":"Delete card"}]\n\nThis will delete the card.';
    const result = parseDoResponse(response);
    expect(result).toHaveLength(1);
    expect(result[0].method).toBe('DELETE');
  });

  test('returns empty array for non-JSON response', () => {
    const result = parseDoResponse('I cannot understand that request.');
    expect(result).toEqual([]);
  });

  test('returns empty array for empty JSON array', () => {
    const result = parseDoResponse('[]');
    expect(result).toEqual([]);
  });

  test('filters out operations missing required fields', () => {
    const response = JSON.stringify([
      { method: 'PATCH', path: '/cards/1', description: 'Valid' },
      { path: '/cards/2', description: 'Missing method' },
      { method: 'PATCH', description: 'Missing path' },
      { method: 'PATCH', path: '/cards/3' }, // Missing description
    ]);
    const result = parseDoResponse(response);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('Valid');
  });

  test('handles multiple operations', () => {
    const ops = [
      { method: 'PATCH', path: '/cards/card-1', data: { status: 'Review' }, description: 'Move to Review' },
      { method: 'PATCH', path: '/cards/card-2', data: { addAssignmentIds: ['user-1'] }, description: 'Assign alice' },
      { method: 'POST', path: '/cards/card-3/comments', data: { comment: 'Triaged' }, description: 'Add comment' },
    ];
    const result = parseDoResponse(JSON.stringify(ops));
    expect(result).toHaveLength(3);
  });

  test('handles operation with null data', () => {
    const response = JSON.stringify([
      { method: 'DELETE', path: '/cards/card-1', data: null, description: 'Delete card' },
    ]);
    const result = parseDoResponse(response);
    expect(result).toHaveLength(1);
    expect(result[0].data).toBeUndefined();
  });
});
