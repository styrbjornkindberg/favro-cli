/**
 * Performance Profiling Infrastructure
 * CLA-1794 / FAVRO-032: Performance Review & Optimization
 *
 * Provides timing utilities, span tracking, and benchmark reporting
 * for bulk operations profiling.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProfileSpan {
  name: string;
  startMs: number;
  endMs?: number;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface BenchmarkResult {
  name: string;
  totalMs: number;
  spans: ProfileSpan[];
  throughput?: number; // items per second
  itemCount?: number;
  peakMemoryMb?: number;
}

// ---------------------------------------------------------------------------
// Profiler
// ---------------------------------------------------------------------------

/**
 * Lightweight profiler for measuring execution time of bulk operations.
 *
 * Usage:
 *   const profiler = new Profiler('bulk-update');
 *   const span = profiler.startSpan('fetch-cards');
 *   // ... do work ...
 *   profiler.endSpan(span);
 *   const result = profiler.finish();
 */
export class Profiler {
  private spans: ProfileSpan[] = [];
  private startMs: number;

  constructor(private name: string) {
    this.startMs = Date.now();
  }

  /**
   * Start a named span and return it for later completion.
   */
  startSpan(name: string, metadata?: Record<string, unknown>): ProfileSpan {
    const span: ProfileSpan = { name, startMs: Date.now(), metadata };
    this.spans.push(span);
    return span;
  }

  /**
   * End a span and record its duration.
   */
  endSpan(span: ProfileSpan): void {
    span.endMs = Date.now();
    span.durationMs = span.endMs - span.startMs;
  }

  /**
   * Time a synchronous or async operation within a named span.
   */
  async time<T>(name: string, fn: () => Promise<T>, metadata?: Record<string, unknown>): Promise<T> {
    const span = this.startSpan(name, metadata);
    try {
      return await fn();
    } finally {
      this.endSpan(span);
    }
  }

  /**
   * Finalize the profiler and return the benchmark result.
   */
  finish(itemCount?: number): BenchmarkResult {
    const totalMs = Date.now() - this.startMs;
    const memUsage = process.memoryUsage();
    const peakMemoryMb = Math.round(memUsage.heapUsed / 1024 / 1024 * 10) / 10;

    const throughput =
      itemCount !== undefined && itemCount > 0 && totalMs > 0
        ? Math.round((itemCount / (totalMs / 1000)) * 10) / 10
        : undefined;

    return {
      name: this.name,
      totalMs,
      spans: [...this.spans],
      throughput,
      itemCount,
      peakMemoryMb,
    };
  }

  /**
   * Get current spans (for progress reporting during execution).
   */
  getSpans(): ProfileSpan[] {
    return [...this.spans];
  }
}

// ---------------------------------------------------------------------------
// Custom Field Enum Cache
// ---------------------------------------------------------------------------

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
   * Return cache statistics for profiling/reporting.
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

// ---------------------------------------------------------------------------
// Concurrency Controller
// ---------------------------------------------------------------------------

/**
 * Rate-limit-aware concurrency controller.
 *
 * Limits simultaneous in-flight API requests to avoid overwhelming the
 * Favro API. Implements a semaphore pattern with configurable concurrency.
 *
 * Recommended limits:
 *   - concurrency: 5 (safe for Favro API rate limits)
 *   - interBatchDelayMs: 100ms between batches
 */
export class ConcurrencyController {
  private activeCount = 0;
  private queue: Array<() => void> = [];

  constructor(private maxConcurrent: number = 5) {}

  /**
   * Acquire a slot; waits if all slots are busy.
   */
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

  /**
   * Release a slot, allowing queued tasks to proceed.
   */
  release(): void {
    this.activeCount--;
    const next = this.queue.shift();
    if (next) next();
  }

  /**
   * Run a function with concurrency control.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * Execute a batch of tasks with concurrency limiting.
   * Returns results in the same order as the input tasks.
   *
   * @param tasks    Array of async functions to execute
   * @param onProgress Optional callback invoked after each completion
   */
  async runAll<T>(
    tasks: Array<() => Promise<T>>,
    onProgress?: (completed: number, total: number) => void
  ): Promise<Array<{ value?: T; error?: Error }>> {
    const results: Array<{ value?: T; error?: Error }> = new Array(tasks.length);
    let completed = 0;

    await Promise.all(
      tasks.map((task, i) =>
        this.run(async () => {
          try {
            results[i] = { value: await task() };
          } catch (err: any) {
            results[i] = { error: err };
          }
          completed++;
          onProgress?.(completed, tasks.length);
        })
      )
    );

    return results;
  }
}

// ---------------------------------------------------------------------------
// Benchmark Reporter
// ---------------------------------------------------------------------------

/**
 * Format a benchmark result as human-readable text for PERFORMANCE.md.
 */
export function formatBenchmarkReport(result: BenchmarkResult): string {
  const lines: string[] = [];
  lines.push(`### ${result.name}`);
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total time | ${formatDuration(result.totalMs)} |`);
  if (result.itemCount !== undefined) {
    lines.push(`| Items processed | ${result.itemCount.toLocaleString()} |`);
  }
  if (result.throughput !== undefined) {
    lines.push(`| Throughput | ${result.throughput} items/s |`);
  }
  if (result.peakMemoryMb !== undefined) {
    lines.push(`| Peak heap | ${result.peakMemoryMb} MB |`);
  }

  if (result.spans.length > 0) {
    lines.push('');
    lines.push('**Span breakdown:**');
    lines.push('');
    lines.push('| Span | Duration | % of total |');
    lines.push('|------|----------|------------|');
    for (const span of result.spans) {
      if (span.durationMs === undefined) continue;
      const pct = result.totalMs > 0
        ? `${Math.round((span.durationMs / result.totalMs) * 100)}%`
        : 'N/A';
      lines.push(`| ${span.name} | ${formatDuration(span.durationMs)} | ${pct} |`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Format milliseconds as a human-readable duration string.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  const minutes = Math.floor(ms / 60000);
  const secs = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}m ${secs}s`;
}

/**
 * Assert a benchmark meets a target duration.
 * Throws if the actual time exceeds the target.
 */
export function assertBenchmarkTarget(
  result: BenchmarkResult,
  targetMs: number,
  description?: string
): void {
  if (result.totalMs > targetMs) {
    const desc = description ?? result.name;
    throw new Error(
      `Performance benchmark FAILED: "${desc}" took ${formatDuration(result.totalMs)}, ` +
      `but target is ${formatDuration(targetMs)}. ` +
      `Actual: ${result.totalMs}ms, Limit: ${targetMs}ms.`
    );
  }
}
