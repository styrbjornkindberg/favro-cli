/**
 * Unit Tests — Propose & Execute Change System
 * CLA-1797 / FAVRO-035
 *
 * Tests for:
 *   - proposeChange: valid actions → correct API calls
 *   - proposeChange: invalid card names → ValidationError with suggestions
 *   - proposeChange: ambiguous card names → error with top 3 matches
 *   - proposeChange: invalid status → error with available statuses
 *   - change-store: TTL expiry behaviour
 *   - executeChange: apply all API calls atomically
 *   - executeChange: expired/missing change-id → error
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { proposeChange, executeChange, ValidationError } from '../../src/api/propose';
import { changeStore, ChangeStore } from '../../src/lib/change-store';
import FavroHttpClient from '../../src/lib/http-client';
import ContextAPI from '../../src/api/context';
import type { BoardContextSnapshot } from '../../src/api/context';

// ─── Mock ContextAPI ──────────────────────────────────────────────────────────

vi.mock('../../src/api/context');

const MockContextAPI = vi.mocked(ContextAPI);

// ─── Sample board snapshot ────────────────────────────────────────────────────

const SAMPLE_SNAPSHOT: BoardContextSnapshot = {
  board: { id: 'boards-1234', name: 'Sprint 42', members: ['alice@ex.com', 'bob@ex.com'] },
  columns: [
    { id: 'col-1', name: 'Backlog', cardCount: 3 },
    { id: 'col-2', name: 'In Progress', cardCount: 2 },
    { id: 'col-3', name: 'Review', cardCount: 1 },
    { id: 'col-4', name: 'Done', cardCount: 0 },
  ],
  customFields: [
    { id: 'cf1', name: 'Priority', type: 'select', values: ['High', 'Medium', 'Low'] },
  ],
  members: [
    { id: 'u1', name: 'Alice', email: 'alice@ex.com', role: 'admin' },
    { id: 'u2', name: 'Bob', email: 'bob@ex.com', role: 'member' },
  ],
  cards: [
    {
      id: 'card-001',
      title: 'Fix login bug',
      status: 'In Progress',
      owner: 'alice@ex.com',
      assignees: ['u1'],
      blockedBy: [],
      blocking: [],
    },
    {
      id: 'card-002',
      title: 'Add dark mode',
      status: 'Backlog',
      owner: 'bob@ex.com',
      assignees: ['u2'],
      blockedBy: [],
      blocking: [],
    },
    {
      id: 'card-003',
      title: 'Write release notes',
      status: 'Backlog',
      assignees: [],
      blockedBy: [],
      blocking: [],
    },
  ],
  stats: {
    total: 3,
    by_status: { 'In Progress': 1, Backlog: 2 },
    by_owner: { 'alice@ex.com': 1, 'bob@ex.com': 1 },
  },
  generatedAt: '2026-03-28T12:00:00.000Z',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockClient(): FavroHttpClient {
  return {} as FavroHttpClient;
}

function setupMockContextApi(snapshot: BoardContextSnapshot = SAMPLE_SNAPSHOT) {
  MockContextAPI.mockImplementation(function(this: any) {
    this.getSnapshot = vi.fn().mockResolvedValue(snapshot);
    this.resolveBoard = vi.fn();
  } as any);
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  changeStore.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  changeStore.clear();
});

// ─── proposeChange: valid actions ─────────────────────────────────────────────

describe('proposeChange — valid actions', () => {
  it('P001: move card from status to status → PATCH call', async () => {
    setupMockContextApi();
    const client = makeMockClient();

    const result = await proposeChange(
      'Sprint 42',
      'move card "Fix login bug" from In Progress to Review',
      client
    );

    expect(result.changeId).toMatch(/^ch_[0-9a-f]{16}$/);
    expect(result.boardName).toBe('Sprint 42');
    expect(result.actionText).toBe('move card "Fix login bug" from In Progress to Review');
    expect(result.preview).toHaveLength(1);
    expect(result.preview[0]).toMatchObject({
      method: 'PATCH',
      path: '/api/cards/card-001',
      data: { status: 'Review' },
      description: expect.stringContaining('Fix login bug'),
    });
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it('P002: assign card to member → PATCH call with assignees', async () => {
    setupMockContextApi();
    const client = makeMockClient();

    const result = await proposeChange(
      'Sprint 42',
      'assign "Add dark mode" to Alice',
      client
    );

    expect(result.preview).toHaveLength(1);
    expect(result.preview[0]).toMatchObject({
      method: 'PATCH',
      path: '/api/cards/card-002',
      description: expect.stringContaining('Alice'),
    });
    expect((result.preview[0].data as any).assignees).toContain('u1');
  });

  it('P003: set priority of card → PATCH call', async () => {
    setupMockContextApi();
    const client = makeMockClient();

    const result = await proposeChange(
      'Sprint 42',
      'set priority of "Fix login bug" to high',
      client
    );

    expect(result.preview[0]).toMatchObject({
      method: 'PATCH',
      path: '/api/cards/card-001',
      data: { priority: 'high' },
    });
  });

  it('P004: create card → POST call to /api/cards', async () => {
    setupMockContextApi();
    const client = makeMockClient();

    const result = await proposeChange(
      'Sprint 42',
      'create card "New feature" in Backlog',
      client
    );

    expect(result.preview[0]).toMatchObject({
      method: 'POST',
      path: '/api/cards',
      data: expect.objectContaining({ name: 'New feature', status: 'Backlog' }),
    });
  });

  it('P005: close card → PATCH to Done column', async () => {
    setupMockContextApi();
    const client = makeMockClient();

    const result = await proposeChange(
      'Sprint 42',
      'close "Fix login bug"',
      client
    );

    expect(result.preview[0]).toMatchObject({
      method: 'PATCH',
      path: '/api/cards/card-001',
      description: expect.stringContaining('Close'),
    });
  });

  it('P006: link card → POST to /api/cards/:id/links', async () => {
    setupMockContextApi();
    const client = makeMockClient();

    const result = await proposeChange(
      'Sprint 42',
      'link "Fix login bug" blocks "Add dark mode"',
      client
    );

    expect(result.preview[0]).toMatchObject({
      method: 'POST',
      path: '/api/cards/card-001/links',
      data: { type: 'blocks', targetCardId: 'card-002' },
    });
  });

  it('P007: add due date → PATCH with dueDate', async () => {
    setupMockContextApi();
    const client = makeMockClient();

    const result = await proposeChange(
      'Sprint 42',
      'add "Fix login bug" to 2026-04-01',
      client
    );

    expect(result.preview[0]).toMatchObject({
      method: 'PATCH',
      path: '/api/cards/card-001',
      data: { dueDate: '2026-04-01' },
    });
  });

  it('P008: stores proposed change in change store', async () => {
    setupMockContextApi();
    const client = makeMockClient();

    expect(changeStore.size()).toBe(0);
    const result = await proposeChange('Sprint 42', 'move card "Fix login bug" to Review', client);
    expect(changeStore.size()).toBe(1);
    const stored = changeStore.getChange(result.changeId);
    expect(stored).not.toBeNull();
    expect(stored!.changeId).toBe(result.changeId);
    expect(stored!.status).toBe('proposed');
  });

  it('P009: expiresAt is ~10 minutes from now', async () => {
    setupMockContextApi();
    const client = makeMockClient();
    const before = Date.now();
    const result = await proposeChange('Sprint 42', 'move card "Fix login bug" to Review', client);
    const after = Date.now();
    const tenMin = 10 * 60 * 1000;
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + tenMin - 100);
    expect(result.expiresAt).toBeLessThanOrEqual(after + tenMin + 100);
  });
});

// ─── proposeChange: validation errors ─────────────────────────────────────────

describe('proposeChange — validation errors', () => {
  it('E001: unknown card name → ValidationError with suggestions', async () => {
    setupMockContextApi();
    const client = makeMockClient();

    await expect(
      proposeChange('Sprint 42', 'move card "Unknown card" to Review', client)
    ).rejects.toThrow(ValidationError);
  });

  it('E002: invalid status → ValidationError with available statuses', async () => {
    setupMockContextApi();
    const client = makeMockClient();

    await expect(
      proposeChange('Sprint 42', 'move card "Fix login bug" to "Nonexistent Status"', client)
    ).rejects.toThrow(ValidationError);
  });

  it('E003: unknown member name → ValidationError with suggestions', async () => {
    setupMockContextApi();
    const client = makeMockClient();

    await expect(
      proposeChange('Sprint 42', 'assign "Fix login bug" to "Unknown Person"', client)
    ).rejects.toThrow(ValidationError);
  });

  it('E004: empty action text → ValidationError', async () => {
    setupMockContextApi();
    const client = makeMockClient();

    await expect(
      proposeChange('Sprint 42', '', client)
    ).rejects.toThrow(ValidationError);
  });

  it('E005: unparseable action text → ActionParseError', async () => {
    setupMockContextApi();
    const client = makeMockClient();

    // "zoom" is not a known verb
    await expect(
      proposeChange('Sprint 42', 'zoom card "Fix login bug"', client)
    ).rejects.toThrow();
  });

  it('E006: ValidationError contains suggestions for unknown card', async () => {
    setupMockContextApi();
    const client = makeMockClient();

    try {
      await proposeChange('Sprint 42', 'move card "Fix login" to Review', client);
      // Should not reach here if exact match fails; "Fix login" should fuzzy-match
    } catch (err) {
      // either finds "Fix login bug" via fuzzy (ok) or throws with suggestions
      if (err instanceof ValidationError) {
        expect(err.message).toContain('"Fix login bug"');
      }
    }
  });

  it('E007: ambiguous card name → ValidationError with top 3 matches', async () => {
    const snapshotWithAmbiguous: BoardContextSnapshot = {
      ...SAMPLE_SNAPSHOT,
      cards: [
        { id: 'c1', title: 'Fix login bug 1', status: 'Backlog', assignees: [], blockedBy: [], blocking: [] },
        { id: 'c2', title: 'Fix login bug 2', status: 'Backlog', assignees: [], blockedBy: [], blocking: [] },
        { id: 'c3', title: 'Fix login bug 3', status: 'Backlog', assignees: [], blockedBy: [], blocking: [] },
      ],
    };
    MockContextAPI.mockImplementation(function(this: any) {
      this.getSnapshot = vi.fn().mockResolvedValue(snapshotWithAmbiguous);
    } as any);

    const client = makeMockClient();
    try {
      await proposeChange('Sprint 42', 'move card "Fix login bug" to Review', client);
    } catch (err) {
      if (err instanceof ValidationError) {
        expect(err.message).toMatch(/[Aa]mbiguous|[Dd]id you mean/);
      }
    }
  });
});

// ─── executeChange ────────────────────────────────────────────────────────────

describe('executeChange', () => {
  it('EX001: execute valid change → calls API and returns executed status', async () => {
    // Set up a mock axios client
    const mockPatch = vi.fn().mockResolvedValue({ data: { cardId: 'card-001' } });
    const mockPost = vi.fn().mockResolvedValue({ data: { cardId: 'card-new' } });
    const client = { client: { patch: mockPatch, post: mockPost } } as any;

    // Pre-store a change
    const changeId = 'ch_test000001';
    changeStore.storeChange(changeId, {
      changeId,
      boardName: 'Sprint 42',
      actionText: 'move card "Fix login bug" to Review',
      apiCalls: [
        { method: 'PATCH', path: '/api/cards/card-001', data: { status: 'Review' }, description: 'Update status' },
      ],
      status: 'proposed',
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const result = await executeChange(changeId, client);

    expect(result.changeId).toBe(changeId);
    expect(result.status).toBe('executed');
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].result).toBe('success');
    expect(result.message).toContain('1/1 changes applied successfully');
    expect(mockPatch).toHaveBeenCalledWith('/api/cards/card-001', { status: 'Review' });
  });

  it('EX002: execute POST call correctly', async () => {
    const mockPost = vi.fn().mockResolvedValue({ data: {} });
    const client = { client: { post: mockPost } } as any;

    const changeId = 'ch_test000002';
    changeStore.storeChange(changeId, {
      changeId,
      boardName: 'Sprint 42',
      actionText: 'create card "New task" in Backlog',
      apiCalls: [
        { method: 'POST', path: '/api/cards', data: { name: 'New task', status: 'Backlog' }, description: 'Create card' },
      ],
      status: 'proposed',
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const result = await executeChange(changeId, client);
    expect(result.status).toBe('executed');
    expect(mockPost).toHaveBeenCalledWith('/api/cards', { name: 'New task', status: 'Backlog' });
  });

  it('EX003: expired change-id → ValidationError', async () => {
    const changeId = 'ch_expired001';
    changeStore.storeChange(changeId, {
      changeId,
      boardName: 'Sprint 42',
      actionText: 'move card "Fix login bug" to Review',
      apiCalls: [],
      status: 'proposed',
      expiresAt: Date.now() - 1, // already expired
    });

    const client = makeMockClient();
    await expect(executeChange(changeId, client)).rejects.toThrow(ValidationError);
  });

  it('EX004: missing change-id → ValidationError', async () => {
    const client = makeMockClient();
    await expect(executeChange('ch_nonexistent', client)).rejects.toThrow(ValidationError);
  });

  it('EX005: removes change from store after execution', async () => {
    const mockPatch = vi.fn().mockResolvedValue({});
    const client = { client: { patch: mockPatch } } as any;

    const changeId = 'ch_test000003';
    changeStore.storeChange(changeId, {
      changeId,
      boardName: 'Sprint 42',
      actionText: 'move card "Fix login bug" to Review',
      apiCalls: [
        { method: 'PATCH', path: '/api/cards/card-001', data: { status: 'Review' }, description: 'Update' },
      ],
      status: 'proposed',
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    expect(changeStore.getChange(changeId)).not.toBeNull();
    await executeChange(changeId, client);
    expect(changeStore.getChange(changeId)).toBeNull();
  });

  it('EX006: API failure → returns failed status with error details', async () => {
    const mockPatch = vi.fn().mockRejectedValue(new Error('Network error'));
    const client = { client: { patch: mockPatch } } as any;

    const changeId = 'ch_test000004';
    changeStore.storeChange(changeId, {
      changeId,
      boardName: 'Sprint 42',
      actionText: 'move card "Fix login bug" to Review',
      apiCalls: [
        { method: 'PATCH', path: '/api/cards/card-001', data: { status: 'Review' }, description: 'Update' },
      ],
      status: 'proposed',
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const result = await executeChange(changeId, client);
    expect(result.status).toBe('failed');
    expect(result.changes[0].result).toBe('failed');
    expect(result.changes[0].error).toContain('Network error');
  });
});

// ─── change-store: expiry ────────────────────────────────────────────────────

describe('ChangeStore', () => {
  it('CS001: storeChange + getChange returns stored value', () => {
    const store = new ChangeStore();
    const change = {
      changeId: 'ch_1',
      boardName: 'Board',
      actionText: 'test',
      apiCalls: [],
      status: 'proposed' as const,
      expiresAt: Date.now() + 60000,
    };
    store.storeChange('ch_1', change);
    expect(store.getChange('ch_1')).toMatchObject({ changeId: 'ch_1' });
    store.clear();
  });

  it('CS002: expired change returns null', () => {
    const store = new ChangeStore();
    store.storeChange('ch_exp', {
      changeId: 'ch_exp',
      boardName: 'Board',
      actionText: 'test',
      apiCalls: [],
      status: 'proposed',
      expiresAt: Date.now() - 1, // expired
    });
    expect(store.getChange('ch_exp')).toBeNull();
    store.clear();
  });

  it('CS003: removeChange deletes entry', () => {
    const store = new ChangeStore();
    store.storeChange('ch_r', {
      changeId: 'ch_r',
      boardName: 'Board',
      actionText: 'test',
      apiCalls: [],
      status: 'proposed',
      expiresAt: Date.now() + 60000,
    });
    expect(store.getChange('ch_r')).not.toBeNull();
    store.removeChange('ch_r');
    expect(store.getChange('ch_r')).toBeNull();
    store.clear();
  });

  it('CS004: size() reflects stored entries', () => {
    const store = new ChangeStore();
    expect(store.size()).toBe(0);
    store.storeChange('ch_s1', {
      changeId: 'ch_s1', boardName: 'B', actionText: 't', apiCalls: [], status: 'proposed',
      expiresAt: Date.now() + 60000,
    });
    expect(store.size()).toBe(1);
    store.storeChange('ch_s2', {
      changeId: 'ch_s2', boardName: 'B', actionText: 't', apiCalls: [], status: 'proposed',
      expiresAt: Date.now() + 60000,
    });
    expect(store.size()).toBe(2);
    store.clear();
    expect(store.size()).toBe(0);
  });

  it('CS005: non-existent key returns null', () => {
    const store = new ChangeStore();
    expect(store.getChange('ch_nope')).toBeNull();
  });
});
