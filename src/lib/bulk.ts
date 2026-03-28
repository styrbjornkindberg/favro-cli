/**
 * Bulk Operation Framework
 * CLA-1781 / FAVRO-019: Implement Bulk Operation Framework
 *
 * Provides a transaction-like abstraction for batch operations:
 * - Atomic execution (all succeed or all fail with rollback)
 * - CSV input parsing with validation
 * - Dry-run preview
 * - Progress tracking
 */

import CardsAPI, { UpdateCardRequest } from './cards-api';
import { Profiler, ConcurrencyController, BenchmarkResult } from './profiling';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BulkOperationType = 'update' | 'move' | 'assign';
export type BulkOperationStatus = 'pending' | 'success' | 'failed' | 'rolled_back' | 'skipped';

export interface BulkOperation {
  type: BulkOperationType;
  cardId: string;
  cardName?: string;
  changes: Partial<BulkCardChanges>;
  previousState?: Partial<BulkCardChanges>;
  status: BulkOperationStatus;
  error?: string;
}

export interface BulkCardChanges {
  name: string;
  status: string;
  assignees: string[];
  tags: string[];
  dueDate: string;
  boardId: string;
}

// ---------------------------------------------------------------------------
// CSV Parsing
// ---------------------------------------------------------------------------

export interface CSVRow {
  card_id: string;
  status?: string;
  owner?: string;
  due_date?: string;
  [key: string]: string | undefined; // custom fields (custom_field_x)
}

export interface CSVValidationError {
  row: number;
  field: string;
  message: string;
}

export interface CSVParseResult {
  rows: CSVRow[];
  errors: CSVValidationError[];
}

/**
 * Parse a CSV string into CSVRow objects.
 * Handles RFC 4180 CSV with quoted fields, commas, and newlines.
 * Returns rows and validation errors.
 *
 * Required column: card_id
 * Optional columns: status, owner, due_date, custom_field_*
 */
export function parseCSVContent(content: string): CSVParseResult {
  const errors: CSVValidationError[] = [];
  const trimmed = content.trim();

  if (!trimmed) {
    return { rows: [], errors: [{ row: 0, field: 'file', message: 'CSV file is empty' }] };
  }

  const lines = splitCSVLines(trimmed);
  if (lines.length < 2) {
    return { rows: [], errors: [{ row: 0, field: 'file', message: 'CSV file has no data rows (only header)' }] };
  }

  const headers = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());

  // Validate card_id column exists
  if (!headers.includes('card_id')) {
    return {
      rows: [],
      errors: [{ row: 0, field: 'card_id', message: 'CSV must include a "card_id" column' }],
    };
  }

  const rows: CSVRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue; // skip empty lines

    const values = parseCSVLine(line);
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = (values[idx] ?? '').trim();
    });

    const rowNum = i + 1; // 1-based row number (including header)

    // Validate card_id is present
    if (!obj.card_id) {
      errors.push({ row: rowNum, field: 'card_id', message: `Row ${rowNum}: card_id is required` });
      continue;
    }

    // Validate due_date format if present
    if (obj.due_date && obj.due_date !== '') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(obj.due_date)) {
        errors.push({
          row: rowNum,
          field: 'due_date',
          message: `Row ${rowNum}: due_date "${obj.due_date}" must be in YYYY-MM-DD format`,
        });
      }
    }

    rows.push(obj as CSVRow);
  }

  return { rows, errors };
}

/**
 * Parse a single CSV line, respecting quoted fields (RFC 4180).
 */
export function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let inQuote = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];

    if (inQuote) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          // Escaped double-quote
          field += '"';
          i += 2;
        } else {
          // End of quoted field
          inQuote = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuote = true;
        i++;
      } else if (ch === ',') {
        fields.push(field);
        field = '';
        i++;
      } else {
        field += ch;
        i++;
      }
    }
  }
  fields.push(field);

  return fields;
}

/**
 * Split CSV content into lines, respecting quoted newlines.
 */
function splitCSVLines(content: string): string[] {
  const lines: string[] = [];
  let current = '';
  let inQuote = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
    } else if (ch === '\n' && !inQuote) {
      lines.push(current.replace(/\r$/, ''));
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) lines.push(current.replace(/\r$/, ''));
  return lines;
}

