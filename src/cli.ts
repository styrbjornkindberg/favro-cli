#!/usr/bin/env node
/**
 * Favro CLI — Entry Point
 *
 * Usage:
 *   favro auth login                  # set up API key interactively
 *   favro auth check                  # verify API key is valid
 *   favro cards list [--board <id>] [--status <s>] [--assignee <a>] [--limit <n>]
 *   favro cards create <title> [--description <d>] [--status <s>] [--board <id>] [--dry-run]
 *   favro cards create --csv <file> --board <id> [--dry-run]
 *   favro cards update <cardId> [--name <n>] [--status <s>] [--assignees <a>] [--dry-run]
 *   favro cards export <board> --format json|csv [--out <file>] [--filter <expr>]
 *
 * Config (priority: --api-key flag > FAVRO_API_KEY env > ~/.favro/config.json):
 *   FAVRO_API_KEY    API key (new preferred env var)
 *   FAVRO_API_TOKEN  API key (legacy env var, still supported)
 */

import { Command } from 'commander';
import * as path from 'path';
import CardsAPI, { UpdateCardRequest } from './lib/cards-api';
import { writeCardsCSV, writeCardsJSON, normalizeCard, cardsToCSV } from './lib/csv';
import { applyFilters, ExportFormat } from './commands/cards-export';
import { Card } from './lib/cards-api';
import { registerAuthCommand } from './commands/auth';
import { registerScopeCommand } from './commands/scope';
import { registerBoardsListCommand } from './commands/boards-list';
import { registerBoardsGetCommand } from './commands/boards-get';
import { registerBoardsCreateCommand } from './commands/boards-create';
import { registerBoardsUpdateCommand } from './commands/boards-update';
import { registerBoardsDeleteCommand } from './commands/boards-delete';
import { registerReleaseCheckCommand } from './commands/release-check';
import { registerRisksCommand } from './commands/risks';
import { registerBatchSmartCommand } from './commands/batch-smart';
import { registerBatchCommand } from './commands/batch';
import { registerAuditCommand } from './commands/favro-audit';
import { registerWhoChangedCommand } from './commands/favro-who-changed';
import { registerCollectionsListCommand } from './commands/collections-list';
import { registerCollectionsGetCommand } from './commands/collections-get';
import { registerCollectionsCreateCommand } from './commands/collections-create';
import { registerCollectionsUpdateCommand } from './commands/collections-update';
import { registerCollectionsDeleteCommand } from './commands/collections-delete';
import { registerCardsGetCommand } from './commands/cards-get';
import { registerCardsLinkCommands } from './commands/cards-link';
import { registerCustomFieldsCommands } from './commands/custom-fields';
import { registerMembersCommand } from './commands/members';
import { registerCommentsCommand } from './commands/comments';
import { registerActivityCommand } from './commands/activity';
import { registerWebhooksCommand } from './commands/webhooks';
import { registerContextCommand } from './commands/context';
import { registerProposeCommand } from './commands/propose';
import { registerExecuteCommand } from './commands/execute';
import { registerQueryCommand } from './commands/query';
import { registerStandupCommand } from './commands/standup';
import { registerSprintPlanCommand } from './commands/sprint-plan';
import { registerColumnsCommands } from './commands/columns';
import { registerWidgetsCommands } from './commands/widgets';
import { registerTagsCommands } from './commands/tags';
import { registerTasksCommands } from './commands/tasks';
import { registerTaskListsCommands } from './commands/tasklists';
import { registerDependenciesCommands } from './commands/dependencies';
import { registerAttachmentsCommands } from './commands/attachments';
import { registerUsersCommands } from './commands/users';
import { registerAICommands } from './commands/ai';
import { registerSkillCommands } from './commands/skill';
import { registerGitCommands } from './commands/git';
import { registerShellCommand } from './commands/shell';
import { registerBoardTuiCommand } from './commands/board-tui';
import { registerDiffCommand } from './commands/diff';
import { registerBrowseCommand } from './commands/browse';
import { registerMyCardsCommand } from './commands/my-cards';
import { registerMyStandupCommand } from './commands/my-standup';
import { registerNextCommand } from './commands/next';
import { registerWorkloadCommand } from './commands/workload';
import { registerStaleCommand } from './commands/stale';
import { registerOverviewCommand } from './commands/overview';
import { registerHealthCommand } from './commands/health';
import { registerTeamCommand } from './commands/team';
import { registerInitCommand } from './commands/init';
import { runMainMenu } from './commands/main-menu';
import { logError } from './lib/error-handler';
import { ProgressBar } from './lib/progress';
import { createFavroClient } from './lib/client-factory';

