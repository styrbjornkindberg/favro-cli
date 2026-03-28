/**
 * Batch Smart Update Command
 * CLA-1801 / FAVRO-039: Batch Smart Update Command
 *
 * `favro batch-smart <board> --goal "..."` — complex updates from plain English goals
 *
 * Examples:
 *   favro batch-smart <board-id> --goal "move all overdue cards to Review"
 *   favro batch-smart <board-id> --goal "assign all Backlog cards with no owner to alice"
 *   favro batch-smart <board-id> --goal "close all Done cards"
 *   favro batch-smart <board-id> --goal "move all overdue cards to Review" --dry-run
 */
import { Command } from 'commander';
import CardsAPI, { Card, UpdateCardRequest } from '../lib/cards-api';
import { logError } from '../lib/error-handler';
import { createFavroClient } from '../lib/client-factory';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OperationType = 'move' | 'assign' | 'close' | 'set-tag' | 'unassign';

export interface CardOperation {
  type: OperationType;
  cardId: string;
  cardName: string;
  /** For 'move': target status */
  targetStatus?: string;
  /** For 'assign': target assignee */
  targetAssignee?: string;
  /** For 'set-tag': tag to add */
  tag?: string;
  /** Previous state for rollback */
  previousState?: {
    status?: string;
    assignees?: string[];
    tags?: string[];
  };
}

export interface ParsedGoal {
  /** Human-readable description of what this goal does */
  description: string;
  /** Card filter: function that returns true if a card matches */
  cardFilter: (card: Card) => boolean;
  /** Base card filter (without target-state guard) — used to compute true skipped count */
  baseCardFilter: (card: Card) => boolean;
  /** Build an operation for each matching card */
  buildOperation: (card: Card) => CardOperation;
  /** Action summary text for preview (e.g. "→ status: Review") */
  actionSummary: string;
}

