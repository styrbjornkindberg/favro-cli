/**
 * Batch Command — Bulk Operation Framework
 * CLA-1781 / FAVRO-019: Implement Bulk Operation Framework
 *
 * Commands:
 *   favro batch update --from-csv cards.csv [--dry-run] [--board <id>]
 *   favro batch move --board <source-id> --to-board <target-id> --filter "status:Completed" [--dry-run]
 *   favro batch assign --board <board-id> --filter "status:Backlog" --to @me [--dry-run]
 */

import { Command } from 'commander';
import * as fsPromises from 'fs/promises';
import CardsAPI, { Card } from '../lib/cards-api';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';
import { resolveAssignee } from '../lib/assignee';
import {
  BulkTransaction,
  BulkOperation,
  BulkCardChanges,
  parseCSVContent,
  csvRowToBulkOperation,
  formatBulkSummary,
  formatBulkPreview,
} from '../lib/bulk';

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

/**
 * Parse filter expressions like "status:Completed", "assignee:alice", "tag:bug".
 * Multiple --filter flags are ANDed together.
 */
export function parseFilterExpression(filterStr: string): (card: Card) => boolean {
  const [field, ...valueParts] = filterStr.split(':');
  const value = valueParts.join(':').trim().toLowerCase();
  const key = field.trim().toLowerCase();

  switch (key) {
    case 'status':
      return (card) => (card.status ?? '').toLowerCase() === value;
    case 'assignee':
    case 'owner':
      return (card) => (card.assignees ?? []).some(a => a.toLowerCase().includes(value));
    case 'tag':
    case 'label':
      return (card) => (card.tags ?? []).some(t => t.toLowerCase().includes(value));
    default:
      // Unknown filter — match nothing (safe default)
      return () => false;
  }
}

/**
 * Build a combined filter from multiple filter expressions (AND logic).
 */
export function buildFilterFn(filters: string[]): (card: Card) => boolean {
  if (filters.length === 0) return () => true;
  const fns = filters.map(parseFilterExpression);
  return (card) => fns.every(fn => fn(card));
}

// Assignee resolution lives in `src/lib/assignee.ts` — one home for every call
// site. The local placeholder that used to sit here returned the flag text
// verbatim, so the dedupe below compared a display name against `userId`s and
// never matched, and composed that name into the id array the write sends.

/** Sentinel: this row's card was deliberately not fetched, not failed to fetch. */
class SkipFetch extends Error {}

// ---------------------------------------------------------------------------
// Command Registration
// ---------------------------------------------------------------------------

export function registerBatchCommand(program: Command): void {
  const batch = program
    .command('batch')
    .description(
      'Bulk card operations — update, move, or assign many cards at once.\n\n' +
      'Commands:\n' +
      '  update    Update cards from a CSV file\n' +
      '  move      Move matching cards to another board/status\n' +
      '  assign    Assign matching cards to a user\n\n' +
      'Examples:\n' +
      '  favro batch update --from-csv cards.csv --dry-run\n' +
      '  favro batch move --board <src-id> --to-board <dst-id> --filter "status:Completed"\n' +
      '  favro batch assign --board <id> --filter "status:Backlog" --to @me\n\n' +
      'All commands support --dry-run to preview changes before applying them.\n' +
      'On failure, all committed changes are automatically rolled back.'
    );

  registerBatchUpdateCommand(batch);
  registerBatchMoveCommand(batch);
  registerBatchAssignCommand(batch);
}

// ---------------------------------------------------------------------------
// batch update
// ---------------------------------------------------------------------------

