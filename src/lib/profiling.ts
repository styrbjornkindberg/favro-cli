/**
 * The custom-field definition cache.
 *
 * WHAT THIS FILE USED TO BE, because the name still says it: profiling
 * infrastructure — `Profiler`, `ConcurrencyController`, `formatBenchmarkReport`,
 * `formatDuration`, `assertBenchmarkTarget` and the two types they passed
 * around. All of it arrived whole in `6c3aac5` for a performance review, and
 * `bulk.ts` was the only production caller any of it ever had. #110 deleted
 * `bulk.ts` and recorded in the CHANGELOG that the two classes were left
 * standing because deleting a published export is a semver call — they were
 * never exported from `src/index.ts`, so that was the wrong reason, but 4.0.0 is
 * the release where it stops mattering either way. Deleted there rather than
 * shipping dead code in a fresh major.
 *
 * What is left is the one thing that had a consumer: `custom-fields-api.ts`
 * constructs a `CustomFieldCache` per instance or shares `globalFieldCache`.
 */

/**
 * Cache for custom field definitions and their enum values.
 *
 * Eliminates N+1 API calls where `setFieldValue` was calling `getField()`
 * for every card in a batch update. With this cache, the field definition
 * is fetched once and reused across all cards.
 *
 * Example N+1 scenario (before):
 *   1000 cards × 1 custom field lookup per card = 1000 API calls
 *
 * After caching:
 *   1 field lookup → 0 additional calls for the remaining 999 cards
 */
export class CustomFieldCache {
  private fieldCache = new Map<string, { definition: unknown; fetchedAt: number }>();
  private ttlMs: number;
  private hits = 0;
  private misses = 0;

  constructor(options: { ttlMs?: number } = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000; // 5-minute TTL default
  }

  /**
   * Get a cached field definition or null if not cached/expired.
   */
  get<T>(fieldId: string): T | null {
    const entry = this.fieldCache.get(fieldId);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (Date.now() - entry.fetchedAt > this.ttlMs) {
      this.fieldCache.delete(fieldId);
      this.misses++;
      return null;
    }
    this.hits++;
    return entry.definition as T;
  }

  /**
   * Store a field definition in the cache.
   */
  set<T>(fieldId: string, definition: T): void {
    this.fieldCache.set(fieldId, { definition, fetchedAt: Date.now() });
  }

  /**
   * Return cache statistics for reporting.
   */
  stats(): { hits: number; misses: number; size: number; hitRate: string } {
    const total = this.hits + this.misses;
    const hitRate = total > 0 ? `${Math.round((this.hits / total) * 100)}%` : 'N/A';
    return { hits: this.hits, misses: this.misses, size: this.fieldCache.size, hitRate };
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.fieldCache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Pre-warm the cache with field definitions fetched in bulk.
   * Call this before processing a batch to avoid N+1 lookups.
   */
  preWarm<T>(fields: Array<{ fieldId: string } & T>): void {
    for (const field of fields) {
      this.set(field.fieldId, field);
    }
  }
}

// Global shared cache instance (singleton for CLI process lifetime)
export const globalFieldCache = new CustomFieldCache();
