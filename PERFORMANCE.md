# Performance Documentation

**CLA-1794 / FAVRO-032: Performance Review & Optimization**

---

## ⚠️ Benchmark Disclaimer — Read First

**All benchmarks in this document are simulated using an in-process mock API with configurable fake latency. They have NOT been run against the real Favro API.**

The simulated latency used in benchmarks is **5ms per call**, which is **10–40× lower** than real-world Favro API latency (typically 50–200ms per call from EU). See [Real-World Scaling Projections](#real-world-scaling-projections) for honest estimates.

Benchmark numbers measure the **algorithmic efficiency** of the implementation (concurrency model, cache hit rates, parallelism gains) — not end-to-end wall-clock performance against a live API.

---

## Overview

This document describes the profiling methodology, benchmark results, optimizations
implemented, and recommendations for further improvements to the Favro CLI's bulk
operation performance.

---

## Profiling Methodology

### Tools

- **`src/lib/profiling.ts`** — Custom profiler with named span tracking, throughput
  calculation, and heap memory measurement
- **Jest performance tests** — `tests/integration/performance.test.ts` with both
  mock-API benchmarks (CI-safe) and real-API integration tests

### Approach

1. **Span-based timing**: Named spans wrap each logical phase (card fetch, field lookup,
   individual updates, rollback). This pinpoints where time is spent.
2. **Mock API benchmarks**: Simulate configurable network latency to measure algorithmic
   efficiency without real API availability. **These are not real measurements.**
3. **Real API integration tests**: Optional (require `FAVRO_API_TOKEN` + `FAVRO_TEST_BOARD_ID`)
   for end-to-end validation. Currently skipped (see [Skipped Tests](#skipped-tests)).
4. **N+1 measurement**: Cache hit/miss counters expose whether field lookups are redundant.

### How to Profile

```bash
# Run all performance tests (mock API, CI-safe):
pnpm test:integration --testPathPattern=performance

# With real API (required for real numbers):
FAVRO_API_TOKEN=xxx FAVRO_TEST_BOARD_ID=yyy pnpm test:integration --testPathPattern=performance
```

---

## Simulated Benchmark Results

> **These benchmarks use a mock API with 5ms simulated latency. Real Favro API latency is 50–200ms.**
> See [Real-World Scaling Projections](#real-world-scaling-projections) for estimates at realistic latency.

Measured on a local machine (M-series Mac, Node.js v18+).

### 100 Cards — Sequential Update (mock, 5ms latency)

| Metric | Value |
|--------|-------|
| Total time | ~623ms |
| Items processed | 100 |
| Throughput | ~160 items/s |
| Peak heap | ~234 MB |

### 100 Cards — Parallel Update (mock, 5ms latency, concurrency=5)

| Metric | Value |
|--------|-------|
| Total time | ~44ms |
| Speedup vs sequential | ~4.9x |
| Throughput | ~2,273 items/s |

### 1000 Cards — Parallel Update (mock, 5ms latency, concurrency=5)

| Metric | Value |
|--------|-------|
| Total time | ~1.23s |
| Items processed | 1,000 |
| Throughput | ~812 items/s |
| Peak heap | ~240 MB |
| vs 5-minute target | **✅ 97.6% under budget** |

> **Important:** The ~1.23s figure is a simulated result at 5ms/call. At realistic 100ms/call,
> the same 1000-card batch would take ~100s (see table below). Both figures meet the 5-minute
> target, but the gap must not be glossed over.

---

## Real-World Scaling Projections

These are **estimates** based on scaling the simulated concurrency model to realistic API latency.
They have not been verified against a live Favro API.

### At 100ms avg latency (realistic EU/production estimate)

| Cards | Sequential | Parallel (5) | Notes |
|-------|-----------|--------------|-------|
| 100 | ~10s | ~2s | Well under 30s target |
| 1,000 | ~100s (~1.7min) | ~21s | Well under 5-min target |
| 10,000 | ~1,000s (~17min) | ~210s (~3.5min) | Approaches 5-min target; rate limiting may push it over |

### At 200ms avg latency (pessimistic / high load)

| Cards | Sequential | Parallel (5) | Notes |
|-------|-----------|--------------|-------|
| 100 | ~20s | ~4s | Within 30s target |
| 1,000 | ~200s (~3.3min) | ~41s | Within 5-min target |
| 10,000 | ~2,000s (~33min) | ~420s (~7min) | **Exceeds 5-min target at this scale** |

> **Rate limiting:** Favro API write rate limits (typically 100 req/min) apply regardless
> of client-side concurrency. For 1,000+ card batches at rate limit, actual time will be
> dominated by mandatory back-off delays, not algorithmic overhead.

---

## Cache Hit Rate Analysis

### Scenario 1: 100 cards updating the same field

- First card: 1 cache miss → 1 API call to fetch field definition
- Cards 2–100: 99 cache hits → 0 API calls
- **Hit rate: 99%** | **Total field-lookup API calls: 1**

### Scenario 2: 1000 cards with mixed fields (e.g., 10 unique fields)

- Each unique field: 1 miss on first encounter, all subsequent accesses are hits
- 10 unique fields × 1 miss each = 10 API calls
- Remaining 990 lookups across all fields = cache hits
- **Hit rate: ~99%** | **Total field-lookup API calls: 10**

### Worst case: 1000 cards with 1000 unique custom fields

- Each card has a completely different custom field never seen before
- Every lookup is a cache miss
- **Hit rate: 0%** | **Total field-lookup API calls: 1000** (no N+1 benefit)

> In this degenerate case, the cache provides no benefit. `preWarmCache(boardId)` can
> mitigate this by fetching all field definitions in a single paginated call before processing,
> converting 1000 individual lookups into 1 bulk fetch (or ~10 pages × 100 fields).

### Cache Hit Rate Summary

| Scenario | Unique Fields | Field API Calls | Hit Rate |
|----------|--------------|-----------------|----------|
| 100 cards, 1 field | 1 | 1 | 99% |
| 1000 cards, 1 field | 1 | 1 | 99.9% |
| 1000 cards, 10 fields | 10 | 10 | 99% |
| 1000 cards, 1000 fields (no pre-warm) | 1000 | 1000 | 0% |
| 1000 cards, 1000 fields (with pre-warm) | 1000 | ~10 (paginated bulk) | ~99%* |

*`preWarmCache` fetches all fields in paginated batches, not individually.

---

## N+1 Query Analysis

### Problem Identified

In `CustomFieldsAPI.setFieldValue()`, every call fetched the field definition via
`getField()` to validate select enum values. In a batch of 1,000 cards each updating the
same "Priority" field, this generated **1,000 identical API calls** for a single field
definition.

```
Before optimization:
  1000 cards × 1 getField() call = 1000 API calls (N+1)
  At 100ms/call = 100 seconds of unnecessary latency
```

### Fix Applied

**Field definition caching** in `CustomFieldsAPI`:

```typescript
async getField(fieldId: string, boardId?: string): Promise<CustomFieldDefinition> {
  const cacheKey = boardId ? `${fieldId}:${boardId}` : fieldId;
  const cached = this.cache.get<CustomFieldDefinition>(cacheKey);
  if (cached) return cached;  // Cache hit: 0ms

  const field = /* API call */;
  this.cache.set(cacheKey, field);  // Store for reuse
  return field;
}
```

**Pre-warming for batch operations:**

```typescript
await customFieldsApi.preWarmCache(boardId);
// Now all subsequent getField() calls are cache hits (0ms)
```

---

## Cache Staleness Risk

### Risk Description

The field definition cache uses a **5-minute TTL** (time-to-live). If a custom field's
options are modified during a bulk operation (e.g., a team member adds/renames a select
option), cached field definitions will be stale until TTL expiry.

**Consequences of stale cache:**
- **Select field validation** may reject valid values (new option not yet in cache)
- **Select field validation** may allow values that have been removed
- The `optionId` sent to the API may be incorrect if options were reordered/replaced

### Cache Invalidation

There is **no active cache invalidation mechanism**. The cache relies solely on TTL expiry.

For bulk operations that span longer than 5 minutes, the cache will automatically expire
and re-fetch from the API. For shorter operations, stale data is possible if field
definitions change externally during the run.

### 5-Minute TTL — Rationale

The 5-minute TTL was chosen as a reasonable default balancing:
- **Performance**: Long enough to cover a typical 1000-card bulk operation
- **Staleness risk**: Short enough that definitions are unlikely to be modified and cause
  meaningful incorrect behavior in most workflows

This is an **opinionated default**, not a measured optimal value. It can be overridden:

```typescript
const cache = new CustomFieldCache({ ttlMs: 60_000 }); // 1-minute TTL
const api = new CustomFieldsAPI(client, { cache });
```

### Mitigation Recommendations

1. **Document the risk** to CLI users: bulk operations using cached field definitions
   should not be run concurrently with field definition changes.
2. **Force cache bypass** for critical operations: pass `ttlMs: 0` to disable caching,
   accepting the N+1 cost in exchange for correctness.
3. **Future: invalidation hook** — If Favro API supports webhooks for field definition
   changes, subscribe and clear the cache on receipt.

---

## Concurrency Safety

### ConcurrencyController Design

`ConcurrencyController` uses an **application-level semaphore** (in-memory queue of
Promise resolvers), not database transactions. There is no locking at the API or
persistence layer.

```typescript
// Semaphore: limits simultaneous in-flight requests
async acquire(): Promise<void> {
  if (this.activeCount < this.maxConcurrent) {
    this.activeCount++;
    return;
  }
  await new Promise<void>((resolve) => {
    this.queue.push(resolve);
  });
  this.activeCount++;
}
```

### Race Condition Risk: Parallel Updates to Same cardId

**Yes, race conditions are possible** when two operations in the same batch target the
same `cardId` with `concurrency > 1`. The controller limits total in-flight count but
does not prevent two concurrent requests from updating the same card.

Example:
```
Op 1: PATCH /cards/card-42 { status: "Done" }      ← both in flight simultaneously
Op 2: PATCH /cards/card-42 { assignees: ["alice"] }  ← last-write-wins at API
```

The final state depends on which PATCH request arrives last at the Favro API — the
controller does not serialize or merge per-card operations.

**Mitigation:** Ensure the input CSV/operation list contains at most one operation per
cardId when using `concurrency > 1`. This is the caller's responsibility; `BulkTransaction`
does not deduplicate by cardId.

### Atomic Rollback in Parallel Mode

**Atomic rollback is NOT guaranteed in parallel mode (`concurrency > 1`).**

The code documents this explicitly:

```typescript
// NOTE: Parallel mode does NOT guarantee strict atomic rollback of all concurrent ops.
// Use sequential mode when strict rollback semantics are required.
```

**What actually happens on failure in parallel mode:**
1. One operation fails → sets `aborted = true`
2. In-flight requests already dispatched will complete (no cancellation)
3. Rollback iterates `completed[]` and attempts to reverse each op sequentially
4. Between the failure and rollback completion, some operations may have committed
   without their rollback being guaranteed (e.g., if rollback itself fails)

**Sequential mode (`concurrency: 1`)** provides best-effort atomicity: on failure, all
previously completed operations are rolled back in reverse order before returning.

**Recommendation:** Use `concurrency: 1` (the default) when transactional correctness is
required. Use `concurrency > 1` only for operations where partial success or eventual
consistency is acceptable.

---

## Skipped Tests (Real API Required)

Three tests in `tests/integration/performance.test.ts` are skipped unless `FAVRO_API_TOKEN`
and `FAVRO_TEST_BOARD_ID` environment variables are set:

| Test | Why Skipped | What It Verifies |
|------|-------------|-----------------|
| `measures card fetch time for 100 cards` | Requires real board + auth | Actual network latency for card list pagination |
| `measures custom field cache effectiveness` | Requires real board with custom fields | Cache miss=API roundtrip, hit=0ms (verifies real cache benefit) |
| `pre-warming cache reduces N+1 for batch custom field lookups` | Requires real board with custom fields | preWarmCache() → ≥10 subsequent hits with 0 API calls |

These tests cover the **critical path for N+1 elimination** — the primary performance
optimization in this release. They cannot be replaced by mocks without losing the
validation that the real API behaves as assumed.

**To run skipped tests:**
```bash
export FAVRO_API_TOKEN=<your_token>
export FAVRO_TEST_BOARD_ID=<your_board_id>
pnpm test:integration --testPathPattern=performance
```

---

## Optimizations Implemented

### 1. Custom Field Definition Caching

**File:** `src/lib/custom-fields-api.ts`

- `CustomFieldsAPI` carries a `CustomFieldCache` instance
- `getField()` checks cache before making an API call (TTL: 5 minutes, configurable)
- `preWarmCache(boardId)` fetches all fields for a board in paginated batches and populates the cache
- `cacheStats()` returns hit/miss/hitRate for profiling/debugging
- Per-instance cache by default (test isolation); opt-in to global cache via `useGlobalCache: true`

**Impact:** Eliminates N+1 API calls in batch operations that touch custom fields.
**Limitation:** Cache staleness (see [Cache Staleness Risk](#cache-staleness-risk)).

### 2. Parallel Request Execution with Rate-Limit Awareness

**File:** `src/lib/bulk.ts` + `src/lib/profiling.ts`

- `BulkTransaction` accepts `concurrency` option (default: **1** for backward compatibility and safety)
- `ConcurrencyController` implements an application-level semaphore for controlled parallelism
- Parallel mode is ~5x faster for I/O-bound operations at `concurrency=5`
- Rate limit backoff preserved (handled by `FavroHttpClient` interceptors)

**Usage:**
```typescript
const tx = new BulkTransaction(api, { concurrency: 5 });
```

**Tradeoff:** Parallel mode does not guarantee per-card atomic ordering or strict rollback.
See [Concurrency Safety](#concurrency-safety).

### 3. Performance Profiling Infrastructure

**File:** `src/lib/profiling.ts`

- `Profiler`: Named span tracking, throughput calculation, heap measurement
- `CustomFieldCache`: Generic TTL cache for field definitions; pre-warming support
- `ConcurrencyController`: Semaphore-based parallel execution with progress callbacks
- `formatBenchmarkReport()`: Markdown-formatted benchmark output
- `assertBenchmarkTarget()`: Throws if benchmark exceeds target (for CI assertions)

### 4. Profiling Integration in BulkTransaction

**File:** `src/lib/bulk.ts`

- `execute({ profile: true })` returns a `BenchmarkResult` in the result object
- Spans: `sequential-updates`, `parallel-updates`, `rollback`
- Zero overhead when `profile: false` (default)

---

## Limitations and Known Issues

| Limitation | Severity | Details |
|------------|----------|---------|
| Benchmarks are simulated | Medium | 5ms mock latency vs 50-200ms real; see [Real-World Scaling Projections](#real-world-scaling-projections) |
| Cache staleness | Low-Medium | 5-min TTL; no active invalidation; risk if field defs change mid-operation |
| Parallel mode race conditions | Medium | Same cardId in concurrent operations → last-write-wins |
| Parallel mode rollback not atomic | Medium | Partial rollback possible; use `concurrency:1` for strict atomicity |
| Skipped real-API tests | Medium | 3 critical tests require real credentials to verify cache behavior |
| Rate limit dominates at scale | High | For 10,000+ cards, Favro API rate limits (100 req/min) dominate over algorithmic efficiency |

---

## Recommendations for Further Improvement

### Short Term

1. **Run skipped tests against real Favro API** — The most important next step.
   Real measurements will validate or invalidate the simulated projections.

2. **Document per-cardId uniqueness requirement** in CLI help text for parallel mode.

3. **Add cache-bypass flag** (`--no-cache`) for operations where staleness is unacceptable.

### Medium Term

4. **Adaptive concurrency** — Start at `concurrency=5` and reduce on 429 responses,
   increase when headroom is available. Implement token-bucket rate limiting.

5. **Pre-warm cache by default** for bulk operations that touch custom fields. Currently
   opt-in; make it automatic when `concurrency > 1`.

6. **Connection keep-alive & HTTP/2** — Axios reuses TCP connections by default, but
   explicitly configuring an HTTP agent with `keepAlive: true` ensures connection pooling
   for high-volume batch operations.

### Long Term

7. **Webhook-driven batch updates** — Instead of polling for completion, register a
   webhook to receive update confirmations.

8. **Request deduplication** — In parallel mode, detect concurrent requests targeting
   the same cardId and serialize them to prevent last-write-wins issues.

---

## Testing

Performance tests live in `tests/integration/performance.test.ts`.

```bash
# Run performance tests (mock API, CI-safe):
pnpm test:integration --testPathPattern=performance

# Run with real API (requires env vars):
FAVRO_API_TOKEN=xxx FAVRO_TEST_BOARD_ID=yyy pnpm test:integration --testPathPattern=performance
```

### Test Coverage

| Test | Type | Target | Status |
|------|------|--------|--------|
| Profiler span measurement | Unit | N/A | ✅ Always runs |
| Cache TTL expiry | Unit | N/A | ✅ Always runs |
| Cache N+1 elimination (1000 hits) | Unit | 100% hit rate | ✅ Always runs |
| Concurrency limiter (max 3 parallel) | Unit | ≤3 concurrent | ✅ Always runs |
| Parallel speedup vs sequential | Unit | ≥2x faster | ✅ Always runs |
| 100-card sequential (mock 5ms) | Benchmark | < 30s | ✅ Always runs |
| 100-card parallel speedup (mock) | Benchmark | ≥2x | ✅ Always runs |
| 1000-card parallel (mock 5ms) | Benchmark | **< 5 min** | ✅ Always runs |
| Card fetch timing | Integration | N/A (real API) | ⏭ Skipped (no env vars) |
| Cache effectiveness (real API) | Integration | hit < miss time | ⏭ Skipped (no env vars) |
| Pre-warm N+1 (real API) | Integration | ≥10 hits post-warm | ⏭ Skipped (no env vars) |
