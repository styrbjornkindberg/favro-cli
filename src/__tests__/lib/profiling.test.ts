/**
 * Unit tests — `CustomFieldCache` (src/lib/profiling.ts).
 *
 * Migrated from the retired vitest `tests/` tree (#71). The BulkTransaction
 * benchmarks that lived alongside these did not come across: they spent ~3s
 * asserting a 30s and a 5-minute ceiling against a mock, so no plausible
 * regression could make them red.
 *
 * WHAT WENT WITH THE DEAD HALF, so a dropped test count is not read as a lost
 * assertion. Two arms — `Profiler`'s span/throughput arm and
 * `ConcurrencyController`'s semaphore arm — covered code that had no production
 * caller after #110 deleted `bulk.ts` and no export from `src/index.ts` at any
 * point. They were the last references either class had, so nothing lost an
 * assertion about behaviour anything still runs.
 *
 * #110's `SLEPT = 49` fix went with them, and it is NOT transplanted here: it
 * loosened a `>= 50` floor across a `setTimeout(50)`, because libuv's
 * ms-truncated loop clock can fire a millisecond early against the
 * `performance.now()` delta the profiler read. The TTL arm below is not the same
 * shape — it sleeps 20ms against a 10ms TTL compared with `Date.now()`, so its
 * margin is a whole timer period rather than a millisecond, and there is no
 * floor here for that constant to loosen.
 */

import { CustomFieldCache } from '../../lib/profiling';

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
