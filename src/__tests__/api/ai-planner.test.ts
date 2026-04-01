/**
 * Tests for ai-planner.ts
 * LLM-powered change planning with mock provider
 */
import { generatePlan, proposeWithAI } from '../../api/ai-planner';
import { BoardContextSnapshot } from '../../api/context';
import { AIProvider, AIMessage, AICompletionOptions } from '../../lib/ai-provider';
import { changeStore } from '../../lib/change-store';

// ─── Mock AI Provider ─────────────────────────────────────────────────────────

function createMockProvider(response: string): AIProvider {
  return {
    name: 'mock',
    async *complete(_system: string, _messages: AIMessage[], _options?: AICompletionOptions) {
      yield response;
    },
  };
}

// ─── Test Snapshot ────────────────────────────────────────────────────────────

function makeSnapshot(): BoardContextSnapshot {
  return {
    board: {
      id: 'board-1',
      name: 'Sprint 42',
      description: 'Test board',
      members: ['user-1'],
    },
    columns: [{ id: 'col-1', name: 'To Do' }],
    members: [{ id: 'user-1', name: 'Alice', email: 'alice@test.com' }],
    customFields: [],
    cards: [
      { id: 'card-1', title: 'Fix bug', status: 'To Do', owner: 'Alice' },
    ],
    stats: { total: 1, by_status: { 'To Do': 1 }, by_owner: { 'Alice': 1 } },
    generatedAt: '2025-01-15T12:00:00Z',
  };
}

// ─── generatePlan Tests ───────────────────────────────────────────────────────

describe('generatePlan', () => {
  test('parses LLM response into ApiCall array', async () => {
    const llmResponse = JSON.stringify([
      { method: 'PATCH', path: '/cards/card-1', data: { status: 'Done' }, description: 'Move to Done' },
    ]);
    const provider = createMockProvider(llmResponse);
    const result = await generatePlan(makeSnapshot(), 'Move bug to Done', provider);

    expect(result.plan).toHaveLength(1);
    expect(result.plan[0].method).toBe('PATCH');
    expect(result.plan[0].path).toBe('/cards/card-1');
    expect(result.rawResponse).toBe(llmResponse);
  });

  test('returns empty plan for empty LLM response', async () => {
    const provider = createMockProvider('[]');
    const result = await generatePlan(makeSnapshot(), 'Do nothing', provider);

    expect(result.plan).toHaveLength(0);
    expect(result.rawResponse).toBe('[]');
  });

  test('handles LLM response with markdown fences', async () => {
    const inner = JSON.stringify([
      { method: 'POST', path: '/cards', data: { name: 'New card' }, description: 'Create card' },
    ]);
    const provider = createMockProvider('```json\n' + inner + '\n```');
    const result = await generatePlan(makeSnapshot(), 'Create a card', provider);

    expect(result.plan).toHaveLength(1);
    expect(result.plan[0].method).toBe('POST');
  });

  test('returns empty plan for non-JSON LLM response', async () => {
    const provider = createMockProvider('I cannot do that.');
    const result = await generatePlan(makeSnapshot(), 'Impossible request', provider);

    expect(result.plan).toHaveLength(0);
  });

  test('handles multi-step plans', async () => {
    const ops = [
      { method: 'PATCH', path: '/cards/card-1', data: { status: 'Review' }, description: 'Move to review' },
      { method: 'PATCH', path: '/cards/card-1', data: { addAssignmentIds: ['user-1'] }, description: 'Assign alice' },
    ];
    const provider = createMockProvider(JSON.stringify(ops));
    const result = await generatePlan(makeSnapshot(), 'Move bug to review and assign to alice', provider);

    expect(result.plan).toHaveLength(2);
  });
});

// ─── proposeWithAI Tests ──────────────────────────────────────────────────────

jest.mock('../../api/context', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      getSnapshot: jest.fn().mockResolvedValue({
        board: { id: 'board-1', name: 'Sprint 42', description: 'Test', members: ['user-1'] },
        columns: [{ id: 'col-1', name: 'To Do' }],
        members: [{ id: 'user-1', name: 'Alice', email: 'alice@test.com' }],
        customFields: [],
        cards: [{ id: 'card-1', title: 'Fix bug', status: 'To Do', owner: 'Alice' }],
        stats: { total: 1, by_status: { 'To Do': 1 }, by_owner: { 'Alice': 1 } },
        generatedAt: '2025-01-15T12:00:00Z',
      }),
    })),
  };
});

describe('proposeWithAI', () => {
  const mockClient = {} as any;

  beforeEach(() => {
    changeStore.clear();
  });

  test('returns proposal with change ID and preview', async () => {
    const ops = [
      { method: 'PATCH', path: '/cards/card-1', data: { status: 'Done' }, description: 'Move to Done' },
    ];
    const provider = createMockProvider(JSON.stringify(ops));

    const result = await proposeWithAI('Sprint 42', 'Move bug to done', mockClient, provider);

    expect(result.changeId).toMatch(/^ch_/);
    expect(result.boardName).toBe('Sprint 42');
    expect(result.actionText).toBe('Move bug to done');
    expect(result.preview).toHaveLength(1);
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  test('returns empty proposal when LLM returns no operations', async () => {
    const provider = createMockProvider('[]');

    const result = await proposeWithAI('Sprint 42', 'No changes needed', mockClient, provider);

    expect(result.changeId).toBe('');
    expect(result.preview).toHaveLength(0);
    expect(result.expiresAt).toBe(0);
  });

  test('stores proposal in change store', async () => {
    const ops = [
      { method: 'PATCH', path: '/cards/card-1', data: { status: 'Done' }, description: 'Move to Done' },
    ];
    const provider = createMockProvider(JSON.stringify(ops));

    const result = await proposeWithAI('Sprint 42', 'Move bug', mockClient, provider);

    const stored = changeStore.getChange(result.changeId);
    expect(stored).toBeDefined();
    expect(stored?.apiCalls).toHaveLength(1);
    expect(stored?.status).toBe('proposed');
  });
});