/**
 * Build the CLI program (exported for testing).
 * Guards parseAsync behind require.main === module so that
 * importing this module in tests does NOT trigger argument parsing.
 */
export function buildProgram(): Command {

const program = new Command();

program
  .name('favro')
  .description(
    'Favro command-line interface — manage boards and cards from your terminal.\n\n' +
    'Quick start:\n' +
    '  favro auth login                  Set up your API key\n' +
    '  favro boards list                 List your boards\n' +
    '  favro cards list --board <id>     List cards on a board\n' +
    '  favro cards create "My card"      Create a card\n' +
    '  favro cards export <id> --format csv --out cards.csv\n\n' +
    'Authentication:\n' +
    '  Set FAVRO_API_KEY env var, or run `favro auth login` to save to ~/.favro/config.json\n\n' +
    'Full docs: https://github.com/square-moon/favro-cli#readme'
  )
  .version('2.0.1')
  .option('--verbose', 'Show stack traces for errors');

// ─── auth commands ────────────────────────────────────────────────────────────
registerAuthCommand(program);

// ─── scope command ────────────────────────────────────────────────────────────
registerScopeCommand(program);

// ─── boards parent ────────────────────────────────────────────────────────────
const boardsCmd = program.command('boards').description('Board operations');

// ─── boards list ─────────────────────────────────────────────────────────────
registerBoardsListCommand(boardsCmd);

// ─── boards get ──────────────────────────────────────────────────────────────
registerBoardsGetCommand(boardsCmd);

// ─── boards create ───────────────────────────────────────────────────────────
registerBoardsCreateCommand(boardsCmd);

// ─── boards update ───────────────────────────────────────────────────────────
registerBoardsUpdateCommand(boardsCmd);
registerBoardsDeleteCommand(boardsCmd);

// ─── release-check command ──────────────────────────────────────────────────────
registerReleaseCheckCommand(program);

// ─── risks command ───────────────────────────────────────────────────────────────
registerRisksCommand(program);
registerBatchSmartCommand(program);
registerBatchCommand(program);

// ─── audit command ───────────────────────────────────────────────────────────
registerAuditCommand(program);

// ─── who-changed command ─────────────────────────────────────────────────────
registerWhoChangedCommand(program);

// ─── collections parent ──────────────────────────────────────────────────────
const collectionsCmd = program.command('collections').description('Collection operations');
registerCollectionsListCommand(collectionsCmd);
registerCollectionsGetCommand(collectionsCmd);
registerCollectionsCreateCommand(collectionsCmd);
registerCollectionsUpdateCommand(collectionsCmd);
registerCollectionsDeleteCommand(collectionsCmd);

// ─── columns commands ────────────────────────────────────────────────────────
registerColumnsCommands(program);

// ─── widgets commands ────────────────────────────────────────────────────────
registerWidgetsCommands(program);

// ─── tags commands ────────────────────────────────────────────────────────
registerTagsCommands(program);

// ─── tasks commands ────────────────────────────────────────────────────────
registerTasksCommands(program);

// ─── tasklists commands ────────────────────────────────────────────────────────
registerTaskListsCommands(program);

// ─── dependencies commands ────────────────────────────────────────────────────────
registerDependenciesCommands(program);

// ─── attachments commands ────────────────────────────────────────────────────────
registerAttachmentsCommands(program);

// ─── users & groups commands ───────────────────────────────────────────────────
registerUsersCommands(program);

// ─── AI commands ────────────────────────────────────────────────────────────
registerAICommands(program);

// ─── skill commands ─────────────────────────────────────────────────────────
registerSkillCommands(program);

// ─── git commands ───────────────────────────────────────────────────────────
registerGitCommands(program);

// ─── shell, board TUI, diff, browse ─────────────────────────────────────────
registerShellCommand(program);
registerBoardTuiCommand(program);
registerDiffCommand(program);
registerBrowseCommand(program);

// ─── v2 persona commands (LLM-first, JSON default) ─────────────────────────
registerMyCardsCommand(program);
registerMyStandupCommand(program);
registerNextCommand(program);
registerWorkloadCommand(program);
registerStaleCommand(program);
registerOverviewCommand(program);
registerHealthCommand(program);
registerTeamCommand(program);

// ─── init command ───────────────────────────────────────────────────────────
registerInitCommand(program);

// ─── cards parent ────────────────────────────────────────────────────────────
const cards = program.command('cards').description(
  'Card operations — get, list, create, update, export, link, unlink, and move cards.\n\n' +
  'Subcommands:\n' +
  '  get     Retrieve a card by ID with optional metadata\n' +
  '  list    List cards from a board with filtering\n' +
  '  create  Create a card (single, bulk JSON, or CSV import)\n' +
  '  update  Update an existing card by ID\n' +
  '  export  Export all cards from a board to JSON or CSV\n' +
  '  link    Link a card to another card\n' +
  '  unlink  Remove a link between two cards\n' +
  '  move    Move a card to a different board\n\n' +
  'Examples:\n' +
  '  favro cards get <cardId> --include board,collection\n' +
  '  favro cards list <board-id> --filter "customField:value"\n' +
  '  favro cards link <cardId> --to <targetId> --type depends\n' +
  '  favro cards unlink <cardId> --from <linkedCardId>\n' +
  '  favro cards move <cardId> --to-board <boardId> --position top\n' +
  '  favro cards create "My card" --board <id>\n' +
  '  favro cards export <id> --format csv --out cards.csv'
);

// ─── cards get ───────────────────────────────────────────────────────────────
registerCardsGetCommand(cards);

// ─── cards list ──────────────────────────────────────────────────────────────
cards
  .command('list [boardId]')
  .description(
    'List cards from a board with optional filters.\n\n' +
    'Pagination: default 25 cards, max 100 per request.\n\n' +
    'Examples:\n' +
    '  favro cards list <board-id>\n' +
    '  favro cards list <board-id> --status "In Progress" --limit 100\n' +
    '  favro cards list <board-id> --assignee alice --json\n' +
    '  favro cards list <board-id> --tag bug\n' +
    '  favro cards list <board-id> --filter "customField:value"\n\n' +
    'Tip: Use `favro boards list` to find board IDs.'
  )
  .option('--board <id>', 'Board ID to list cards from (alternative to positional arg)')
  .option('--status <status>', 'Filter by status')
  .option('--assignee <user>', 'Filter by assignee')
  .option('--tag <tag>', 'Filter by tag')
  .option('--filter <expression>', 'Filter cards using query syntax (e.g. "customField:value")')
  // NOTE: --include is intentionally omitted from cards list — metadata includes are a cards get feature.
  // Removing unimplemented flag per CLA-1785 critic feedback (Issue #3).
  .option('--limit <number>', 'Maximum number of cards (default 25, max 100)', '25')
  .option('--json', 'Output as JSON')
  .action(async (boardId: string | undefined, options) => {
    try {
      const client = await createFavroClient();
      const api = new CardsAPI(client);

      // Support positional boardId or --board option
      const effectiveBoardId = boardId ?? options.board;

      if (!effectiveBoardId) {
        console.error('Error: Board ID is required. Pass as positional argument or use --board <id>');
        process.exit(1);
      }

      const parsedLimit = parseInt(options.limit, 10);
      // CLA-1785 critic fix: enforce max 100 cap to prevent DoS via --limit 9999
      const limit = (!isNaN(parsedLimit) && parsedLimit >= 1) ? Math.min(parsedLimit, 100) : 25;
      let cardList = await api.listCards(effectiveBoardId, limit, options.filter);

      if (options.status) {
        cardList = cardList.filter(c => c.status?.toLowerCase() === options.status.toLowerCase());
      }
      if (options.assignee) {
        cardList = cardList.filter(c => (c.assignees ?? []).some(
          a => a.toLowerCase().includes(options.assignee.toLowerCase())
        ));
      }
      if (options.tag) {
        cardList = cardList.filter(c => (c.tags ?? []).some(
          t => t.toLowerCase().includes(options.tag.toLowerCase())
        ));
      }

      if (options.json) {
        console.log(JSON.stringify(cardList, null, 2));
      } else {
        console.log(`Found ${cardList.length} card(s):`);
        if (cardList.length > 0) {
          const rows = cardList.map(card => ({
            ID: card.cardId,
            Title: (card.name ?? '').length > 40 ? (card.name ?? '').slice(0, 37) + '...' : (card.name ?? ''),
            Status: card.status ?? '—',
            Assignees: (card.assignees ?? []).join(', ') || '—',
            Tags: (card.tags ?? []).join(', ') || '—',
            Created: card.createdAt ? card.createdAt.slice(0, 10) : '—',
          }));
          console.table(rows);
        }
      }
    } catch (error) {
      logError(error, program.opts().verbose);
      process.exit(1);
    }
  });

// ─── cards link / unlink / move ──────────────────────────────────────────────
registerCardsLinkCommands(cards);

/**
 * Parse a CSV string into an array of objects using the header row.
 * Handles simple RFC 4180 CSV (no quoted newlines).
 */
function parseCSV(content: string): Record<string, string>[] {
  const lines = content.trim().split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = values[i] ?? ''; });
    return obj;
  });
}