export interface BatchSummary {
  total: number;
  success: number;
  failure: number;
  skipped: number;
  errors: Array<{ cardId: string; cardName: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Goal Parser
// ---------------------------------------------------------------------------

/**
 * Parse a natural language goal into a structured ParsedGoal.
 * Supports the patterns defined in SPEC-003.
 *
 * Supported patterns:
 *   move all [filter] cards to <status>
 *   assign all [filter] cards [with no owner] to <user>
 *   close all [filter] cards
 *   unassign all [filter] cards
 *
 * Filters (composable):
 *   overdue        — dueDate is in the past
 *   <status>       — card.status matches (e.g. "Backlog", "In Progress")
 *   with no owner  — no assignees
 *   unassigned     — no assignees
 *   blocked        — has "blocked" tag or status
 *
 * @throws Error with a helpful message if the goal cannot be parsed
 */
export function parseGoal(goal: string): ParsedGoal {
  const normalized = goal.trim().toLowerCase();

  // ── move all [filter] cards to <status> ──
  // FIX BLOCKER #2: filter is optional — (.+?\s+)? allows "move all cards to Done"
  const moveMatch = normalized.match(/^move\s+all\s+(.+?\s+)?cards?\s+to\s+(.+)$/);
  if (moveMatch) {
    const filterStr = (moveMatch[1] ?? '').trim() || 'all';
    const targetStatus = toTitleCase(moveMatch[2].trim());
    const filter = buildCardFilter(filterStr);
    return {
      description: `Move ${filterStr} cards to "${targetStatus}"`,
      baseCardFilter: filter,
      cardFilter: (card) => {
        // Skip cards already in the target state
        if (card.status?.toLowerCase() === targetStatus.toLowerCase()) return false;
        return filter(card);
      },
      buildOperation: (card): CardOperation => ({
        type: 'move',
        cardId: card.cardId,
        cardName: card.name,
        targetStatus,
        previousState: { status: card.status },
      }),
      actionSummary: `→ status: ${targetStatus}`,
    };
  }

  // ── assign all [filter] cards [with no owner] to <user> ──
  // FIX BLOCKER #1: capture "with no owner" in its own group (group 2) instead of consuming
  // FIX BLOCKER #2: filter is optional — (.+?\s+)?
  // FIX edge case: multi-word usernames — capture rest of string after "to "
  const assignMatch = normalized.match(/^assign\s+all\s+(.+?\s+)?cards?\s+(with\s+no\s+owner\s+)?to\s+([\w\s.'"-]+?)$/);
  if (assignMatch) {
    const filterStr = (assignMatch[1] ?? '').trim() || 'all';
    // FIX BLOCKER #1: requireNoOwner checks captured group 2, not filterStr
    const requireNoOwner = !!assignMatch[2] || filterStr.includes('with no owner') || filterStr.includes('no owner') || filterStr.includes('unassigned');
    const cleanFilterStr = filterStr
      .replace(/\s*with\s+no\s+owner/, '')
      .replace(/\s*no\s+owner/, '')
      .replace(/\s*unassigned/, '')
      .trim() || 'all';
    const targetUser = assignMatch[3].trim();
    const filter = buildCardFilter(cleanFilterStr);
    return {
      description: `Assign ${filterStr} cards to "${targetUser}"`,
      baseCardFilter: filter,
      cardFilter: (card) => {
        // FIX BLOCKER #1: correctly check requireNoOwner — cards with owners must be skipped
        if (requireNoOwner && (card.assignees ?? []).length > 0) return false;
        // Skip already assigned to this user
        if ((card.assignees ?? []).includes(targetUser)) return false;
        return filter(card);
      },
      buildOperation: (card): CardOperation => ({
        type: 'assign',
        cardId: card.cardId,
        cardName: card.name,
        targetAssignee: targetUser,
        previousState: { assignees: card.assignees ?? [] },
      }),
      actionSummary: `→ assignee: ${targetUser}`,
    };
  }

  // ── close all [filter] cards ──
  // FIX BLOCKER #2: filter is optional — (.+?\s+)?
  const closeMatch = normalized.match(/^close\s+all\s+(.+?\s+)?cards?$/);
  if (closeMatch) {
    const filterStr = (closeMatch[1] ?? '').trim() || 'all';
    const filter = buildCardFilter(filterStr);
    return {
      description: `Close (mark done) ${filterStr} cards`,
      baseCardFilter: filter,
      cardFilter: (card) => {
        if (card.status?.toLowerCase() === 'done') return false;
        return filter(card);
      },
      buildOperation: (card): CardOperation => ({
        type: 'close',
        cardId: card.cardId,
        cardName: card.name,
        targetStatus: 'Done',
        previousState: { status: card.status },
      }),
      actionSummary: `→ status: Done (closed)`,
    };
  }

  // ── unassign all [filter] cards ──
  // FIX BLOCKER #2: filter is optional — (.+?\s+)?
  const unassignMatch = normalized.match(/^unassign\s+all\s+(.+?\s+)?cards?$/);
  if (unassignMatch) {
    const filterStr = (unassignMatch[1] ?? '').trim() || 'all';
    const filter = buildCardFilter(filterStr);
    return {
      description: `Unassign all assignees from ${filterStr} cards`,
      baseCardFilter: filter,
      cardFilter: (card) => {
        if ((card.assignees ?? []).length === 0) return false;
        return filter(card);
      },
      buildOperation: (card): CardOperation => ({
        type: 'unassign',
        cardId: card.cardId,
        cardName: card.name,
        previousState: { assignees: card.assignees ?? [] },
      }),
      actionSummary: `→ assignees: (none)`,
    };
  }

  // Unknown goal
  throw new Error(
    `Cannot parse goal: "${goal}"\n\n` +
    `Supported patterns:\n` +
    `  move all <filter> cards to <status>\n` +
    `  assign all <filter> cards [with no owner] to <user>\n` +
    `  close all <filter> cards\n` +
    `  unassign all <filter> cards\n\n` +
    `Filter keywords: overdue, blocked, unassigned, <status-name> (e.g. "Backlog", "In Progress")\n\n` +
    `Examples:\n` +
    `  --goal "move all overdue cards to Review"\n` +
    `  --goal "assign all Backlog cards with no owner to alice"\n` +
    `  --goal "close all Done cards"`
  );
}

/**
 * Build a card filter function from a filter string fragment.
 * Handles: overdue, blocked, unassigned, status names, "all"
 */
export function buildCardFilter(filterStr: string): (card: Card) => boolean {
  const parts = filterStr.toLowerCase().split(/\s+and\s+/);
  const filters: Array<(card: Card) => boolean> = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === 'all' || trimmed === 'the') {
      // No filter — match everything
      continue;
    } else if (trimmed === 'overdue') {
      filters.push(isOverdue);
    } else if (trimmed === 'blocked') {
      filters.push(isBlocked);
    } else if (trimmed === 'unassigned' || trimmed === 'no owner' || trimmed === 'with no owner') {
      filters.push(card => (card.assignees ?? []).length === 0);
    } else if (trimmed === 'assigned') {
      filters.push(card => (card.assignees ?? []).length > 0);
    } else {
      // Treat as status filter (case-insensitive)
      const statusFilter = trimmed;
      filters.push(card => card.status?.toLowerCase() === statusFilter);
    }
  }

  if (filters.length === 0) {
    // "all" with no specific filter
    return () => true;
  }

  return (card) => filters.every(f => f(card));
}

// ---------------------------------------------------------------------------
// Card predicates
// ---------------------------------------------------------------------------

export function isOverdue(card: Card): boolean {
  if (!card.dueDate) return false;
  // Use local midnight for timezone-correct comparison
  const [year, month, day] = card.dueDate.split('-').map(Number);
  const dueDate = new Date(year, month - 1, day);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return dueDate < today;
}

export function isBlocked(card: Card): boolean {
  if (card.tags && card.tags.some(t => t.toLowerCase().includes('blocked'))) return true;
  if (card.status && card.status.toLowerCase().includes('blocked')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Operation builder
// ---------------------------------------------------------------------------

/**
 * Build UpdateCardRequest from a CardOperation.
 */
export function buildUpdateRequest(op: CardOperation): UpdateCardRequest {
  switch (op.type) {
    case 'move':
    case 'close':
      return { status: op.targetStatus };
    case 'assign':
      return {
        assignees: [...(op.previousState?.assignees ?? []), op.targetAssignee!],
      };
    case 'unassign':
      return { assignees: [] };
    default:
      throw new Error(`Unknown operation type: ${(op as any).type}`);
  }
}

/**
 * Build the rollback UpdateCardRequest to undo an operation.
 */
export function buildRollbackRequest(op: CardOperation): UpdateCardRequest {
  return {
    status: op.previousState?.status,
    assignees: op.previousState?.assignees,
    tags: op.previousState?.tags,
  };
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export function formatPreview(ops: CardOperation[], actionSummary: string): string {
  const lines: string[] = [];
  lines.push(`\n📋 Preview (${ops.length} card${ops.length === 1 ? '' : 's'} affected):`);
  lines.push('');

  for (const op of ops) {
    const name = op.cardName.length > 50 ? op.cardName.slice(0, 47) + '...' : op.cardName;
    lines.push(`  • [${op.cardId}] ${name}`);
    lines.push(`    ${actionSummary}`);
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Atomic execution
// ---------------------------------------------------------------------------

/**
 * Execute operations atomically.
 * If any operation fails, rolls back all completed operations.
 * Returns a summary of what happened.
 */
export async function executeOperationsAtomic(
  ops: CardOperation[],
  api: CardsAPI,
  verbose = false
): Promise<BatchSummary> {
  const completed: CardOperation[] = [];
  const errors: Array<{ cardId: string; cardName: string; error: string }> = [];

  // Execute all operations
  for (const op of ops) {
    try {
      const updateReq = buildUpdateRequest(op);
      await api.updateCard(op.cardId, updateReq);
      completed.push(op);
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? err?.message ?? String(err);
      errors.push({ cardId: op.cardId, cardName: op.cardName, error: msg });
      if (verbose) {
        console.error(`  ✗ Failed [${op.cardId}] "${op.cardName}": ${msg}`);
      }
      break; // Stop on first failure (atomic)
    }
  }

  // If any failed, roll back all completed operations
  if (errors.length > 0 && completed.length > 0) {
    console.error('\n⚠  Rolling back completed operations...');
    for (const op of [...completed].reverse()) {
      try {
        const rollbackReq = buildRollbackRequest(op);
        await api.updateCard(op.cardId, rollbackReq);
        if (verbose) {
          console.error(`  ↩ Rolled back [${op.cardId}] "${op.cardName}"`);
        }
      } catch (err: any) {
        const msg = err?.response?.data?.message ?? err?.message ?? String(err);
        console.error(`  ✗ ROLLBACK FAILED [${op.cardId}] "${op.cardName}": ${msg}`);
      }
    }
    console.error('  Rollback complete.\n');

    return {
      total: ops.length,
      success: 0,
      failure: ops.length,
      skipped: 0,
      errors,
    };
  }

  return {
    total: ops.length,
    success: completed.length,
    failure: errors.length,
    skipped: 0, // populated by caller for "already in target state" cards
    errors,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toTitleCase(str: string): string {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerBatchSmartCommand(program: Command): void {
  program
    .command('batch-smart <board>')
    .description(
      'Batch update cards using a plain English goal.\n\n' +
      'Examples:\n' +
      '  favro batch-smart <board-id> --goal "move all overdue cards to Review"\n' +
      '  favro batch-smart <board-id> --goal "assign all Backlog cards with no owner to alice"\n' +
      '  favro batch-smart <board-id> --goal "close all Done cards"\n\n' +
      'Supported patterns:\n' +
      '  move all <filter> cards to <status>\n' +
      '  assign all <filter> cards [with no owner] to <user>\n' +
      '  close all <filter> cards\n' +
      '  unassign all <filter> cards\n\n' +
      'Filter keywords: overdue, blocked, unassigned, <status-name> (e.g. "Backlog")\n\n' +
      'Flags:\n' +
      '  --dry-run    Preview changes without applying them\n' +
      '  --yes        Skip confirmation prompt\n' +
      '  --json       Output summary as JSON'
    )
    .requiredOption('--goal <goal>', 'Plain English goal (e.g. "move all overdue cards to Review")')
    .option('--dry-run', 'Preview changes without applying them')
    .option('--yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .option('--json', 'Output result as JSON')
    .action(async (board: string, options: {
      goal: string;
      dryRun?: boolean;
      yes?: boolean;
      force?: boolean;
      json?: boolean;
    }) => {
      const verbose = program.parent?.opts()?.verbose ?? program.opts()?.verbose ?? false;

      try {
        // 1. Resolve API key

        // 2. Parse goal
        let parsedGoal: ParsedGoal;
        try {
          parsedGoal = parseGoal(options.goal);
        } catch (err: any) {
          console.error(`✗ ${err.message}`);
          process.exit(1);
        }

        // 3. Fetch cards from board
        const client = await createFavroClient();
        
        const { readConfig } = await import('../lib/config');
        const { checkScope } = await import('../lib/safety');
        await checkScope(board, client, await readConfig(), options.force);
        
        const api = new CardsAPI(client);

        let allCards: Card[];
        try {
          allCards = await api.listCards(board, 10000);
        } catch (err: any) {
          if (err?.response?.status === 404) {
            console.error(`✗ Board not found: "${board}"`);
            console.error(`  Check available boards: favro boards list`);
          } else {
            logError(err, verbose);
          }
          process.exit(1);
        }

        // 4. Apply card filter to build operations
        const matchingCards = allCards.filter(parsedGoal.cardFilter);
        // FIX BLOCKER #3: use baseCardFilter to count only cards that matched the base
        // criteria (ignoring the target-state guard), then subtract matchingCards to get
        // the true "already in target state" skipped count.
        const baseMatchingCards = allCards.filter(parsedGoal.baseCardFilter);

        // Handle edge case: no matching cards
        if (matchingCards.length === 0) {
          console.log(`\n⚠  No cards match the goal: "${options.goal}"`);
          console.log(`   Board has ${allCards.length} total card(s).`);
          console.log(`   Possible reasons:`);
          console.log(`     - No cards match the filter criteria`);
          console.log(`     - All matching cards are already in the target state`);

          if (options.json) {
            console.log(JSON.stringify({ total: 0, success: 0, failure: 0, skipped: 0, errors: [] }, null, 2));
          }
          process.exit(0);
        }

        const ops = matchingCards.map(parsedGoal.buildOperation);

        // 5. Show preview
        console.log(`\n🎯 Goal: ${parsedGoal.description}`);
        console.log(formatPreview(ops, parsedGoal.actionSummary));

        // 6. Dry-run: stop here
        if (options.dryRun) {
          console.log(`ℹ  Dry-run mode. No changes were made.`);
          console.log(`   Run without --dry-run to apply these changes.`);

          if (options.json) {
            console.log(JSON.stringify({
              dryRun: true,
              total: ops.length,
              operations: ops.map(op => ({
                cardId: op.cardId,
                cardName: op.cardName,
                action: parsedGoal.actionSummary,
              })),
            }, null, 2));
          }
          process.exit(0);
        }

        // 7. Confirmation prompt (unless --yes)
        if (!options.yes) {
          const { confirmAction } = await import('../lib/safety');
          if (!(await confirmAction(`Apply ${ops.length} change${ops.length === 1 ? '' : 's'}?`))) {
            console.log('Batch update cancelled.');
            process.exit(0);
          }
        }

        // 8. Execute atomically
        console.log(`\n⚙  Applying ${ops.length} change${ops.length === 1 ? '' : 's'}...`);
        const summary = await executeOperationsAtomic(ops, api, verbose);

        // FIX BLOCKER #3: skipped = cards matching base filter that weren't in matchingCards
        // (i.e. already in target state). Cards that never matched base filter are NOT skipped.
        const alreadyInTargetState = baseMatchingCards.length - matchingCards.length;
        summary.skipped = Math.max(0, alreadyInTargetState);

        // 9. Output summary
        if (options.json) {
          console.log(JSON.stringify(summary, null, 2));
        } else {
          if (summary.failure === 0) {
            console.log(`\n✅ Batch update complete!`);
            console.log(`   ✓ Success: ${summary.success}`);
            console.log(`   ⏭  Skipped (already in target state): ${summary.skipped}`);
            console.log(`   ✗ Failed: ${summary.failure}`);
          } else {
            console.log(`\n❌ Batch update failed — all changes rolled back.`);
            console.log(`   ✓ Success: 0 (rolled back)`);
            console.log(`   ✗ Failed: ${ops.length}`);
            if (summary.errors.length > 0) {
              console.log(`\n   Errors:`);
              for (const e of summary.errors) {
                console.log(`     • [${e.cardId}] "${e.cardName}": ${e.error}`);
              }
            }
            process.exit(1);
          }
        }
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}

export default registerBatchSmartCommand;
