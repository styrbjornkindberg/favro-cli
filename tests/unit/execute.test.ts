/**
 * Unit Tests — Execute Command
 * CLA-1797 / FAVRO-035
 *
 * Tests for the execute command handler (src/commands/execute.ts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { changeStore } from '../../src/lib/change-store';
import { executeChange, ValidationError } from '../../src/api/propose';

beforeEach(() => {
  changeStore.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  changeStore.clear();
});

describe('executeChange — command integration', () => {
  it('EC001: execute known change-id atomically', async () => {
    const mockPatch = vi.fn().mockResolvedValue({});
    const client = { client: { patch: mockPatch } } as any;

    const changeId = 'ch_exec0001';
    changeStore.storeChange(changeId, {
      changeId,
      boardName: 'Sprint 42',
      actionText: 'move card "Fix login" to Review',
      apiCalls: [
        { method: 'PATCH', path: '/api/cards/c1', data: { status: 'Review' }, description: 'Update status' },
        { method: 'PATCH', path: '/api/cards/c2', data: { status: 'Review' }, description: 'Update status 2' },
      ],
      status: 'proposed',
      expiresAt: Date.now() + 600000,
    });

    const result = await executeChange(changeId, client);

    expect(result.status).toBe('executed');
    expect(result.changes).toHaveLength(2);
    expect(result.changes.every(c => c.result === 'success')).toBe(true);
    // Verify atomic: both PATCH calls were made
    expect(mockPatch).toHaveBeenCalledTimes(2);
    expect(result.message).toBe('2/2 changes applied successfully');
  });

  it('EC002: multiple API call types execute correctly', async () => {
    const mockPatch = vi.fn().mockResolvedValue({});
    const mockPost = vi.fn().mockResolvedValue({});
    const client = { client: { patch: mockPatch, post: mockPost } } as any;

    const changeId = 'ch_exec0002';
    changeStore.storeChange(changeId, {
      changeId,
      boardName: 'Sprint 42',
      actionText: 'create + move',
      apiCalls: [
        { method: 'POST', path: '/api/cards', data: { name: 'New' }, description: 'Create' },
        { method: 'PATCH', path: '/api/cards/c1', data: { status: 'Done' }, description: 'Update' },
      ],
      status: 'proposed',
      expiresAt: Date.now() + 600000,
    });

    const result = await executeChange(changeId, client);
    expect(result.status).toBe('executed');
    expect(mockPost).toHaveBeenCalledOnce();
    expect(mockPatch).toHaveBeenCalledOnce();
  });

  it('EC003: expired change-id returns ValidationError with message', async () => {
    const client = {} as any;
    const changeId = 'ch_exec_expired';
    changeStore.storeChange(changeId, {
      changeId,
      boardName: 'Sprint 42',
      actionText: 'test',
      apiCalls: [],
      status: 'proposed',
      expiresAt: Date.now() - 100,
    });

    try {
      await executeChange(changeId, client);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toContain('expired');
      expect((err as ValidationError).message).toContain('10 minutes');
    }
  });
});
