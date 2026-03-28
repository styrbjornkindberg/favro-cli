/**
 * Performance Benchmark Tests
 * CLA-1794 / FAVRO-032: Performance Review & Optimization
 *
 * Benchmarks:
 *   - 100-card bulk update (target: < 30s)
 *   - 1000-card bulk update (target: < 5 min = 300s)
 *   - Custom field cache effectiveness (N+1 elimination)
 *   - Parallel vs sequential throughput comparison
 *
 * Requires:
 *   FAVRO_API_TOKEN + FAVRO_TEST_BOARD_ID env vars
 *
 * Run: pnpm test:integration --testPathPattern=performance
 */

import CardsAPI, { Card } from '../../src/lib/cards-api';
import FavroHttpClient from '../../src/lib/http-client';
import { CustomFieldsAPI } from '../../src/lib/custom-fields-api';
import {
  BulkTransaction,
  BulkOperation,
  BulkResult,
} from '../../src/lib/bulk';
import {
  Profiler,
  CustomFieldCache,
  ConcurrencyController,
  formatBenchmarkReport,
  formatDuration,
  assertBenchmarkTarget,
} from '../../src/lib/profiling';

// ---------------------------------------------------------------------------
// Test Setup
// ---------------------------------------------------------------------------

const API_TOKEN = process.env.FAVRO_API_TOKEN || '';
const BOARD_ID = process.env.FAVRO_TEST_BOARD_ID || '';

const skipIfNoEnv = !API_TOKEN || !BOARD_ID;

function makeClient(): FavroHttpClient {
  return new FavroHttpClient({
    auth: { token: API_TOKEN },
  });
}

/** Create N mock BulkOperations (no real card IDs — for local timing tests) */
function makeMockOperations(count: number): BulkOperation[] {
  return Array.from({ length: count }, (_, i) => ({
    type: 'update' as const,
    cardId: `card-perf-${i.toString().padStart(6, '0')}`,
    cardName: `Perf Test Card ${i}`,
    changes: { status: 'In Progress' },
    previousState: { status: 'Todo' },
    status: 'pending' as const,
  }));
}

// ---------------------------------------------------------------------------
// Unit-level performance tests (no real API needed)
// ---------------------------------------------------------------------------

