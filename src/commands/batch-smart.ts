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
import BoardsAPI from '../lib/boards-api';
import FavroHttpClient from '../lib/http-client';
import ColumnDirectory from '../lib/column-directory';
import { logError } from '../lib/error-handler';
import { createFavroClient } from '../lib/client-factory';
import { isOverdue, isBlocked } from '../lib/card-predicates';

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
  /**
   * The raw `--goal` assignee text, present only on an `assign` goal.
   *
   * Parsing is synchronous and assignee resolution is not, so the caller
   * resolves this and re-parses with the `userId` (#59). Until it does, the
   * "already assigned to this user" skip compares a display name against
   * `card.assignees`, which only ever holds `userId`s, and can never match.
   */
  targetAssignee?: string;
  /**
   * Every COLUMN name the goal used — the filter tokens that are not keywords,
   * plus the target status a `move`/`close` writes.
   *
   * Same contract as `targetAssignee` above and for the same reason: settling a
   * column needs the board and a network, `parseGoal` is synchronous and
   * board-unaware, so the caller settles these and parses again with the
   * answers. Until it does, every one of them is an UNVALIDATED
   * `card.status === token` — which is #150: `--goal "move all frobnicated
   * cards to Done"` matched nothing and reported success.
   */
  columnNames: string[];
}

/**
 * A settled column vocabulary: lowercased typed token → the column's OWN name.
 *
 * The value is the canonical spelling, not the typed one, because that is what
 * cards carry under `status`. A columnId, or a name differing in case or unicode
 * composition (#141), resolves against the board and would then match no card at
 * all — the same plausible zero this refuses, one layer down.
 */