// ─── cards create ─────────────────────────────────────────────────────────────
cards
  .command('create [title]')
  .description(
    'Create a new card, or bulk-import cards from CSV or JSON.\n\n' +
    'Examples:\n' +
    '  favro cards create "Fix login bug" --board <id>\n' +
    '  favro cards create "My card" --board <id> --status "Todo" --description "Details"\n' +
    '  favro cards create --csv tasks.csv --board <id>\n' +
    '  favro cards create --bulk tasks.json --board <id>\n' +
    '  favro cards create --csv tasks.csv --board <id> --dry-run\n\n' +
    'CSV format (columns: name, description, status):\n' +
    '  name,description,status\n' +
    '  "Fix bug","Safari issue","In Progress"\n' +
    '  "Add feature","User request","Backlog"\n\n' +
    'Tip: Always test with --dry-run before bulk importing.'
  )
  .option('--board <id>', 'Target board ID')
  .option('--description <text>', 'Card description')
  .option('--status <status>', 'Card status')
  .option('--assignee <user>', 'Assignee username or user ID')
  .option('--parent <cardId>', 'Parent card ID (makes this a child card)')
  .option('--bulk <file>', 'Bulk create from JSON file')
  .option('--csv <file>', 'Bulk import from CSV file (columns: name, description, status)')
  .option('--dry-run', 'Print what would be created without making API calls')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--force', 'Bypass scope check')
  .option('--json', 'Output as JSON')
  .action(async (title: string | undefined, options) => {
    if (!title && !options.csv && !options.bulk) {
      console.error('Error: provide a title or use --csv/--bulk for bulk import');
      process.exit(1);
    }
    try {
      const fs = await import('fs/promises');

      // ── CSV import ──────────────────────────────────────────────────────────
      if (options.csv) {
        const content = await fs.readFile(options.csv, 'utf-8');
        const rows = parseCSV(content);
        if (rows.length === 0) {
          console.error('Error: CSV file is empty or has no data rows');
          process.exit(1);
        }
        const cards = rows.map(row => ({
          name: row.name || row.title || row.Name || row.Title || '',
          description: row.description || row.Description || undefined,
          status: row.status || row.Status || undefined,
          boardId: options.board,
        })).filter(c => c.name);

        if (options.dryRun) {
          console.log(`[dry-run] Would create ${cards.length} cards from CSV:`);
          cards.forEach(c => console.log(`  - ${c.name}`));
          return;
        }

        const client = await createFavroClient();
        if (options.board) {
          const { readConfig } = await import('./lib/config');
          const { checkScope } = await import('./lib/safety');
          await checkScope(options.board, client, await readConfig(), options.force);
        }

        const api = new CardsAPI(client);
        const progress = new ProgressBar('Creating cards', cards.length);
        progress.update(0);
        const createdCards = await api.createCards(cards);
        progress.update(createdCards.length);
        progress.done(`Created ${createdCards.length} cards from CSV`);
        if (options.json) console.log(JSON.stringify(createdCards, null, 2));
        return;
      }

      // ── Bulk JSON import ────────────────────────────────────────────────────
      if (options.bulk) {
        const data = JSON.parse(await fs.readFile(options.bulk, 'utf-8'));
        if (options.dryRun) {
          const count = Array.isArray(data) ? data.length : 1;
          console.log(`[dry-run] Would create ${count} cards from bulk JSON`);
          return;
        }
        const client = await createFavroClient();
        if (options.board) { // Note: bulk import JSON doesn't directly use --board as much, but if it does
          const { readConfig } = await import('./lib/config');
          const { checkScope } = await import('./lib/safety');
          await checkScope(options.board, client, await readConfig(), options.force);
        }
        const api = new CardsAPI(client);
        const total = Array.isArray(data) ? data.length : 1;
        const progress = new ProgressBar('Creating cards', total);
        progress.update(0);
        const createdCards = await api.createCards(data);
        progress.update(createdCards.length);
        progress.done(`Created ${createdCards.length} cards`);
        if (options.json) console.log(JSON.stringify(createdCards));
        return;
      }

      // ── Single card ─────────────────────────────────────────────────────────
      if (options.dryRun) {
        console.log(`[dry-run] Would create card: "${title}" on board ${options.board}`);
        return;
      }

      const client = await createFavroClient();
      if (options.board) {
        const { readConfig } = await import('./lib/config');
        const { checkScope } = await import('./lib/safety');
        await checkScope(options.board, client, await readConfig(), options.force);
      }
      
      const api = new CardsAPI(client);
      const card = await api.createCard({
        name: title ?? '',
        description: options.description ? options.description.replace(/\\n/g, '\n') : undefined,
        status: options.status,
        boardId: options.board,
        assignees: options.assignee ? [options.assignee] : undefined,
        parentCardId: options.parent,
      });
      console.log(`✓ Card created: ${card.cardId}`);
      if (options.json) console.log(JSON.stringify(card));
    } catch (error) {
      logError(error, program.opts().verbose);
      process.exit(1);
    }
  });

