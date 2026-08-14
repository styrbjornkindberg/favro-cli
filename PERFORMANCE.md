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

- **`src/lib/profiling.ts` — no longer a profiler.** It held `Profiler` (named span
  tracking, throughput, heap measurement), `ConcurrencyController`,
  `formatBenchmarkReport()`, `formatDuration()` and `assertBenchmarkTarget()`. `bulk.ts`
  was the only production caller any of them had, #110 deleted `bulk.ts`, and 4.0.0
  deleted the rest — none of it was ever exported from `src/index.ts`. What survives is
  `CustomFieldCache` and `globalFieldCache`, which `custom-fields-api.ts` uses; that is
  what `src/__tests__/lib/profiling.test.ts` covers now. **Every number below this line
  was measured with tooling that no longer exists in the tree** — they are kept because
  they are the basis of the recommendations, and `git show 6c3aac5:src/lib/profiling.ts`
  is where the instrument went.
- **No standing benchmark harness.** `tests/integration/performance.test.ts` was
  deleted in #71 along with the rest of `tests/`. Its mock-API benchmarks asserted
  a 30-second and a 5-minute ceiling against a mocked client — they took ~3s to
  prove nothing about real latency, and its real-API tests were env-gated so CI
  never ran them. The numbers recorded below are historical measurements, kept
  because they are the basis of the recommendations; they are not re-verified on
  each run.

### Approach — how the recorded numbers were taken, in the past tense

1. **Span-based timing**: named spans wrapped each logical phase (card fetch, field
   lookup, individual updates, rollback), which is what pinpointed where time went.
2. **Mock API benchmarks**: simulated configurable network latency to measure
   algorithmic efficiency without real API availability. **These are not real
   measurements.**
3. **Real API integration tests**: optional (required `FAVRO_API_TOKEN` +
   `FAVRO_TEST_BOARD_ID`) for end-to-end validation. Deleted with `tests/` in #71.
4. **N+1 measurement**: cache hit/miss counters expose whether field lookups are
   redundant. This is the ONE item still standing — `CustomFieldsAPI.cacheStats()`
   returns them from a live process.

### How to Profile

There is no profiler and no `test:integration` script. Item 4 above is all the
instrumentation the tree still carries, and it answers one question — whether a field
lookup repeated. For anything timed, bring your own clock in a throwaway script and run
it against a real board with real credentials, the shape
`scripts/probe-favro-errors.ts` uses. A mocked client cannot produce a number worth
recording here; that is what the disclaimer at the top of this file is about.

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

