/**
 * Integration Tests — Propose & Execute Workflow
 * CLA-1797 / FAVRO-035
 *
 * Tests the full propose→execute flow with mocked HTTP client.
 * Validates dry-run accuracy: what's previewed is exactly what executes.
 */

// Jest imports (vitest API compatible for test discovery)
import { proposeChange, executeChange, ValidationError } from '../../src/api/propose';
import { changeStore } from '../../src/lib/change-store';
import ContextAPI from '../../src/api/context';
import type { BoardContextSnapshot } from '../../src/api/context';
import FavroHttpClient from '../../src/lib/http-client';

jest.mock('../../src/api/context');

const MockContextAPI = ContextAPI as jest.MockedClass<typeof ContextAPI>;

const FULL_SNAPSHOT: BoardContextSnapshot = {
  board: { id: 'boards-sprint-42', name: 'Sprint 42', members: ['alice@ex.com', 'bob@ex.com'] },
  columns: [
    { id: 'col-backlog', name: 'Backlog', cardCount: 5 },
    { id: 'col-inprogress', name: 'In Progress', cardCount: 3 },
    { id: 'col-review', name: 'Review', cardCount: 1 },
    { id: 'col-done', name: 'Done', cardCount: 10 },
  ],
  customFields: [],
  members: [
    { id: 'user-alice', name: 'Alice', email: 'alice@ex.com', role: 'admin' },
    { id: 'user-bob', name: 'Bob', email: 'bob@ex.com', role: 'member' },
  ],
  cards: [
    {
      id: 'card-login',
      title: 'Fix login bug',
      status: 'In Progress',
      assignees: ['user-alice'],
      owner: 'alice@ex.com',
      blockedBy: [],
      blocking: [],
    },
    {
      id: 'card-darkmode',
      title: 'Add dark mode',
      status: 'Backlog',
      assignees: ['user-bob'],
      owner: 'bob@ex.com',
      blockedBy: [],
      blocking: [],
    },
    {
      id: 'card-release',
      title: 'Write release notes',
      status: 'Backlog',
      assignees: [],
      blockedBy: [],
      blocking: [],
    },
  ],
  stats: { total: 3, by_status: { 'In Progress': 1, Backlog: 2 }, by_owner: {} },
  generatedAt: '2026-03-28T12:00:00.000Z',
};