export function registerBatchUpdateCommand(batch: Command): void {
  batch
    .command('update')
    .description(
      'Update cards from a CSV file.\n\n' +
      'CSV format:\n' +
      '  card_id,status,owner,due_date,custom_field_x\n' +
      '  card-1,Done,alice,2026-04-01,high\n' +
      '  card-2,In Progress,,2026-04-15,\n\n' +
      'Examples:\n' +
      '  favro batch update --from-csv cards.csv\n' +
      '  favro batch update --from-csv cards.csv --dry-run\n' +
      '  favro batch update --from-csv cards.csv --json'
    )
    .requiredOption('--from-csv <file>', 'CSV file with card updates')
    .option('--dry-run', 'Preview changes without applying them')
    .option('--json', 'Output result as JSON')
    .option('--verbose', 'Show per-card progress')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(async (options: {
      fromCsv: string;
      dryRun?: boolean;
      json?: boolean;
      verbose?: boolean;
      yes?: boolean;
      force?: boolean;
    }) => {
      try {
        if (!options.dryRun) {
          const { confirmAction } = await import('../lib/safety');
          if (!(await confirmAction('Apply these bulk updates from CSV?', { yes: options.yes }))) {
            console.log('Aborted.');
            process.exit(0);
          }
        }

        // Read and parse CSV
        let content: string;
        try {
          content = await fsPromises.readFile(options.fromCsv, 'utf-8');
        } catch (err: any) {
          console.error(`✗ Cannot read CSV file "${options.fromCsv}": ${err.message}`);
          process.exit(1);
        }

        const { rows, errors: parseErrors } = parseCSVContent(content);

        if (parseErrors.length > 0) {
          console.error('✗ CSV validation errors:');
          for (const e of parseErrors) {
            console.error(`  Row ${e.row}: [${e.field}] ${e.message}`);
          }
          process.exit(1);
        }

        if (rows.length === 0) {
          console.error('✗ CSV file has no valid data rows');
          process.exit(1);
        }

        // Execute or prepare operations (fetch previousState for rollback)
        const client = await createFavroClient();
        const api = new CardsAPI(client);

        // The write path fetches each card anyway, for the rollback snapshot. The
        // PREVIEW path fetches only to learn the board — so when nothing is
        // locked there is no board to check and no reason to ask (#102/#104: "no
        // extra requests on that path"). A locked preview still pays, which is
        // the price #103 accepted for a preview that tells the truth.
        const { readConfig } = await import('../lib/config');
        const { checkScope } = await import('../lib/safety');
        const scopeConfig = await readConfig();
        const locked = !!scopeConfig?.scopeCollectionId;

        const ops: BulkOperation[] = [];
        // The rollback GET below also answers "which board does this row write
        // to?" — the scope lock needs that, and a second round of GETs to learn
        // it would double the wire cost of every batch.
        const targetBoards = new Set<string>();
        for (const row of rows) {
          let previousState: Partial<BulkCardChanges> | undefined;
          // The board is resolved on BOTH paths; only the rollback snapshot is
          // write-path-only, because a preview has nothing to roll back.
          let boardId = '';
          try {
            if (options.dryRun && !locked) throw new SkipFetch();
            const card = await api.getCard(row.card_id);
            boardId = card?.boardId ?? '';
            if (!options.dryRun) {
              previousState = {
                name: card.name,
                status: card.status,
                assignees: card.assignees,
                tags: card.tags,
                dueDate: card.dueDate,
                boardId: card.boardId,
              };
            }
          } catch (error) {
            // Card not found or unreachable — previousState stays empty;
            // rollback will send a no-op, which is safe. A deliberately skipped
            // fetch is not a failure and leaves no board behind to check.
            if (error instanceof SkipFetch) { ops.push(csvRowToBulkOperation(row, previousState)); continue; }
            if (!options.dryRun) previousState = {};
          }
          // A row whose card could not be read has an UNKNOWN board, which is
          // not the same as an allowed one. The empty string hands it to the
          // shared refusal rather than dropping the row out of the check.
          targetBoards.add(boardId);
          ops.push(csvRowToBulkOperation(row, previousState));
        }

        // Take the lock on every distinct board the batch touches, before the
        // transaction exists AND before the preview. A CSV is free to straddle
        // boards, and a batch that straddles the lock has to refuse as a whole —
        // checking board-by-board mid-execution would leave the rows before the
        // violation already written and the compensation log doing work the lock
        // should have prevented. No-op when no lock is configured.
        //
        // Before the PREVIEW too, matching `cards update --from-csv` (#103), the
        // two sibling `batch` subcommands below, and `dispatch.ts`: the lock runs
        // ahead of a preview by design, so a preview is not a way around it — and
        // a dry-run that cheerfully reports "would update CLA-999" when the real
        // run will refuse is misinformation about the write it exists to describe.
        for (const boardId of targetBoards) {
          await checkScope(boardId, client, scopeConfig, options.force);
        }

        // Dry-run: show preview without executing
        if (options.dryRun) {
          if (!options.json) {
            const preview = formatBulkPreview(ops, `Dry-run preview — ${rows.length} update(s)`);
            console.log(preview);
            console.log(`ℹ  Dry-run mode. No changes were made.`);
            console.log(`   Run without --dry-run to apply these changes.`);
          } else {
            const tx = new BulkTransaction(api);
            tx.addAll(ops);
            console.log(tx.formatDryRunJSON());
          }
          return;
        }

        // Execute
        const tx = new BulkTransaction(api);
        tx.addAll(ops);

        if (!options.json) {
          console.log(`⚙  Applying ${ops.length} update(s)...`);
        }
        const result = await tx.execute({ verbose: options.verbose });

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(formatBulkSummary(result));
        }

        if (result.failure > 0) process.exit(1);
      } catch (error) {
        logError(error, false);
        process.exit(1);
      }
    });
}