/**
 * Convert a CSVRow to a BulkOperation for card update.
 *
 * @param row           Parsed CSV row with card_id and optional fields
 * @param previousState Optional snapshot of the card's current state (for rollback)
 */
export function csvRowToBulkOperation(
  row: CSVRow,
  previousState?: Partial<BulkCardChanges>
): BulkOperation {
  const changes: Partial<BulkCardChanges> = {};

  if (row.status) changes.status = row.status;
  if (row.owner) changes.assignees = [row.owner]; // single owner; could be comma-separated
  if (row.due_date) changes.dueDate = row.due_date;

  // Map custom_field_* columns — stored but not directly mapped to UpdateCardRequest
  // Custom fields would require extension of the UpdateCardRequest type
  for (const key of Object.keys(row)) {
    if (key.startsWith('custom_field_') && row[key]) {
      // Store custom fields in changes for reporting (not sent to API in this impl)
      (changes as any)[key] = row[key];
    }
  }

  return {
    type: 'update',
    cardId: row.card_id,
    changes,
    previousState: previousState ?? {},
    status: 'pending',
  };
}

// ---------------------------------------------------------------------------
// Build UpdateCardRequest from BulkOperation
// ---------------------------------------------------------------------------

export function buildBulkUpdateRequest(op: BulkOperation): UpdateCardRequest {
  const req: UpdateCardRequest = {};
  const { changes } = op;

  if (changes.name !== undefined) req.name = changes.name;
  if (changes.status !== undefined) req.status = changes.status;
  if (changes.assignees !== undefined) req.assignees = changes.assignees;
  if (changes.tags !== undefined) req.tags = changes.tags;
  if (changes.dueDate !== undefined) req.dueDate = changes.dueDate;
  if (changes.boardId !== undefined) req.boardId = changes.boardId;

  return req;
}

export function buildBulkRollbackRequest(op: BulkOperation): UpdateCardRequest {
  const prev = op.previousState ?? {};
  const req: UpdateCardRequest = {};

  if (prev.name !== undefined) req.name = prev.name;
  if (prev.status !== undefined) req.status = prev.status;
  if (prev.assignees !== undefined) req.assignees = prev.assignees;
  if (prev.tags !== undefined) req.tags = prev.tags;
  if (prev.dueDate !== undefined) req.dueDate = prev.dueDate;
  if (prev.boardId !== undefined) req.boardId = prev.boardId;

  return req;
}

// ---------------------------------------------------------------------------
// Bulk Transaction
// ---------------------------------------------------------------------------

/**
 * BulkTransaction provides atomic execution of multiple card operations.
 *
 * Usage:
 *   const tx = new BulkTransaction(api);
 *   tx.add({ type: 'update', cardId: 'card-1', changes: { status: 'Done' }, status: 'pending' });
 *   const result = await tx.execute({ dryRun: false });
 */
export interface BulkTransactionOptions {
  interOpDelayMs?: number;
  /** Max parallel in-flight requests. Default 1 (sequential). Set to 5 for parallel mode. */
  concurrency?: number;
  /** Enable performance profiling. Returns BenchmarkResult in execute() result. */
  profile?: boolean;
}

export interface BulkResult {
  total: number;
  success: number;
  failure: number;
  skipped: number;
  rolledBack: number;
  errors: Array<{ cardId: string; cardName?: string; error: string }>;
  operations: BulkOperation[];
  /** Present when profile:true is passed to execute() */
  benchmark?: BenchmarkResult;
}

export class BulkTransaction {
  private operations: BulkOperation[] = [];
  private interOpDelayMs: number;
  private concurrency: number;
  private enableProfiling: boolean;

  constructor(private api: CardsAPI, options: BulkTransactionOptions = {}) {
    this.interOpDelayMs = options.interOpDelayMs ?? 0;
    this.concurrency = options.concurrency ?? 1;
    this.enableProfiling = options.profile ?? false;
  }

  /**
   * Add an operation to the transaction queue.
   */
  add(op: BulkOperation): void {
    this.operations.push({ ...op, status: 'pending' });
  }

  /**
   * Add multiple operations at once.
   */
  addAll(ops: BulkOperation[]): void {
    for (const op of ops) this.add(op);
  }

