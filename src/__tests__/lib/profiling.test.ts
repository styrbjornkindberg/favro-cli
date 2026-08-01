/**
 * Unit tests — Profiler, CustomFieldCache and ConcurrencyController
 * (src/lib/profiling.ts, live via bulk.ts and custom-fields-api.ts).
 *
 * Migrated from the retired vitest `tests/` tree (#71). The BulkTransaction
 * benchmarks that lived alongside these did not come across: they spent ~3s
 * asserting a 30s and a 5-minute ceiling against a mock, so no plausible
 * regression could make them red.
 */

import {
  Profiler,
  CustomFieldCache,
  ConcurrencyController,
} from '../../lib/profiling';

describe('Profiler', () => {
  it('measures span durations and derives throughput from the item count', async () => {
    const profiler = new Profiler('test');
    const span = profiler.startSpan('work');
    await new Promise((r) => setTimeout(r, 50));
    profiler.endSpan(span);
    const result = profiler.finish(10);

    expect(result.name).toBe('test');
    expect(result.totalMs).toBeGreaterThanOrEqual(50);
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0].durationMs).toBeGreaterThanOrEqual(50);
    expect(result.itemCount).toBe(10);
    expect(result.throughput).toBeGreaterThan(0);
  });
});

describe('CustomFieldCache', () => {
  it('caches field definitions and counts the hit and the miss', () => {
    const cache = new CustomFieldCache({ ttlMs: 60000 });
    const field = { fieldId: 'f1', name: 'Priority', type: 'select' };

    expect(cache.get('f1')).toBeNull();
    cache.set('f1', field);
    expect(cache.get('f1')).toEqual(field);

    const stats = cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBe('50%');
  });

  it('expires entries after TTL', async () => {
    const cache = new CustomFieldCache({ ttlMs: 10 });
    cache.set('f1', { fieldId: 'f1', name: 'Test', type: 'text' });
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.get('f1')).toBeNull();
  });

  it('pre-warms cache from field array', () => {
    const cache = new CustomFieldCache();
    const fields = [
      { fieldId: 'f1', name: 'Priority', type: 'select' },
      { fieldId: 'f2', name: 'Assignee', type: 'user' },
    ];
    cache.preWarm(fields);
    expect(cache.get('f1')).toEqual(fields[0]);
    expect(cache.get('f2')).toEqual(fields[1]);
  });

  it('serves 1000 repeat reads of one field without a second miss', () => {
    const cache = new CustomFieldCache({ ttlMs: 60000 });
    cache.set('f1', { fieldId: 'f1', name: 'Status', type: 'select' });
    for (let i = 0; i < 1000; i++) {
      cache.get('f1');
    }

    const stats = cache.stats();
    expect(stats.hits).toBe(1000);
    expect(stats.misses).toBe(0);
    expect(stats.hitRate).toBe('100%');
  });
});

describe('ConcurrencyController', () => {
  it('runs tasks in parallel but never more than maxConcurrent at once', async () => {
    const controller = new ConcurrencyController(3);
    let activeAtOnce = 0;
    let maxActive = 0;

    const tasks = Array.from({ length: 10 }, () => async () => {
      activeAtOnce++;
      maxActive = Math.max(maxActive, activeAtOnce);
      await new Promise((r) => setTimeout(r, 10));
      activeAtOnce--;
    });

    await controller.runAll(tasks);
    // Both directions: a sequential implementation would leave maxActive at 1,
    // an unbounded one would reach 10.
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActive).toBeGreaterThan(1);
  });
});
