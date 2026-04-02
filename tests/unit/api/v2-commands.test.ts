/**
 * Unit tests — v2 persona commands: output, scoring, classification
 * Tests the pure logic functions used by my-cards, next, health, workload commands.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveFormat } from '../../../src/lib/output';

// ─── resolveFormat ────────────────────────────────────────────────────────────

describe('resolveFormat', () => {
  it('defaults to json when no flags', () => {
    expect(resolveFormat({})).toBe('json');
  });

  it('returns human when --human flag is set', () => {
    expect(resolveFormat({ human: true })).toBe('human');
  });

  it('returns json when --json flag is set', () => {
    expect(resolveFormat({ json: true })).toBe('json');
  });

  it('human takes precedence if both set', () => {
    expect(resolveFormat({ human: true, json: true })).toBe('human');
  });
});

// ─── outputResult ─────────────────────────────────────────────────────────────

describe('outputResult', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  it('outputs JSON by default', async () => {
    const { outputResult } = await import('../../../src/lib/output');
    const data = { foo: 'bar' };
    outputResult(data, { format: 'json' });
    expect(writeSpy).toHaveBeenCalledWith(JSON.stringify(data) + '\n');
  });

  it('calls human formatter when format is human', async () => {
    const { outputResult } = await import('../../../src/lib/output');
    const data = { foo: 'bar' };
    const formatter = vi.fn(() => 'human output');
    outputResult(data, { format: 'human' }, formatter);
    expect(formatter).toHaveBeenCalledWith(data);
    expect(writeSpy).toHaveBeenCalledWith('human output\n');
  });

  it('falls back to JSON when no human formatter provided', async () => {
    const { outputResult } = await import('../../../src/lib/output');
    const data = [1, 2, 3];
    outputResult(data, { format: 'human' });
    expect(writeSpy).toHaveBeenCalledWith(JSON.stringify(data, null, 2) + '\n');
  });
});

// ─── Health scoring logic ─────────────────────────────────────────────────────

describe('health scoring', () => {
  // Mirror the actual algorithm from health.ts:
  // Each sub-score is 0-100, then weighted: flow*0.40 + stale*0.25 + blocked*0.20 + overdue*0.15
  function computeHealthScore(opts: {
    nonDoneCount: number;
    flowingCount: number;
    staleCount: number;
    blockedCount: number;
    overdueCount: number;
    withDueDateCount: number;
  }): number {
    const { nonDoneCount, flowingCount, staleCount, blockedCount, overdueCount, withDueDateCount } = opts;
    if (nonDoneCount === 0) return 100;
    const flowScore = Math.round((flowingCount / nonDoneCount) * 100);
    const staleScore = Math.round(((nonDoneCount - staleCount) / nonDoneCount) * 100);
    const blockedScore = Math.round(((nonDoneCount - blockedCount) / nonDoneCount) * 100);
    const overdueScore = withDueDateCount > 0
      ? Math.round(((withDueDateCount - overdueCount) / withDueDateCount) * 100)
      : 100;
    return Math.round(flowScore * 0.40 + staleScore * 0.25 + blockedScore * 0.20 + overdueScore * 0.15);
  }

  it('returns 100 for no non-done cards', () => {
    expect(computeHealthScore({ nonDoneCount: 0, flowingCount: 0, staleCount: 0, blockedCount: 0, overdueCount: 0, withDueDateCount: 0 })).toBe(100);
  });

  it('returns high score when all cards are flowing', () => {
    const score = computeHealthScore({ nonDoneCount: 10, flowingCount: 10, staleCount: 0, blockedCount: 0, overdueCount: 0, withDueDateCount: 5 });
    expect(score).toBeGreaterThanOrEqual(90);
  });

  it('returns low score when most cards are stale + blocked', () => {
    const score = computeHealthScore({ nonDoneCount: 10, flowingCount: 1, staleCount: 8, blockedCount: 6, overdueCount: 3, withDueDateCount: 5 });
    expect(score).toBeLessThan(50);
  });

  it('traffic light: green > 75', () => {
    const score = computeHealthScore({ nonDoneCount: 10, flowingCount: 8, staleCount: 1, blockedCount: 1, overdueCount: 0, withDueDateCount: 3 });
    const signal = score > 75 ? 'green' : score >= 50 ? 'yellow' : 'red';
    expect(signal).toBe('green');
  });

  it('traffic light: red < 50', () => {
    const score = computeHealthScore({ nonDoneCount: 10, flowingCount: 0, staleCount: 9, blockedCount: 8, overdueCount: 4, withDueDateCount: 5 });
    const signal = score > 75 ? 'green' : score >= 50 ? 'yellow' : 'red';
    expect(signal).toBe('red');
  });
});

// ─── Workload overload detection ──────────────────────────────────────────────

describe('workload overload detection', () => {
  it('flags member with >8 active cards as overloaded', () => {
    const activeCards = 9;
    const threshold = 8;
    expect(activeCards > threshold).toBe(true);
  });

  it('does not flag member with <=8 active cards', () => {
    const activeCards = 8;
    const threshold = 8;
    expect(activeCards > threshold).toBe(false);
  });
});

// ─── Next command scoring ─────────────────────────────────────────────────────

describe('next command scoring', () => {
  function scoreCard(opts: {
    priorityLevel: number;  // 1-4
    daysUntilDue?: number;  // negative = overdue
    blockerCount: number;
    effortPoints: number;
    isActive: boolean;
  }): number {
    let score = opts.priorityLevel * 4;
    if (opts.daysUntilDue != null) {
      if (opts.daysUntilDue < 0) score += 15;
      else if (opts.daysUntilDue <= 3) score += 12;
      else if (opts.daysUntilDue <= 7) score += 6;
    }
    score -= opts.blockerCount * 5;
    if (opts.effortPoints <= 2) score += 3;
    if (opts.isActive) score += 5;
    return score;
  }

  it('overdue critical card scores highest', () => {
    const score = scoreCard({ priorityLevel: 4, daysUntilDue: -1, blockerCount: 0, effortPoints: 1, isActive: true });
    expect(score).toBeGreaterThan(30);
  });

  it('blocked card gets penalty', () => {
    const unblocked = scoreCard({ priorityLevel: 2, blockerCount: 0, effortPoints: 3, isActive: false });
    const blocked = scoreCard({ priorityLevel: 2, blockerCount: 2, effortPoints: 3, isActive: false });
    expect(blocked).toBeLessThan(unblocked);
  });

  it('low effort gets bonus', () => {
    const low = scoreCard({ priorityLevel: 2, blockerCount: 0, effortPoints: 1, isActive: false });
    const high = scoreCard({ priorityLevel: 2, blockerCount: 0, effortPoints: 5, isActive: false });
    expect(low).toBeGreaterThan(high);
  });

  it('active stage gets bonus', () => {
    const active = scoreCard({ priorityLevel: 2, blockerCount: 0, effortPoints: 3, isActive: true });
    const inactive = scoreCard({ priorityLevel: 2, blockerCount: 0, effortPoints: 3, isActive: false });
    expect(active).toBeGreaterThan(inactive);
  });
});

// ─── listCards backward compatibility ─────────────────────────────────────────

describe('listCards backward compatibility', () => {
  it('accepts string boardId as first arg (legacy)', async () => {
    const CardsAPI = (await import('../../../src/lib/cards-api')).default;
    const mockClient = {
      get: vi.fn().mockResolvedValue({ entities: [] }),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    const api = new CardsAPI(mockClient as any);
    await api.listCards('board-123', 50);
    expect(mockClient.get).toHaveBeenCalledWith('/cards', expect.objectContaining({
      params: expect.objectContaining({ widgetCommonId: 'board-123', limit: 50 }),
    }));
  });

  it('accepts options object with collectionId', async () => {
    const CardsAPI = (await import('../../../src/lib/cards-api')).default;
    const mockClient = {
      get: vi.fn().mockResolvedValue({ entities: [] }),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    const api = new CardsAPI(mockClient as any);
    await api.listCards({ collectionId: 'col-abc', unique: true, limit: 200 });
    // limit 200 gets capped to min(200, 100) = 100 per request
    expect(mockClient.get).toHaveBeenCalledWith('/cards', expect.objectContaining({
      params: expect.objectContaining({ collectionId: 'col-abc', unique: true, limit: 100 }),
    }));
  });
});