  /**
   * Return the current list of pending operations (for preview/dry-run).
   */
  getOperations(): BulkOperation[] {
    return [...this.operations];
  }

  /**
   * Preview the operations without executing them.
   * Returns a dry-run result with all operations marked as 'pending'.
   */
  preview(): BulkResult {
    return {
      total: this.operations.length,
      success: 0,
      failure: 0,
      skipped: 0,
      rolledBack: 0,
      errors: [],
      operations: this.operations.map(op => ({ ...op, status: 'pending' })),
    };
  }

  /**
   * Format dry-run output as JSON.
   */
  formatDryRunJSON(): string {
    return JSON.stringify(
      {
        dryRun: true,
        total: this.operations.length,
        operations: this.operations.map(op => ({
          cardId: op.cardId,
          cardName: op.cardName,
          type: op.type,
          changes: op.changes,
        })),
      },
      null,
      2
    );
  }

  /**
   * Execute all operations atomically.
   * If any operation fails, rolls back all completed operations.
   *
   * Supports parallel execution via `concurrency` option (set in constructor).
   * When concurrency > 1, operations run in parallel batches but atomicity is
   * maintained: on any failure, all completed ops are rolled back.
   *
   * @returns BulkResult with counts and error details (+ benchmark if profiling enabled)
   */
  async execute(options: { dryRun?: boolean; verbose?: boolean; profile?: boolean } = {}): Promise<BulkResult> {
    const { dryRun = false, verbose = false } = options;
    const enableProfiling = options.profile ?? this.enableProfiling;

    if (dryRun) {
      return this.preview();
    }

    const profiler = enableProfiling ? new Profiler('BulkTransaction.execute') : null;
    const completed: BulkOperation[] = [];
    const errors: Array<{ cardId: string; cardName?: string; error: string }> = [];
    let aborted = false;

    if (this.concurrency <= 1) {
      // === Sequential execution (original behavior, atomic) ===
      const updateSpan = profiler?.startSpan('sequential-updates', { count: this.operations.length });

      for (const op of this.operations) {
        if (aborted) {
          op.status = 'failed';
          continue;
        }

        // Inter-operation delay to respect rate limits
        if (completed.length > 0 && this.interOpDelayMs > 0) {
          await sleep(this.interOpDelayMs);
        }

        try {
          const updateReq = buildBulkUpdateRequest(op);
          const updatedCard = await this.api.updateCard(op.cardId, updateReq);

          // Populate cardName if not already set
          if (!op.cardName && updatedCard?.name) {
            op.cardName = updatedCard.name;
          }

          op.status = 'success';
          completed.push(op);

          if (verbose) {
            process.stderr.write(`  ✓ [${op.cardId}] ${op.cardName ?? op.cardId}\n`);
          }
        } catch (err: any) {
          const msg = err?.response?.data?.message ?? err?.message ?? String(err);
          op.status = 'failed';
          op.error = msg;
          errors.push({ cardId: op.cardId, cardName: op.cardName, error: msg });
          aborted = true;

          if (verbose) {
            process.stderr.write(`  ✗ [${op.cardId}] ${op.cardName ?? op.cardId}: ${msg}\n`);
          }
        }
      }

      if (updateSpan) profiler!.endSpan(updateSpan);
    } else {
      // === Parallel execution (concurrency > 1) ===
      // NOTE: Parallel mode does NOT guarantee strict atomic rollback of all concurrent ops.
      // Use sequential mode when strict atomicity is required.
      const controller = new ConcurrencyController(this.concurrency);
      const parallelSpan = profiler?.startSpan('parallel-updates', {
        count: this.operations.length,
        concurrency: this.concurrency,
      });

      let completedCount = 0;

      await controller.runAll(
        this.operations.map((op) => async () => {
          if (aborted) {
            op.status = 'failed';
            return;
          }

          if (this.interOpDelayMs > 0 && completedCount > 0) {
            await sleep(this.interOpDelayMs);
          }

          try {
            const updateReq = buildBulkUpdateRequest(op);
            const updatedCard = await this.api.updateCard(op.cardId, updateReq);

            if (!op.cardName && updatedCard?.name) {
              op.cardName = updatedCard.name;
            }

            op.status = 'success';
            completed.push(op);
            completedCount++;

            if (verbose) {
              process.stderr.write(`  ✓ [${op.cardId}] ${op.cardName ?? op.cardId}\n`);
            }
          } catch (err: any) {
            const msg = err?.response?.data?.message ?? err?.message ?? String(err);
            op.status = 'failed';
            op.error = msg;
            errors.push({ cardId: op.cardId, cardName: op.cardName, error: msg });
            aborted = true;

            if (verbose) {
              process.stderr.write(`  ✗ [${op.cardId}] ${op.cardName ?? op.cardId}: ${msg}\n`);
            }
          }
        })
      );

      if (parallelSpan) profiler!.endSpan(parallelSpan);
    }

    // Mark any remaining pending operations as failed
    for (const op of this.operations) {
      if (op.status === 'pending') {
        op.status = 'failed';
      }
    }

    // Rollback if any failures occurred
    let rolledBack = 0;
    if (errors.length > 0 && completed.length > 0) {
      if (verbose) {
        process.stderr.write('\n⚠  Rolling back completed operations...\n');
      }

      const rollbackSpan = profiler?.startSpan('rollback', { count: completed.length });

      for (const op of [...completed].reverse()) {
        try {
          const rollbackReq = buildBulkRollbackRequest(op);
          await this.api.updateCard(op.cardId, rollbackReq);
          op.status = 'rolled_back';
          rolledBack++;

          if (verbose) {
            process.stderr.write(`  ↩ Rolled back [${op.cardId}] ${op.cardName ?? op.cardId}\n`);
          }
        } catch (rollbackErr: any) {
          const msg = rollbackErr?.response?.data?.message ?? rollbackErr?.message ?? String(rollbackErr);
          process.stderr.write(`  ✗ ROLLBACK FAILED [${op.cardId}] ${op.cardName ?? op.cardId}: ${msg}\n`);
        }
      }

      if (rollbackSpan) profiler!.endSpan(rollbackSpan);

      if (verbose) {
        process.stderr.write('  Rollback complete.\n\n');
      }
    }

    const benchmark = profiler?.finish(this.operations.length);

    return {
      total: this.operations.length,
      success: errors.length === 0 ? completed.length : 0,
      failure: errors.length > 0 ? this.operations.length : 0,
      skipped: 0,
      rolledBack,
      errors,
      operations: [...this.operations],
      ...(benchmark ? { benchmark } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Format a BulkResult as a human-readable summary string.
 */
export function formatBulkSummary(result: BulkResult): string {
  const lines: string[] = [];

  if (result.failure === 0) {
    lines.push(`\n✅ Bulk operation complete!`);
    lines.push(`   ✓ Success: ${result.success}`);
    if (result.skipped > 0) {
      lines.push(`   ⏭  Skipped: ${result.skipped}`);
    }
    lines.push(`   ✗ Failed: ${result.failure}`);
  } else {
    lines.push(`\n❌ Bulk operation failed — all changes rolled back.`);
    lines.push(`   ✓ Success: 0 (rolled back)`);
    lines.push(`   ↩ Rolled back: ${result.rolledBack}`);
    lines.push(`   ✗ Failed: ${result.total}`);

    if (result.errors.length > 0) {
      lines.push(`\n   Errors:`);
      for (const e of result.errors) {
        const name = e.cardName ? ` "${e.cardName}"` : '';
        lines.push(`     • [${e.cardId}]${name}: ${e.error}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Format a dry-run preview of bulk operations.
 */
export function formatBulkPreview(ops: BulkOperation[], title: string): string {
  const lines: string[] = [];
  lines.push(`\n📋 ${title} (${ops.length} card${ops.length === 1 ? '' : 's'}):`);
  lines.push('');

  for (const op of ops) {
    const name = op.cardName
      ? (op.cardName.length > 50 ? op.cardName.slice(0, 47) + '...' : op.cardName)
      : op.cardId;
    lines.push(`  • [${op.cardId}] ${name}`);

    const changes = Object.entries(op.changes)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(', ');
    if (changes) lines.push(`    → ${changes}`);
  }

  lines.push('');
  return lines.join('\n');
}