> In this degenerate case, the cache provides no benefit. There was a `preWarmCache(boardId)`
> here for exactly this; it had no caller anywhere in `src/` and was deleted (#167 review).
> The bulk fetch it did is `listFields(boardId)` — one paginated call — and a caller that
> needs the cache warmed can feed those definitions to it.

### Cache Hit Rate Summary

| Scenario | Unique Fields | Field API Calls | Hit Rate |
|----------|--------------|-----------------|----------|
| 100 cards, 1 field | 1 | 1 | 99% |
| 1000 cards, 1 field | 1 | 1 | 99.9% |
| 1000 cards, 10 fields | 10 | 10 | 99% |
| 1000 cards, 1000 fields | 1000 | 1000 | 0% |

There is no pre-warm row any more: the method that filled it had no caller and is gone.

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

## Concurrency Safety — the section this was is gone with its subject

This section described `ConcurrencyController`'s semaphore, the last-write-wins race two
in-flight `PATCH`es to one `cardId` could produce, and what `BulkTransaction`'s rollback
did and did not guarantee at `concurrency > 1`. **None of those exist.** #110 deleted
`bulk.ts` and `BulkTransaction`; 4.0.0 deleted `ConcurrencyController`, which had no
production caller left after that. The CLI issues no controlled-parallel batch of card
writes today, so there is no concurrency to make safe — `git show 6c3aac5` and the #110
CHANGELOG entry carry the reasoning if either comes back.

The one thing worth carrying forward if it does: the risk was never the semaphore, it was
that **two operations in one batch targeting the same `cardId` are resolved by arrival
order at the Favro API**, and nothing in the client serialised or merged them.

## Unverified Claims (No Longer Covered By Any Test)

These three checks lived in `tests/integration/performance.test.ts`, gated behind
`FAVRO_API_TOKEN` + `FAVRO_TEST_BOARD_ID`. CI never ran them, and #71 deleted the
file. **Nothing verifies them today** — they are listed here so the gap is visible
rather than implied:

| Test | Why Skipped | What It Verifies |
|------|-------------|-----------------|
| `measures card fetch time for 100 cards` | Requires real board + auth | Actual network latency for card list pagination |
| `measures custom field cache effectiveness` | Requires real board with custom fields | Cache miss=API roundtrip, hit=0ms (verifies real cache benefit) |
| `pre-warming cache reduces N+1 for batch custom field lookups` | Requires real board with custom fields | preWarmCache() → ≥10 subsequent hits with 0 API calls |

These covered the **critical path for N+1 elimination**, and the point stands: they
cannot be replaced by mocks without losing the validation that the real API behaves
as assumed. That is also why deleting them lost nothing CI had — an env-gated test
that never runs is a claim, not a check.

If N+1 behaviour needs to be pinned again, it wants a real-API probe run
deliberately (the shape `scripts/probe-favro-errors.ts` uses), not a test file that
skips itself into silence.

---

## Optimizations Implemented

### 1. Custom Field Definition Caching

**File:** `src/lib/custom-fields-api.ts`

- `CustomFieldsAPI` carries a `CustomFieldCache` instance
- `getField()` checks cache before making an API call (TTL: 5 minutes, configurable)
- `cacheStats()` returns hit/miss/hitRate for profiling/debugging
- Per-instance cache by default (test isolation); opt-in to global cache via `useGlobalCache: true`

**Impact:** Eliminates N+1 API calls in batch operations that touch custom fields.
**Limitation:** Cache staleness (see [Cache Staleness Risk](#cache-staleness-risk)).

### 2, 3 and 4 were `bulk.ts` and `profiling.ts`, and both are deleted

The three entries that stood here — parallel request execution behind
`ConcurrencyController`, the profiling infrastructure itself (`Profiler`,
`formatBenchmarkReport()`, `assertBenchmarkTarget()`), and `BulkTransaction`'s
`execute({ profile: true })` returning a `BenchmarkResult` — described code that no longer
exists. #110 deleted `bulk.ts` and its three commands; 4.0.0 deleted the profiling half
that `bulk.ts` was the only caller of.

**Entry 1 above is the whole list now.** The caching optimisation is the one that had a
consumer outside the benchmark harness, and it still does.

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

There is no performance test suite and no profiler to test. `src/__tests__/lib/profiling.test.ts`
now covers exactly one class, `CustomFieldCache`, in four arms — the hit/miss counters and
the derived `hitRate`, TTL expiry, `preWarm`, and 1 000 repeat reads of one field landing as
1 000 hits and no second miss. **Nothing asserts a latency budget, and nothing measures
elapsed time on the critical path**, because the code that did was deleted with its only
caller (see *Tools* above).

The two arms that went with it — `Profiler`'s span/throughput measurement and
`ConcurrencyController`'s "never more than `maxConcurrent` at once" — were the last
references either class had anywhere in the tree, so no behaviour that still runs lost an
assertion.

```bash
npm test    # the whole suite, including the cache's tests
```

### Test Coverage

| Test | Type | Target | Status |
|------|------|--------|--------|
| Cache hit/miss counters and `hitRate` | Unit | 50% on 1 hit + 1 miss | ✅ Always runs |
| Cache TTL expiry | Unit | N/A | ✅ Always runs |
| `preWarm` populates from a field array | Unit | N/A | ✅ Always runs |
| Cache N+1 elimination (1000 repeat reads) | Unit | 100% hit rate | ✅ Always runs |

The benchmark and real-API rows this table used to carry are gone: the benchmarks were in
`tests/integration/performance.test.ts`, which #71 deleted, and the three env-gated real-API
checks are recorded under *Unverified Claims* above, which is the honest place for a check
CI never ran.