// ---------------------------------------------------------------------------
// batch move
// ---------------------------------------------------------------------------

export function registerBatchMoveCommand(batch: Command): void {
  batch
    .command('move')
    .description(
      'Move matching cards from one board/status to another.\n\n' +
      'Examples:\n' +
      '  favro batch move --board <src-id> --to-board <dst-id> --filter "status:Completed"\n' +
      '  favro batch move --board <id> --status Done --dry-run\n\n' +
      'Filters (repeatable, AND logic):\n' +
      '  status:<value>   Match by status\n' +
      '  assignee:<user>  Match by assignee\n' +
      '  tag:<tag>        Match by tag'
    )
    .requiredOption('--board <id>', 'Source board ID')
    .option('--to-board <id>', 'Target board ID to move cards to')
    .option('--status <value>', 'Set target status')
    .option(
      '--filter <expression>',
      'Filter expression (repeatable)',
      (val: string, prev: string[]) => prev.concat([val]),
      [] as string[]
    )
    .option('--dry-run', 'Preview changes without applying them')
    .option('--json', 'Output result as JSON')
    .option('--verbose', 'Show per-card progress')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(async (options: {
      board: string;
      toBoard?: string;
      status?: string;
      filter: string[];
      dryRun?: boolean;
      json?: boolean;
      verbose?: boolean;
      yes?: boolean;
      force?: boolean;
    }) => {
      try {
        if (!options.toBoard && !options.status) {
          console.error('✗ Specify --to-board and/or --status to set the target state');
          process.exit(1);
        }

        const client = await createFavroClient();
        
        const { readConfig } = await import('../lib/config');
        const { checkScope, confirmAction } = await import('../lib/safety');
        await checkScope(options.board, client, await readConfig(), options.force);
        
        if (!options.dryRun) {
          if (!(await confirmAction(`Apply batch move to cards from board ${options.board}?`, { yes: options.yes }))) {
            console.log('Aborted.');
            process.exit(0);
          }
        }

        const api = new CardsAPI(client);

        // Fetch cards from source board
        let allCards: Card[];
        try {
          allCards = await api.listCards(options.board);
        } catch (err: any) {
          if (err?.response?.status === 404) {
            console.error(`✗ Board not found: "${options.board}"`);
          } else {
            logError(err, false);
          }
          process.exit(1);
        }

        // Apply filters
        const filterFn = buildFilterFn(options.filter);
        const matchingCards = allCards.filter(filterFn);

        if (matchingCards.length === 0) {
          if (!options.json) {
            console.log(`\n⚠  No cards match the filter(s).`);
            console.log(`   Board has ${allCards.length} total card(s).`);
          } else {
            console.log(JSON.stringify({ total: 0, success: 0, failure: 0, skipped: 0, errors: [] }));
          }
          return;
        }

        // Build operations (BLOCKER 5: capture boardId in previousState for rollback)
        const ops: BulkOperation[] = matchingCards.map((card) => ({
          type: 'move' as const,
          cardId: card.cardId,
          cardName: card.name,
          changes: {
            ...(options.status ? { status: options.status } : {}),
            ...(options.toBoard ? { boardId: options.toBoard } : {}),
          },
          previousState: {
            status: card.status,
            boardId: card.boardId,
          },
          status: 'pending' as const,
        }));

        // Dry-run
        if (options.dryRun) {
          const title = `Dry-run preview — move ${ops.length} card(s)` +
            (options.status ? ` → status: ${options.status}` : '') +
            (options.toBoard ? ` → board: ${options.toBoard}` : '');
          if (!options.json) {
            console.log(formatBulkPreview(ops, title));
            console.log(`ℹ  Dry-run mode. No changes were made.`);
          } else {
            const tx = new BulkTransaction(api);
            tx.addAll(ops);
            console.log(tx.formatDryRunJSON());
          }
          return;
        }

        // Execute
        const tx = new BulkTransaction(api);
        tx.addAll(ops);

        if (!options.json) {
          console.log(`⚙  Moving ${ops.length} card(s)...`);
        }
        const result = await tx.execute({ verbose: options.verbose });

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(formatBulkSummary(result));
        }

        if (result.failure > 0) process.exit(1);
      } catch (error) {
        logError(error, false);
        process.exit(1);
      }
    });
}

// ---------------------------------------------------------------------------
// batch assign
// ---------------------------------------------------------------------------