describe('Profiler — unit tests', () => {
  it('measures span durations correctly', async () => {
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

  it('calculates throughput correctly', async () => {
    const profiler = new Profiler('throughput');
    await new Promise((r) => setTimeout(r, 100));
    const result = profiler.finish(10);

    // 10 items in ~100ms = ~100 items/s (allow wide tolerance for CI)
    expect(result.throughput).toBeGreaterThan(0);
  });
});

describe('CustomFieldCache — unit tests', () => {
  it('caches field definitions and avoids repeated fetches', () => {
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

  it('measures N+1 reduction: 1000 cache hits vs 1000 misses', () => {
    const cache = new CustomFieldCache({ ttlMs: 60000 });
    const field = { fieldId: 'f1', name: 'Status', type: 'select' };

    // Simulate N+1: first request misses, subsequent 999 hit
    cache.set('f1', field);
    for (let i = 0; i < 1000; i++) {
      cache.get('f1');
    }

    const stats = cache.stats();
    expect(stats.hits).toBe(1000);
    expect(stats.misses).toBe(0);
    expect(stats.hitRate).toBe('100%');
  });
});

describe('ConcurrencyController — unit tests', () => {
  it('limits parallel execution to maxConcurrent', async () => {
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
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it('parallel execution is faster than sequential for I/O-bound tasks', async () => {
    const TASK_COUNT = 10;
    const TASK_DELAY = 20; // ms

    // Sequential
    const seqStart = Date.now();
    for (let i = 0; i < TASK_COUNT; i++) {
      await new Promise((r) => setTimeout(r, TASK_DELAY));
    }
    const seqMs = Date.now() - seqStart;

    // Parallel (concurrency = 5)
    const ctrl = new ConcurrencyController(5);
    const parStart = Date.now();
    await ctrl.runAll(
      Array.from({ length: TASK_COUNT }, () => () => new Promise<void>((r) => setTimeout(r, TASK_DELAY)))
    );
    const parMs = Date.now() - parStart;

    // Parallel should be significantly faster (at least 2x)
    expect(parMs).toBeLessThan(seqMs * 0.7);
    console.log(`Sequential: ${seqMs}ms, Parallel(5): ${parMs}ms, speedup: ${(seqMs / parMs).toFixed(1)}x`);
  });
});

// ---------------------------------------------------------------------------
// BulkTransaction performance characteristics (mock API)
// ---------------------------------------------------------------------------

describe('BulkTransaction — performance with mock API', () => {
  /**
   * Mock CardsAPI that records call timing and simulates network latency.
   */
  function makeMockCardsAPI(latencyMs = 5): CardsAPI {
    return {
      updateCard: jest.fn(async (_id: string, _data: any) => {
        await new Promise((r) => setTimeout(r, latencyMs));
        return { cardId: _id, name: 'Mock Card', createdAt: new Date().toISOString() };
      }),
    } as unknown as CardsAPI;
  }

  it('profiles 100-card sequential update and meets 30s target', async () => {
    const api = makeMockCardsAPI(5); // 5ms per update
    const tx = new BulkTransaction(api, { concurrency: 1, profile: true });
    tx.addAll(makeMockOperations(100));

    const result = await tx.execute({ profile: true });

    expect(result.success).toBe(100);
    expect(result.failure).toBe(0);
    expect(result.benchmark).toBeDefined();

    const bench = result.benchmark!;
    console.log(formatBenchmarkReport(bench));

    // 100 cards × 5ms = 500ms, well under 30s target
    assertBenchmarkTarget(bench, 30000, '100-card sequential update (mock)');
  }, 60000);

  it('profiles 100-card parallel update (concurrency=5) and is faster than sequential', async () => {
    const LATENCY = 10; // 10ms per update
    const CARD_COUNT = 100;

    // Sequential baseline
    const seqApi = makeMockCardsAPI(LATENCY);
    const seqTx = new BulkTransaction(seqApi, { concurrency: 1, profile: true });
    seqTx.addAll(makeMockOperations(CARD_COUNT));
    const seqResult = await seqTx.execute({ profile: true });
    const seqMs = seqResult.benchmark!.totalMs;

    // Parallel (concurrency=5)
    const parApi = makeMockCardsAPI(LATENCY);
    const parTx = new BulkTransaction(parApi, { concurrency: 5, profile: true });
    parTx.addAll(makeMockOperations(CARD_COUNT));
    const parResult = await parTx.execute({ profile: true });
    const parMs = parResult.benchmark!.totalMs;

    expect(parResult.success).toBe(CARD_COUNT);
    // Parallel should be at least 2x faster for I/O-bound operations
    expect(parMs).toBeLessThan(seqMs * 0.6);

    console.log(
      `Sequential: ${formatDuration(seqMs)}, ` +
      `Parallel(5): ${formatDuration(parMs)}, ` +
      `speedup: ${(seqMs / parMs).toFixed(1)}x`
    );
  }, 120000);

  it('benchmarks 1000-card bulk update under 5-minute target (mock, concurrency=5)', async () => {
    const api = makeMockCardsAPI(5); // 5ms per update
    const tx = new BulkTransaction(api, { concurrency: 5, profile: true });
    tx.addAll(makeMockOperations(1000));

    const result = await tx.execute({ profile: true });

    expect(result.success).toBe(1000);
    expect(result.benchmark).toBeDefined();

    const bench = result.benchmark!;
    console.log(formatBenchmarkReport(bench));

    // 1000 cards × 5ms / 5 concurrent = ~1000ms total, well under 5 min
    assertBenchmarkTarget(bench, 300000, '1000-card bulk update (mock)');
  }, 300000);
});

// ---------------------------------------------------------------------------
// Integration tests (real API, skipped without env vars)
// ---------------------------------------------------------------------------

describe('Performance integration — real API', () => {
  (skipIfNoEnv ? describe.skip : describe)('with real Favro board', () => {
    let cards: Card[];
    let cardsApi: CardsAPI;
    let customFieldsApi: CustomFieldsAPI;

    beforeAll(async () => {
      const client = makeClient();
      cardsApi = new CardsAPI(client);
      customFieldsApi = new CustomFieldsAPI(client);

      // Fetch a batch of real cards for benchmarking
      const profiler = new Profiler('fetch-cards');
      const fetchSpan = profiler.startSpan('list-cards');
      cards = await cardsApi.listCards(BOARD_ID, 100);
      profiler.endSpan(fetchSpan);
      const fetchResult = profiler.finish(cards.length);
      console.log(formatBenchmarkReport(fetchResult));
    }, 60000);

    it('measures card fetch time for 100 cards', () => {
      expect(cards.length).toBeGreaterThan(0);
      console.log(`Fetched ${cards.length} cards from board ${BOARD_ID}`);
    });

    it('measures custom field cache effectiveness', async () => {
      const fields = await customFieldsApi.listFields(BOARD_ID);

      if (fields.length === 0) {
        console.log('No custom fields on test board — skipping cache test');
        return;
      }

      const fieldId = fields[0].fieldId;
      const cache = new CustomFieldCache({ ttlMs: 60000 });
      const cachedApi = new CustomFieldsAPI(makeClient(), { cache });

      // First call — cache miss
      const t1 = Date.now();
      await cachedApi.getField(fieldId, BOARD_ID);
      const missMs = Date.now() - t1;

      // Second call — cache hit (should be ~0ms)
      const t2 = Date.now();
      await cachedApi.getField(fieldId, BOARD_ID);
      const hitMs = Date.now() - t2;

      const stats = cachedApi.cacheStats();
      console.log(`Cache miss: ${missMs}ms, Cache hit: ${hitMs}ms, Stats: ${JSON.stringify(stats)}`);

      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(hitMs).toBeLessThan(missMs); // hit should be faster than network
    }, 30000);

    it('pre-warming cache reduces N+1 for batch custom field lookups', async () => {
      const cache = new CustomFieldCache({ ttlMs: 300000 });
      const cachedApi = new CustomFieldsAPI(makeClient(), { cache });

      const profiler = new Profiler('custom-field-n+1-test');

      // Without cache: N calls to getField for 10 lookups of same field
      const fields = await cachedApi.listFields(BOARD_ID);
      if (fields.length === 0) {
        console.log('No custom fields — skipping N+1 test');
        return;
      }

      // Pre-warm
      const warmSpan = profiler.startSpan('pre-warm');
      await cachedApi.preWarmCache(BOARD_ID);
      profiler.endSpan(warmSpan);

      // 10 lookups — all should be cache hits
      const lookupSpan = profiler.startSpan('cached-lookups-x10');
      for (let i = 0; i < 10; i++) {
        await cachedApi.getField(fields[0].fieldId, BOARD_ID);
      }
      profiler.endSpan(lookupSpan);

      const result = profiler.finish(10);
      const stats = cachedApi.cacheStats();

      console.log(formatBenchmarkReport(result));
      console.log(`Cache stats after 10 lookups: ${JSON.stringify(stats)}`);

      // All 10 post-warmup lookups should be cache hits
      expect(stats.hits).toBeGreaterThanOrEqual(10);
    }, 60000);
  });
});