// ─── cards update ─────────────────────────────────────────────────────────────
cards
  .command('update [cardId]')
  .description(
    'Update a card (single) or batch-update/move/assign cards.\n\n' +
    'Single card update:\n' +
    '  favro cards update <cardId> --status "Done"\n' +
    '  favro cards update <cardId> --name "New title" --status "In Progress"\n' +
    '  favro cards update <cardId> --assignees "alice,bob"\n' +
    '  favro cards update <cardId> --column "Developing" --board <boardId>\n' +
    '  favro cards update <cardId> --status "Done" --dry-run\n\n' +
    'Batch update from CSV:\n' +
    '  favro cards update --from-csv bulk.csv --board Q2-Dev\n' +
    '  favro cards update --from-csv bulk.csv --board Q2-Dev --dry-run\n\n' +
    '  CSV columns: cardId, status, assignee, dueDate (all optional except cardId)\n\n' +
    'Batch move/assign with filter:\n' +
    '  favro cards update --board Q2-Dev --label urgent --status done\n' +
    '  favro cards update --board Q2-Dev --assignee alice\n\n' +
    'Tip: Use `favro cards list --json` to find card IDs.'
  )
  .option('--name <name>', 'New card name (single card update)')
  .option('--description <desc>', 'Card description (single card update)')
  .option('--append-description <text>', 'Append text to existing description')
  .option('--status <status>', 'Card status to set')
  .option('--assignees <list>', 'Assignees (comma-separated, single card update)')
  .option('--assignee <user>', 'Assignee for batch assign (use with --board)')
  .option('--tags <list>', 'Tags (comma-separated, single card update)')
  .option('--column <column>', 'Move card to this column by name (use with --board)')
  .option('--parent <cardId>', 'Parent card ID (makes this a child card)')
  .option('--label <label>', 'Label/tag filter for batch operations (use with --board)')
  .option('--board <id>', 'Board ID — required for batch operations, optional for single')
  .option('--from-csv <file>', 'CSV file with card updates (columns: cardId, status, assignee, dueDate)')
  .option('--dry-run', 'Preview changes without making API calls')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--force', 'Bypass scope check')
  .option('--json', 'Output as JSON')
  .option('--verbose', 'Show per-card progress')
  .action(async (cardId: string | undefined, options) => {
    // Resolve client once — shared across all 3 update code paths
    let client: import('./lib/http-client').default;
    try { client = await createFavroClient(); }
    catch (err: any) { logError(err, program.opts().verbose); process.exit(1); return; }

    // ── CSV batch update ──────────────────────────────────────────────────────
    if (options.fromCsv) {
      if (!options.dryRun) {
        const { confirmAction } = await import('./lib/safety');
        if (!(await confirmAction('Apply these bulk updates to cards from CSV?', { yes: options.yes }))) {
          console.log('Aborted.');
          process.exit(0);
        }
      }
      
      try {
        const fs = await import('fs/promises');
        const {
          parseCSVContent,
          csvRowToBulkOperation,
          BulkTransaction,
          formatBulkPreview,
          formatBulkSummary,
        } = await import('./lib/bulk');

        let content: string;
        try {
          content = await fs.readFile(options.fromCsv, 'utf-8');
        } catch (err: any) {
          console.error(`✗ Cannot read CSV file "${options.fromCsv}": ${err.message}`);
          process.exit(1);
          return;
        }

        // Map CSV columns: cardId → card_id, assignee → owner, dueDate → due_date
        // (our bulk CSV format uses snake_case; accept camelCase too)
        const normalised = content
          .split('\n')
          .map((line, i) => {
            if (i === 0) {
              // Normalise header row
              return line
                .replace(/\bcardId\b/gi, 'card_id')
                .replace(/\bassignee\b/gi, 'owner')
                .replace(/\bdueDate\b/gi, 'due_date');
            }
            return line;
          })
          .join('\n');

        const { rows, errors: parseErrors } = parseCSVContent(normalised);

        if (parseErrors.length > 0) {
          console.error('✗ CSV validation errors:');
          for (const e of parseErrors) {
            console.error(`  Row ${e.row}: [${e.field}] ${e.message}`);
          }
          process.exit(1);
          return;
        }

        if (rows.length === 0) {
          console.error('✗ CSV file has no valid data rows');
          process.exit(1);
          return;
        }

        const api = new CardsAPI(client);

        // Build operations; fetch previousState for atomic rollback
        const ops = [];
        for (const row of rows) {
          let previousState: Record<string, unknown> | undefined;
          if (!options.dryRun) {
            try {
              const card = await api.getCard(row.card_id);
              previousState = {
                name: card.name,
                status: card.status,
                assignees: card.assignees,
                tags: card.tags,
                dueDate: card.dueDate,
                boardId: card.boardId,
              };
            } catch {
              previousState = {};
            }
          }
          ops.push(csvRowToBulkOperation(row, previousState as any));
        }

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
        logError(error, program.opts().verbose);
        process.exit(1);
      }
      return;
    // (end of fromCsv path)
    }

    // ── Batch move/assign with board filter ───────────────────────────────────
    if (options.board && !cardId) {
      if (!options.dryRun) {
        const { confirmAction } = await import('./lib/safety');
        if (!(await confirmAction(`Apply batch updates to cards on board ${options.board}?`, { yes: options.yes }))) {
          console.log('Aborted.');
          process.exit(0);
        }
      }
      
      try {
        const { readConfig } = await import('./lib/config');
        const { checkScope } = await import('./lib/safety');
        await checkScope(options.board, client, await readConfig(), options.force);
        
        const { buildFilterFn } = await import('./commands/batch');
        const {
          BulkTransaction,
          formatBulkPreview,
          formatBulkSummary,
        } = await import('./lib/bulk');

        const api = new CardsAPI(client!);

        let allCards: Card[];
        try {
          allCards = await api.listCards(options.board, 10000);
        } catch (err: any) {
          if (err?.response?.status === 404) {
            console.error(`✗ Board not found: "${options.board}"`);
          } else {
            logError(err, false);
          }
          process.exit(1);
          return;
        }

        // Build filter expressions from options.
        // --label filters which cards to operate on (by tag).
        // --status and --assignee are TARGET values to SET (not filter conditions).
        const filterExprs: string[] = [];
        if (options.label) filterExprs.push(`tag:${options.label}`);

        const filterFn = buildFilterFn(filterExprs);
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

        // Determine operation type
        const isAssignOnly = options.assignee && !options.status && !options.label;
        let ops;

        if (isAssignOnly) {
          // Batch assign: add assignee to matching cards
          const assignee = options.assignee;
          const toAssign = matchingCards.filter(
            (card) => !(card.assignees ?? []).includes(assignee)
          );
          if (toAssign.length === 0) {
            console.log(`\n⚠  All matching cards already assigned to "${assignee}".`);
            return;
          }
          ops = toAssign.map((card) => ({
            type: 'assign' as const,
            cardId: card.cardId,
            cardName: card.name,
            changes: { assignees: [...(card.assignees ?? []), assignee] },
            previousState: { assignees: card.assignees ?? [] },
            status: 'pending' as const,
          }));
        } else {
          // Batch status update / move
          ops = matchingCards.map((card) => {
            const changes: Record<string, unknown> = {};
            if (options.status) changes.status = options.status;
            return {
              type: 'update' as const,
              cardId: card.cardId,
              cardName: card.name,
              changes,
              previousState: { status: card.status, assignees: card.assignees, boardId: card.boardId },
              status: 'pending' as const,
            };
          });
        }

        if (options.dryRun) {
          const title = `Dry-run preview — update ${ops.length} card(s)`;
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

        const tx = new BulkTransaction(api);
        tx.addAll(ops);

        if (!options.json) {
          console.log(`⚙  Updating ${ops.length} card(s)...`);
        }
        const result = await tx.execute({ verbose: options.verbose });

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(formatBulkSummary(result));
        }

        if (result.failure > 0) process.exit(1);
      } catch (error) {
        logError(error, program.opts().verbose);
        process.exit(1);
      }
      return;
    }

    // ── Single card update ────────────────────────────────────────────────────
    if (!cardId) {
      console.error('Error: provide a card ID, --from-csv <file>, or --board <id> for batch operations');
      process.exit(1);
      return;
    }

    try {
      const updateData: UpdateCardRequest = {};
      if (options.name) updateData.name = options.name;
      if (options.description) updateData.description = options.description.replace(/\\n/g, '\n');
      if (options.status) updateData.status = options.status;
      if (options.assignees) updateData.assignees = options.assignees.split(',');
      if (options.tags) updateData.tags = options.tags.split(',');

      // Parent card
      if (options.parent) updateData.parentCardId = options.parent;

      // Warn if --status looks like a column name (common mistake)
      if (options.status && !options.column) {
        const columnLike = /^(backlog|selected|ready|next|sprint|developing|in.?progress|doing|review|feedback|test|qa|testbar|approved|done|closed|released|archived|godkänd)/i;
        if (columnLike.test(options.status)) {
          console.warn(`⚠  --status sets metadata, not column position. To move this card to the "${options.status}" column, use --column "${options.status}" --board <boardId> instead.`);
        }
      }

      // Column move: resolve column name → columnId
      if (options.column) {
        if (!options.board) {
          console.error('✗ --board is required when using --column');
          process.exit(1);
          return;
        }
        const { ColumnsAPI } = await import('./lib/columns-api');
        const columnsApi = new ColumnsAPI(client!);
        const columns = await columnsApi.listColumns(options.board);
        const target = columns.find(
          c => c.name.toLowerCase() === options.column!.toLowerCase()
        );
        if (!target) {
          const available = columns.map(c => c.name).join(', ');
          console.error(`✗ Column "${options.column}" not found. Available: ${available}`);
          process.exit(1);
          return;
        }
        updateData.columnId = target.columnId;
        updateData.boardId = options.board;
      }

      if (options.dryRun) {
        console.log(`[dry-run] Would update card ${cardId} with:`, JSON.stringify(updateData));
        return;
      }

      const api = new CardsAPI(client!);
      const card = await api.getCard(cardId);

      // --append-description: fetch raw description to preserve Favro's rich text format
      if (options.appendDescription) {
        const appendText = options.appendDescription.replace(/\\n/g, '\n');
        const rawDescription = await api.getRawDescription(cardId);
        updateData.description = rawDescription + appendText;
      }

      const { readConfig } = await import('./lib/config');
      const { checkScope, confirmAction } = await import('./lib/safety');
      await checkScope(card.boardId ?? '', client, await readConfig(), options.force);

      if (!(await confirmAction(`Update card "${card.name}" (${cardId})?`, { yes: options.yes }))) {
        console.log('Aborted.');
        process.exit(0);
      }

      const updatedCard = await api.updateCard(cardId, updateData);
      console.log(`✓ Card updated: ${updatedCard.cardId}`);
      if (options.json) console.log(JSON.stringify(updatedCard));
    } catch (error) {
      logError(error, program.opts().verbose);
      process.exit(1);
    }
  });