export function registerBatchAssignCommand(batch: Command): void {
  batch
    .command('assign')
    .description(
      'Assign matching cards to a user.\n\n' +
      'Examples:\n' +
      '  favro batch assign --board <id> --filter "status:Backlog" --to @me\n' +
      '  favro batch assign --board <id> --filter "status:Backlog" --to alice --dry-run\n\n' +
      'Use @me as the assignee to assign to yourself.\n\n' +
      'Filters (repeatable, AND logic):\n' +
      '  status:<value>   Match by status\n' +
      '  assignee:<user>  Match by assignee\n' +
      '  tag:<tag>        Match by tag'
    )
    .requiredOption('--board <id>', 'Board ID to assign cards on')
    .requiredOption('--to <user>', 'User to assign cards to (use @me for yourself)')
    .option(
      '--filter <expression>',
      'Filter expression (repeatable)',
      (val: string, prev: string[]) => prev.concat([val]),
      [] as string[]
    )
    .option('--dry-run', 'Preview changes without applying them')
    .option('--json', 'Output result as JSON')
    .option('--verbose', 'Show per-card progress')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(async (options: {
      board: string;
      to: string;
      filter: string[];
      dryRun?: boolean;
      json?: boolean;
      verbose?: boolean;
      yes?: boolean;
      force?: boolean;
    }) => {
      try {
        const client = await createFavroClient();

        // Resolve first: an unknown or ambiguous assignee refuses before any
        // card is read or written. `assigneeId` is what `card.assignees` holds
        // (userIds), so the dedupe below can actually match.
        const assigneeId = await resolveAssignee(client, options.to);

        const { readConfig } = await import('../lib/config');
        const { checkScope, confirmAction } = await import('../lib/safety');
        await checkScope(options.board, client, await readConfig(), options.force);
        
        if (!options.dryRun) {
          if (!(await confirmAction(`Apply batch assign to cards on board ${options.board}?`, { yes: options.yes }))) {
            console.log('Aborted.');
            process.exit(0);
          }
        }
        
        const api = new CardsAPI(client);

        // Fetch cards from board
        let allCards: Card[];
        try {
          allCards = await api.listCards(options.board);
        } catch (err: any) {
          if (err?.response?.status === 404) {
            console.error(`✗ Board not found: "${options.board}"`);
          } else {
            logError(err, false);
          }
          process.exit(1);
        }

        // Apply filters, then skip cards already assigned to this user
        const filterFn = buildFilterFn(options.filter);
        const baseMatchingCards = allCards.filter(filterFn);
        const matchingCards = baseMatchingCards.filter(
          (card) => !(card.assignees ?? []).includes(assigneeId)
        );

        const alreadyAssigned = baseMatchingCards.length - matchingCards.length;

        if (matchingCards.length === 0) {
          if (!options.json) {
            console.log(`\n⚠  No cards match the filter(s) (${allCards.length} total on board).`);
            if (alreadyAssigned > 0) {
              console.log(`   ${alreadyAssigned} card(s) already assigned to "${options.to}" — skipped.`);
            }
          } else {
            console.log(JSON.stringify({ total: 0, success: 0, failure: 0, skipped: alreadyAssigned, errors: [] }));
          }
          return;
        }

        // Build operations
        const ops: BulkOperation[] = matchingCards.map((card) => ({
          type: 'assign' as const,
          cardId: card.cardId,
          cardName: card.name,
          changes: {
            assignees: [...(card.assignees ?? []), assigneeId],
          },
          previousState: {
            assignees: card.assignees ?? [],
          },
          status: 'pending' as const,
        }));

        // Dry-run
        if (options.dryRun) {
          const title = `Dry-run preview — assign ${ops.length} card(s) to "${options.to}"`;
          if (!options.json) {
            console.log(formatBulkPreview(ops, title));
            if (alreadyAssigned > 0) {
              console.log(`   ℹ  ${alreadyAssigned} card(s) already assigned — would be skipped.`);
            }
            console.log(`ℹ  Dry-run mode. No changes were made.`);
          } else {
            const tx = new BulkTransaction(api);
            tx.addAll(ops);
            console.log(tx.formatDryRunJSON());
          }
          return;
        }

        // Execute
        const tx = new BulkTransaction(api);
        tx.addAll(ops);

        if (!options.json) {
          console.log(`⚙  Assigning ${ops.length} card(s) to "${options.to}"...`);
        }
        const result = await tx.execute({ verbose: options.verbose });
        result.skipped = alreadyAssigned;

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(formatBulkSummary(result));
          if (alreadyAssigned > 0) {
            console.log(`   ⏭  Already assigned: ${alreadyAssigned}`);
          }
        }

        if (result.failure > 0) process.exit(1);
      } catch (error) {
        logError(error, false);
        process.exit(1);
      }
    });
}

export default registerBatchCommand;