export type ColumnNames = ReadonlyMap<string, string>;

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
 *   <status>       — card.status matches a COLUMN on the board (e.g. "Backlog")
 *   with no owner  — no assignees
 *   unassigned     — no assignees
 *   assigned       — has at least one assignee
 *   blocked        — has "blocked" tag or status
 *
 * Anything that is not a keyword is a column name, reported on
 * `ParsedGoal.columnNames` for the caller to settle — see `columnNames`. This
 * function never refuses a column: it cannot, having no board and no network.
 *
 * @param resolvedAssignee The `userId` behind an `assign` goal's name, once the
 *   caller has settled it (#59).
 * @param columns The settled column vocabulary, once the caller has it (#150).
 *   Absent on the first pass, whose only job is to report what needs settling.
 * @throws Error with a helpful message if the goal cannot be parsed
 */
export function parseGoal(
  goal: string,
  resolvedAssignee?: string,
  columns?: ColumnNames,
): ParsedGoal {
  const normalized = goal.trim().toLowerCase();

  // ── move all [filter] cards to <status> ──
  // FIX BLOCKER #2: filter is optional — (.+?\s+)? allows "move all cards to Done"
  const moveMatch = normalized.match(/^move\s+all\s+(.+?\s+)?cards?\s+to\s+(.+)$/);
  if (moveMatch) {
    const filterStr = (moveMatch[1] ?? '').trim() || 'all';
    const typedTarget = moveMatch[2].trim();
    // The column's own spelling once settled; `toTitleCase` is the pre-settle
    // GUESS the caller throws away — it was never more than a guess, and a board
    // whose column is "in progress" got a write to "In Progress".
    const targetStatus = columns?.get(typedTarget) ?? toTitleCase(typedTarget);
    const filter = buildCardFilter(filterStr, columns);
    return {
      description: `Move ${filterStr} cards to "${targetStatus}"`,
      columnNames: [...filterColumnNames(filterStr), typedTarget],
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
    const typedUser = assignMatch[3].trim();
    // `card.assignees` holds userIds, so the skip and the write both need one.
    // On the first (unresolved) pass this is still the typed name — that pass
    // exists only to surface `targetAssignee` to the caller, which resolves it
    // and parses again.
    const targetUser = resolvedAssignee ?? typedUser;
    const filter = buildCardFilter(cleanFilterStr, columns);
    return {
      description: `Assign ${filterStr} cards to "${typedUser}"`,
      columnNames: filterColumnNames(cleanFilterStr),
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
      actionSummary: `→ assignee: ${typedUser}`,
      targetAssignee: typedUser,
    };
  }

  // ── close all [filter] cards ──
  // FIX BLOCKER #2: filter is optional — (.+?\s+)?
  const closeMatch = normalized.match(/^close\s+all\s+(.+?\s+)?cards?$/);
  if (closeMatch) {
    const filterStr = (closeMatch[1] ?? '').trim() || 'all';
    const filter = buildCardFilter(filterStr, columns);
    // "Closed" is this board's Done COLUMN, so it settles like any other — a
    // board with no such column refuses here rather than at the wire, per card,
    // after the preview has already promised the write.
    const targetStatus = columns?.get('done') ?? 'Done';
    return {
      description: `Close (mark done) ${filterStr} cards`,
      columnNames: [...filterColumnNames(filterStr), 'done'],
      baseCardFilter: filter,
      cardFilter: (card) => {
        if (card.status?.toLowerCase() === targetStatus.toLowerCase()) return false;
        return filter(card);
      },
      buildOperation: (card): CardOperation => ({
        type: 'close',
        cardId: card.cardId,
        cardName: card.name,
        targetStatus,
        previousState: { status: card.status },
      }),
      actionSummary: `→ status: ${targetStatus} (closed)`,
    };
  }

  // ── unassign all [filter] cards ──
  // FIX BLOCKER #2: filter is optional — (.+?\s+)?
  const unassignMatch = normalized.match(/^unassign\s+all\s+(.+?\s+)?cards?$/);
  if (unassignMatch) {
    const filterStr = (unassignMatch[1] ?? '').trim() || 'all';
    const filter = buildCardFilter(filterStr, columns);
    return {
      description: `Unassign all assignees from ${filterStr} cards`,
      columnNames: filterColumnNames(filterStr),
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
    `Filter keywords: overdue, blocked, unassigned, assigned, or a COLUMN name on\n` +
    `that board (e.g. "Backlog", "In Progress"). Anything else refuses, naming the\n` +
    `word and listing the board's columns.\n\n` +
    `Examples:\n` +
    `  --goal "move all overdue cards to Review"\n` +
    `  --goal "assign all Backlog cards with no owner to alice"\n` +
    `  --goal "close all Done cards"`
  );
}

const hasNoOwner = (card: Card) => (card.assignees ?? []).length === 0;
const hasOwner = (card: Card) => (card.assignees ?? []).length > 0;

/**
 * The closed set of filter KEYWORDS. Everything else a goal names is a column.
 *
 * A `Map`, not an object literal: a token is user input, and `'constructor' in
 * {}` is true, so an object lookup hands `Object` back where a predicate was
 * expected.
 */
const KEYWORD_FILTERS = new Map<string, (card: Card) => boolean>([
  ['overdue', isOverdue],
  ['blocked', isBlocked],
  ['unassigned', hasNoOwner],
  ['no owner', hasNoOwner],
  ['with no owner', hasNoOwner],
  ['assigned', hasOwner],
]);

/** Tokens that narrow nothing, and so name neither a keyword nor a column. */
const NON_FILTERS = new Set(['all', 'the']);

/** Split a filter fragment into its narrowing tokens, lowercased and trimmed. */
function filterTokens(filterStr: string): string[] {
  return filterStr
    .toLowerCase()
    .split(/\s+and\s+/)
    .map((part) => part.trim())
    .filter((token) => !NON_FILTERS.has(token));
}

/**
 * The COLUMN names a filter fragment uses — every token that is not a keyword.
 *
 * ONE classification, shared with `buildCardFilter` below, and that sharing is
 * the fix rather than an economy: a token this function fails to report is a
 * token that goes straight back to being an unvalidated
 * `card.status === token`, which is #150. Adding a keyword to
 * `KEYWORD_FILTERS` is the only way to change either answer, so the two cannot
 * drift apart.
 */
export function filterColumnNames(filterStr: string): string[] {
  return filterTokens(filterStr).filter((token) => !KEYWORD_FILTERS.has(token));
}

/**
 * Build a card filter function from a filter string fragment.
 *
 * Handles the keywords in `KEYWORD_FILTERS`, "all", and column names. A column
 * name is compared against `card.status` — so pass the settled `columns` map,
 * or the comparison runs against the raw token and a word that names no column
 * at all silently matches nothing (#150). `filterColumnNames` names exactly the
 * tokens that map has to cover.
 */
export function buildCardFilter(
  filterStr: string,
  columns?: ColumnNames,
): (card: Card) => boolean {
  const filters = filterTokens(filterStr).map((token) => {
    const keyword = KEYWORD_FILTERS.get(token);
    if (keyword) return keyword;
    // The column's OWN spelling when the caller has settled it; the typed token
    // otherwise, which is the throwaway first pass.
    const wanted = (columns?.get(token) ?? token).toLowerCase();
    return (card: Card) => card.status?.toLowerCase() === wanted;
  });

  if (filters.length === 0) {
    // "all" with no specific filter
    return () => true;
  }

  return (card) => filters.every(f => f(card));
}

/**
 * Settle every column name a goal used against the board's real columns.
 *
 * This is the #150 fix. `buildCardFilter` read any non-keyword word as
 * `card.status === word`, so `--goal "move all frobnicated cards to Done" --yes`
 * printed "No cards match the goal" and exited 0 — a typo indistinguishable from
 * an empty result, on a bulk write with a skippable confirm. An unrecognised
 * word and a recognised one that matched nothing are two different outcomes;
 * this makes them two.
 *
 * The vocabulary is deliberately open — an arbitrary column name IS legitimate
 * input to an English goal — so the closed set it settles against is the board's
 * own columns, resolved by the SAME `ColumnDirectory` that settles
 * `cards list --filter "status:…"` and `batch move`. The refusal is therefore
 * identical in wording and in structured `detail` without a string being copied:
 * four commands refusing four ways is the next version of this bug (#138).
 *
 * @throws ColumnResolutionError (a `RefusalError`) — reaches `logError`, exit 1.
 */
async function settleColumns(
  names: readonly string[],
  client: FavroHttpClient,
  boardId: () => Promise<string>,
): Promise<ColumnNames> {
  if (names.length === 0) return new Map();
  const directory = new ColumnDirectory(client, client.organizationId);
  const board = await boardId();
  const settled = new Map<string, string>();
  for (const name of names) {
    if (settled.has(name.toLowerCase())) continue;
    const columnId = await directory.resolveColumnId(name, board);
    settled.set(name.toLowerCase(), (await directory.nameOf(columnId)) ?? name);
  }
  return settled;
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
      'Filter keywords: overdue, blocked, unassigned, assigned — or a COLUMN name on\n' +
      'that board (e.g. "Backlog"). A word that is neither refuses, naming the word\n' +
      'and listing the board\'s columns; it never silently selects zero cards.\n\n' +
      '<board> may be a board id or an exact board name.\n\n' +
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

        // `<board>` may be a NAME — `listCards` resolves one, so the command has
        // always accepted it. The scope lock GETs `/widgets/<id>`, and handed the
        // raw argument it 404s into "Scope check failed: Board Board A not
        // found" — a refusal naming the wrong problem (#82/#150). Settle it
        // first, at most once, and only if something asks: the thunk is what
        // keeps an unlocked user with a keyword-only goal off the network
        // entirely (#102/#104). Twin of `boardIdOnce` in `batch.ts`; inlined
        // rather than shared because #110 deletes this file.
        let pendingBoardId: Promise<string> | undefined;
        const boardId = () => (pendingBoardId ??= new BoardsAPI(client).resolveBoardId(board));

        const { checkResolvedScope } = await import('../lib/safety');
        await checkResolvedScope(client, boardId, options.force);

        // Settle EVERYTHING the goal names against its closed vocabulary here,
        // before the preview, before the prompt and before the board read — a
        // bulk write must never get as far as asking about a set it could not
        // resolve, and `--dry-run` gets the same refusal because a dry run that
        // plans zero cards is the same lie one step earlier.
        //
        // Both are async and `parseGoal` is not, so it runs once more with the
        // answers: an `assign` goal names a human where `card.assignees` hold
        // userIds (#59), and a filter or target status names a column where the
        // board owns the spelling (#150).
        const { resolveAssignee } = await import('../lib/assignee');
        const settledAssignee = parsedGoal.targetAssignee
          ? await resolveAssignee(client, parsedGoal.targetAssignee)
          : undefined;
        const settledColumns = await settleColumns(parsedGoal.columnNames, client, boardId);
        parsedGoal = parseGoal(options.goal, settledAssignee, settledColumns);

        const api = new CardsAPI(client);

        let allCards: Card[];
        try {
          allCards = await api.listCards(board);
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