// ─── cards export ─────────────────────────────────────────────────────────────
cards
  .command('export <board>')
  .description(
    'Export all cards from a board to JSON or CSV.\n\n' +
    'Examples:\n' +
    '  favro cards export <boardId> --format csv --out sprint.csv\n' +
    '  favro cards export <boardId> --format json --out sprint.json\n' +
    '  favro cards export <boardId> --format json | jq \'.[].name\'\n' +
    '  favro cards export <boardId> --format csv --filter "assignee:alice"\n' +
    '  favro cards export <boardId> --format json --filter "status:Done" --filter "tag:sprint-42"\n\n' +
    'Filter expressions (all conditions must match — AND logic):\n' +
    '  assignee:alice    cards where alice is an assignee\n' +
    '  status:Done       cards with status "Done"\n' +
    '  tag:bug           cards tagged "bug"\n\n' +
    'Handles 10,000+ cards with automatic pagination.'
  )
  .option('--format <format>', 'Export format: json or csv', 'json')
  .option('--out <file>', 'Output file path (defaults to stdout)')
  .option(
    '--filter <expression>',
    'Filter cards (repeatable, e.g. "assignee:alice"). All conditions must match (AND logic)',
    (val: string, prev: string[]) => prev.concat([val]),
    [] as string[]
  )
  .option('--limit <number>', 'Maximum cards to fetch', '10000')
  .action(async (board: string, options) => {
    const format = (options.format ?? 'json').toLowerCase() as ExportFormat;
    if (format !== 'json' && format !== 'csv') {
      console.error(`Error: Invalid format "${options.format}". Use --format json or --format csv`);
      process.exit(1);
    }

    if (options.out) {
      const resolved = path.resolve(options.out);
      const cwd = process.cwd();
      if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
        console.error(`Error: Output path must be within current directory: ${options.out}`);
        process.exit(1);
      }
    }

    const parsedLimit = parseInt(options.limit ?? '10000', 10);
    const limit = !isNaN(parsedLimit) && parsedLimit >= 1 ? parsedLimit : 10000;

    try {
      const client = await createFavroClient();
      const api = new CardsAPI(client);

      const spinner = new (await import('./lib/progress')).Spinner('Fetching cards');
      spinner.start();
      let cardList = await api.listCards(board, limit);
      spinner.stop();

      const filters: string[] = options.filter ?? [];
      if (filters.length > 0) {
        const before = cardList.length;
        cardList = applyFilters(cardList, filters);
        console.error(`\u2139 Filters applied: ${before} \u2192 ${cardList.length} card(s)`);
      }

      if (cardList.length === 0) {
        console.error('\u26a0 No cards to export (0 results after filtering).');
        process.exit(0);
      }

      if (options.out) {
        const progress = new ProgressBar('Exporting cards', cardList.length);
        progress.update(0);
        if (format === 'csv') {
          await writeCardsCSV(cardList, options.out);
        } else {
          await writeCardsJSON(cardList, options.out);
        }
        progress.update(cardList.length);
        progress.done(`Exported ${cardList.length} card(s) to "${options.out}" (${format.toUpperCase()})`);
      } else {
        const normalized = cardList.map(normalizeCard);
        if (format === 'csv') {
          process.stdout.write(cardsToCSV(normalized));
        } else {
          process.stdout.write(JSON.stringify(normalized, null, 2) + '\n');
        }
        console.error(`\u2139 Exported ${cardList.length} card(s) to stdout (${format.toUpperCase()})`);
      }
    } catch (error) {
      logError(error, program.opts().verbose);
      process.exit(1);
    }
  });

  // ─── members commands ────────────────────────────────────────────────────────
  registerMembersCommand(program);

  // ─── comments commands ───────────────────────────────────────────────────────
  registerCommentsCommand(program);

  // ─── activity commands ───────────────────────────────────────────────────────
  registerActivityCommand(program);

  // ─── webhooks commands ───────────────────────────────────────────────────────
  registerWebhooksCommand(program);

  // ─── custom-fields commands ─────────────────────────────────────────────────
  registerCustomFieldsCommands(program);

  // ─── context command ─────────────────────────────────────────────────────────
  registerContextCommand(program);

  // ─── propose command ─────────────────────────────────────────────────────────
  registerProposeCommand(program);

  // ─── execute command ─────────────────────────────────────────────────────────
  registerExecuteCommand(program);

  // ─── query command ───────────────────────────────────────────────────────────
  registerQueryCommand(program);

  // ─── standup command ─────────────────────────────────────────────────────────
  registerStandupCommand(program);

  // ─── sprint-plan command ─────────────────────────────────────────────────────
  registerSprintPlanCommand(program);

  return program;
} // end buildProgram()

// Only run when executed directly (not when imported in tests)
if (require.main === module) {
  const prog = buildProgram();

  // No subcommand given → run persistent interactive menu
  const userArgs = process.argv.slice(2);
  if (userArgs.length === 0) {
    runMainMenu(prog.version() ?? '', () => prog.outputHelp()).then(() => {
      process.exit(0);
    }).catch((err) => {
      logError(err, prog.opts().verbose);
      process.exit(1);
    });
  } else {
    prog.parseAsync(process.argv).catch((err) => {
      logError(err, prog.opts().verbose);
      process.exit(1);
    });
  }
}