function makeMockHttpClient(options?: {
  patch?: jest.Mock;
  post?: jest.Mock;
}) {
  return {
    client: {
      patch: options?.patch ?? jest.fn().mockResolvedValue({}),
      post: options?.post ?? jest.fn().mockResolvedValue({}),
      get: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
  } as unknown as FavroHttpClient;
}

beforeEach(() => {
  changeStore.clear();
  jest.clearAllMocks();
  (MockContextAPI as any).mockImplementation(function(this: any) {
    this.getSnapshot = jest.fn().mockResolvedValue(FULL_SNAPSHOT);
    this.resolveBoard = jest.fn();
  });
});

afterEach(() => {
  changeStore.clear();
});

// ─── Full propose → execute workflow ─────────────────────────────────────────

describe('Integration: propose → execute workflow', () => {
  it('W001: propose then execute a move — dry-run accuracy 100%', async () => {
    const mockPatch = jest.fn().mockResolvedValue({});
    const client = makeMockHttpClient({ patch: mockPatch });

    // Step 1: Propose
    const proposal = await proposeChange(
      'Sprint 42',
      'move card "Fix login bug" from In Progress to Review',
      client
    );

    expect(proposal.changeId).toMatch(/^ch_[0-9a-f]{16}$/);
    expect(proposal.preview).toHaveLength(1);
    const previewCall = proposal.preview[0];
    expect(previewCall.method).toBe('PATCH');
    expect(previewCall.path).toBe('/api/cards/card-login');
    expect((previewCall.data as any).status).toBe('Review');

    // Verify the change-id is stored
    expect(changeStore.getChange(proposal.changeId)).not.toBeNull();

    // Step 2: Execute
    const execution = await executeChange(proposal.changeId, client);

    expect(execution.status).toBe('executed');
    expect(execution.changeId).toBe(proposal.changeId);
    expect(execution.changes).toHaveLength(1);

    // Dry-run accuracy: the actual API call matches exactly what was previewed
    expect(mockPatch).toHaveBeenCalledWith(previewCall.path, previewCall.data);
    expect(execution.changes[0].result).toBe('success');

    // Change should be removed from store after execution
    expect(changeStore.getChange(proposal.changeId)).toBeNull();
  });

  it('W002: propose then execute an assign', async () => {
    const mockPatch = jest.fn().mockResolvedValue({});
    const client = makeMockHttpClient({ patch: mockPatch });

    const proposal = await proposeChange('Sprint 42', 'assign "Add dark mode" to Alice', client);
    const previewData = proposal.preview[0].data as any;

    // Preview should include Alice's user ID
    expect(previewData.assignees).toContain('user-alice');

    const execution = await executeChange(proposal.changeId, client);
    expect(execution.status).toBe('executed');
    expect(mockPatch).toHaveBeenCalledWith('/api/cards/card-darkmode', previewData);
  });

  it('W003: propose then execute a create', async () => {
    const mockPost = jest.fn().mockResolvedValue({});
    const client = makeMockHttpClient({ post: mockPost });

    const proposal = await proposeChange('Sprint 42', 'create card "Deploy to staging" in Backlog', client);
    const previewCall = proposal.preview[0];

    expect(previewCall.method).toBe('POST');
    expect(previewCall.path).toBe('/api/cards');

    const execution = await executeChange(proposal.changeId, client);
    expect(execution.status).toBe('executed');
    expect(mockPost).toHaveBeenCalledWith('/api/cards', previewCall.data);
  });

  it('W004: validation error in propose prevents execute', async () => {
    const client = makeMockHttpClient();

    // This should fail validation (unknown card)
    await expect(
      proposeChange('Sprint 42', 'move card "Totally Unknown Card XYZ" to Review', client)
    ).rejects.toThrow(ValidationError);

    // Nothing should be stored
    expect(changeStore.size()).toBe(0);
  });

  it('W005: cannot execute same change-id twice', async () => {
    const mockPatch = jest.fn().mockResolvedValue({});
    const client = makeMockHttpClient({ patch: mockPatch });

    const proposal = await proposeChange('Sprint 42', 'move card "Fix login bug" to Review', client);
    await executeChange(proposal.changeId, client);

    // Second execute should fail (change removed after first)
    await expect(executeChange(proposal.changeId, client)).rejects.toThrow(ValidationError);
  });

  it('W006: multiple independent proposals coexist in store', async () => {
    const client = makeMockHttpClient();

    const p1 = await proposeChange('Sprint 42', 'move card "Fix login bug" to Review', client);
    const p2 = await proposeChange('Sprint 42', 'move card "Add dark mode" to In Progress', client);

    expect(p1.changeId).not.toBe(p2.changeId);
    expect(changeStore.size()).toBe(2);

    expect(changeStore.getChange(p1.changeId)).not.toBeNull();
    expect(changeStore.getChange(p2.changeId)).not.toBeNull();
  });

  it('W007: close action targets the Done column', async () => {
    const mockPatch = jest.fn().mockResolvedValue({});
    const client = makeMockHttpClient({ patch: mockPatch });

    const proposal = await proposeChange('Sprint 42', 'close "Fix login bug"', client);
    const previewCall = proposal.preview[0];

    expect(previewCall.method).toBe('PATCH');
    // Should set status to a done-like column
    expect((previewCall.data as any).status).toBe('Done');

    const execution = await executeChange(proposal.changeId, client);
    expect(execution.status).toBe('executed');
  });
});

// ─── Error scenarios ──────────────────────────────────────────────────────────

describe('Integration: error paths', () => {
  it('E001: ValidationError message includes correction hint', async () => {
    const client = makeMockHttpClient();

    try {
      await proposeChange('Sprint 42', 'move card "Fix Login Bug" to "Nonexistent"', client);
      throw new Error('Should have thrown ValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const msg = (err as ValidationError).message;
      // Should mention available columns
      expect(msg).toMatch(/[Aa]vailable|[Ss]uggestion|not found/i);
    }
  });

  it('E002: execute with malformed change-id → clear error', async () => {
    const client = makeMockHttpClient();
    try {
      await executeChange('not-a-valid-id', client);
      throw new Error('Should have thrown ValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toContain('not found or has expired');
    }
  });
});
