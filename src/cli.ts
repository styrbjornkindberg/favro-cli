#!/usr/bin/env node
/**
 * Favro CLI — Entry Point
 *
 * Usage:
 *   favro auth login                  # set up API key interactively
 *   favro auth check                  # verify API key is valid
 *   favro cards list [--board <id>] [--status <s>] [--assignee <a>] [--limit <n>]
 *   favro cards create <title> [--board <id>] [--status <s>] [--tag <t>] [--assignee <a>]
 *                              [--parent <card>] [--blocked-by <card>] [--blocks <card>]
 *   favro cards create --csv <file> --board <id> [--dry-run]
 *   favro cards update <card> [--name <n>] [--status <s>] [--assignees <a>] [--dry-run]
 *   favro cards export <board> --format json|csv [--out <file>] [--filter <expr>]
 *
 * Config (priority: --api-key flag > FAVRO_API_KEY env > ~/.favro/config.json):
 *   FAVRO_API_KEY    API key (new preferred env var)
 *   FAVRO_API_TOKEN  API key (legacy env var, still supported)
 */

import { Command } from 'commander';
import * as path from 'path';
import CardsAPI, { UpdateCardRequest } from './lib/cards-api';
// The shared dispatch table. Importing it here is what makes the CLI a caller of
// the one table rather than a second, drifting write path — and it registers
// every intent, so intents added by later tickets are reachable with no change.
import { dispatch, DispatchResult } from './lib/dispatch';
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
import { registerCollectionsListCommand } from './commands/collections-list';
import { registerCollectionsGetCommand } from './commands/collections-get';
import { registerCollectionsCreateCommand } from './commands/collections-create';
import { registerCollectionsUpdateCommand } from './commands/collections-update';
import { registerCollectionsDeleteCommand } from './commands/collections-delete';
import { registerCardsGetCommand } from './commands/cards-get';
import { registerCardsFindCommand } from './commands/cards-find';
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
import { registerTrackerInitCommand } from './commands/tracker-init';
import { runMainMenu } from './commands/main-menu';
import { logError } from './lib/error-handler';
import { ProgressBar } from './lib/progress';
import { createFavroClient } from './lib/client-factory';
import { capRows, omitBulk, writeEnvelope } from './lib/read-shape';

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
  .version('2.1.0')
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

// ─── tracker commands ───────────────────────────────────────────────────────
const trackerCmd = program.command('tracker').description('Issue-tracker setup — designate which board is the tracker');
registerTrackerInitCommand(trackerCmd);

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
  '  favro cards get <card> --include board,collection\n' +
  '  favro cards list <board-id> --filter "customField:value"\n' +
  '  favro cards link <card> --to <targetId> --type depends\n' +
  '  favro cards unlink <card> --from <linkedCardId>\n' +
  '  favro cards move <card> --to-board <boardId> --position top\n' +
  '  favro cards create "My card" --board <id>\n' +
  '  favro cards export <id> --format csv --out cards.csv'
);

// ─── cards get ───────────────────────────────────────────────────────────────
registerCardsGetCommand(cards);

// ─── cards find ──────────────────────────────────────────────────────────────
registerCardsFindCommand(cards);

// ─── cards list ──────────────────────────────────────────────────────────────
cards
  .command('list [boardId]')
  .description(
    'List cards from a board with optional filters.\n\n' +
    'Reads live cards only by default (--archived false). The board is always\n' +
    'fetched to completion, filters run over all of it, and --limit caps only\n' +
    'what is printed — a capped list says so with "truncated": true.\n\n' +
    'Card bodies and custom fields are omitted from output by default; --body\n' +
    'and --include custom-fields bring them back.\n\n' +
    'Blocking (Favro says before/after; this CLI says blocks/blocked-by):\n' +
    '  --filter "unblocked"          takeable now — no unfinished blocker,\n' +
    '                                board-agnostic, excludes archived and forks\n' +
    '  --filter "blocked-by:<ref>"   blocked by that specific card\n' +
    '  --filter "blocks:<ref>"       blocking that specific card\n' +
    'A blocker counts as finished when it sits in the tracker board\'s mapped\n' +
    'done column, or is archived off it. A blocker we could not read still\n' +
    'blocks, and says so under "unreachable".\n' +
    'Blockers not already in this board fetch are looked up one call each, capped\n' +
    'at 20 per list (not per card); ids past the cap stay blocked and are named\n' +
    'under "unreachable" as not attempted.\n\n' +
    'Examples:\n' +
    '  favro cards list <board-id>\n' +
    '  favro cards list <board-id> --filter "unblocked" --json\n' +
    '  favro cards list <board-id> --status "In Progress" --limit 100\n' +
    '  favro cards list <board-id> --archived all --json\n' +
    '  favro cards list <board-id> --filter "status:done AND tag:bug" --json\n' +
    '  favro cards list <board-id> --body --include custom-fields --json\n\n' +
    'Tip: Use `favro boards list` to find board IDs.'
  )
  .option('--board <id>', 'Board ID to list cards from (alternative to positional arg)')
  .option('--status <column>', 'Narrow to one column, by name or columnId. Filtered on the wire.')
  .option('--archived <mode>', 'Which cards to read: true, false or all. Filtered on the wire.', 'false')
  .option('--assignee <user>', 'Filter by assignee')
  .option('--tag <tag>', 'Filter by tag')
  .option('--filter <expression>', 'Filter cards using query syntax (e.g. "status:done AND tag:bug")')
  .option('--body', 'Include card descriptions, omitted by default')
  .option('--include <keys>', 'Comma-separated extras to keep in output: custom-fields')
  .option('--limit <number>', 'Cap how many cards are printed (default 25); sets "truncated"', '25')
  .option('--json', 'Output as JSON')
  .action(async (boardId: string | undefined, options) => {
    try {
      const client = await createFavroClient();

      // Support positional boardId or --board option
      const effectiveBoardId = boardId ?? options.board;

      if (!effectiveBoardId) {
        console.error('Error: Board ID is required. Pass as positional argument or use --board <id>');
        process.exit(1);
      }

      const archived = String(options.archived ?? 'false').toLowerCase();
      if (archived !== 'true' && archived !== 'false' && archived !== 'all') {
        console.error(`Error: --archived takes true, false or all — got "${options.archived}"`);
        process.exit(1);
      }

      const include: string[] = options.include
        ? String(options.include).split(',').map((s: string) => s.trim()).filter(Boolean)
        : [];
      const unknownIncludes = include.filter((key) => key !== 'custom-fields');
      if (unknownIncludes.length > 0) {
        console.error(`Error: unknown --include value(s): ${unknownIncludes.join(', ')}. Valid: custom-fields`);
        process.exit(1);
      }

      const parsedLimit = parseInt(options.limit, 10);
      // A pure OUTPUT cap now, so there is nothing to clamp: the fetch runs to
      // completion whatever this says.
      const limit = !isNaN(parsedLimit) && parsedLimit >= 1 ? parsedLimit : 25;

      const api = new CardsAPI(client);

      // The filter is parsed AND its values settled against Favro's own
      // vocabularies BEFORE the fetch — so a typo'd tag or column refuses
      // instead of costing a whole board read and answering a plausible 0 rows.
      let query: import('./lib/query-parser').Query | undefined;
      if (options.filter) {
        const { parseQuery } = await import('./lib/query-parser');
        const { validateQueryValues } = await import('./lib/query-values');
        query = await validateQueryValues(parseQuery(options.filter), {
          client,
          boardId: effectiveBoardId,
        });
      }

      // `--status` and `--archived` are resolved and narrowed on the wire.
      let cardList = await api.listCards({
        boardId: effectiveBoardId,
        status: options.status,
        archived: archived as import('./lib/cards-api').ArchivedSelector,
      });

      // Client-side filters now run over the COMPLETE board, not a truncated page.
      // `unblocked` is the one predicate that cannot be answered from a card
      // alone: whether a blocker is FINISHED lives on the blocker, judged by the
      // tracker's mapped `done` column or by `archived` off it. Blockers already
      // in this fetch cost nothing; the rest go through the bounded sweep, whose
      // holes ride out on `unreachable` rather than passing as "not blocked".
      let unreachable: import('./lib/read-shape').Unreachable[] = [];
      if (query) {
        const { filterCards, queryNames } = await import('./lib/query-parser');
        let ctx: import('./lib/query-parser').EvalContext = {};
        if (queryNames(query, 'unblocked')) {
          const { judgeBlockers } = await import('./lib/blocking');
          const judged = await judgeBlockers(cardList, client);
          ctx = { doneBlockers: judged.done };
          unreachable = judged.unreachable;
        }
        cardList = filterCards(query, cardList, ctx);
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

      // Cap last, and say so.
      const capped = capRows(cardList, limit);

      if (options.json) {
        // Omission is rendering only — `cardList` still holds every field.
        const keep = [
          ...(options.body ? ['description', 'detailedDescription'] : []),
          ...(include.includes('custom-fields') ? ['customFields'] : []),
        ];
        writeEnvelope({
          ...capped,
          rows: omitBulk('card', capped.rows, keep),
          ...(unreachable.length > 0 ? { unreachable } : {}),
        });
      } else {
        console.log(`Found ${capped.rows.length} card(s):`);
        if (capped.rows.length > 0) {
          const rows = capped.rows.map(card => ({
            ID: card.cardId,
            Title: (card.name ?? '').length > 40 ? (card.name ?? '').slice(0, 37) + '...' : (card.name ?? ''),
            Status: card.status ?? '—',
            Assignees: (card.assignees ?? []).join(', ') || '—',
            Tags: (card.tags ?? []).join(', ') || '—',
            Created: card.createdAt ? card.createdAt.slice(0, 10) : '—',
          }));
          console.table(rows);
        }
        if (capped.truncated) {
          console.log(`(truncated to ${limit} of ${cardList.length} — raise --limit to see the rest)`);
        }
        if (unreachable.length > 0) {
          console.log(`(${unreachable.length} blocker(s) could not be checked, so their cards stayed blocked:)`);
          unreachable.forEach((u) => console.log(`  ${u.id} — ${u.reason}`));
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

/**
 * Render one `DispatchResult` for a terminal, and say whether to exit non-zero.
 *
 * Reads the RESULT, never the intent name — so a commander action for an intent
 * registered by a later ticket renders correctly with no change here. A refusal
 * (scope lock, resolver, unknown intent) never arrives as a result: it throws,
 * and each action's catch is where the throw becomes an exit code.
 */
function reportDispatch(result: DispatchResult<unknown>, json?: boolean): boolean {
  if (result.preview) {
    // A preview of the whole chain, and only a preview. The lock, not this flag,
    // is what stopped anything unsafe.
    result.preview.forEach((line) => console.log(`[dry-run] ${line}`));
    return false;
  }
  if (result.outcome === 'ok') return false;

  console.error(`✗ ${result.intent} failed: ${result.error}`);
  if (result.retryable) {
    console.error('  Rolled back — nothing was left behind, so the same call is safe to retry.');
  } else {
    console.error('  Rollback incomplete — do NOT retry. Left behind:');
    for (const orphan of result.orphans ?? []) console.error(`    - ${orphan.reason}`);
  }
  if (json) console.log(JSON.stringify(result));
  return true;
}

// ─── cards create ─────────────────────────────────────────────────────────────
/** Commander reducer for a repeatable flag. */
const collect = (value: string, acc: string[]): string[] => [...acc, value];

cards
  .command('create [title]')
  .description(
    'Create a new card, or bulk-import cards from CSV or JSON.\n\n' +
    'Examples:\n' +
    '  favro cards create "Fix login bug" --board <id>\n' +
    '  favro cards create "My card" --board <id> --status "Todo" --description "Details"\n' +
    '  favro cards create "Ship it" --board <id> --tag bug --assignee alice --parent CLA-1804\n' +
    '  favro cards create "Ship it" --board <id> --blocked-by CLA-1800 --blocks CLA-1900\n' +
    '  favro cards create --csv tasks.csv --board <id>\n' +
    '  favro cards create --bulk tasks.json --board <id>\n' +
    '  favro cards create --csv tasks.csv --board <id> --dry-run\n\n' +
    'CSV format (columns: name, description, status):\n' +
    '  name,description,status\n' +
    '  "Fix bug","Safari issue","In Progress"\n' +
    '  "Add feature","User request","Backlog"\n\n' +
    'Tip: Always test with --dry-run before bulk importing.\n\n' +
    'Composites (--tag/--assignee/--parent/--blocked-by/--blocks/--status) all ride the ONE\n' +
    'create call Favro validates, so a bad value fails the whole create and leaves no card behind.'
  )
  .option('--board <id>', 'Target board ID')
  .option('--description <text>', 'Card description')
  .option('--status <status>', 'Column to create the card in (name needs --board, or a columnId)')
  .option('--tag <name>', 'Tag by name (repeatable) — an unknown name is refused, never created', collect, [])
  .option('--assignee <user>', 'Assignee name, email, userId or @me (repeatable)', collect, [])
  .option('--parent <card>', 'Parent card — sequentialId or cardId, not cardCommonId (same board only)')
  .option('--blocked-by <card>', 'Card that must come before this one — sequentialId or cardId (repeatable)', collect, [])
  .option('--blocks <card>', 'Card this one comes before — sequentialId or cardId (repeatable)', collect, [])
  .option('--bulk <file>', 'Bulk create from JSON file')
  .option('--csv <file>', 'Bulk import from CSV file (columns: name, description, status)')
  .option(
    '--dry-run',
    'Print what would be created without making API calls.\n' +
      '                         Note: for a SINGLE card this still needs credentials — the scope lock runs\n' +
      '                         before the preview, by design, so a preview cannot be a way around it.\n' +
      '                         --csv/--bulk --dry-run read only the file and need none.',
  )
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
      // Through the SHARED dispatch table, never `CardsAPI` directly. The scope
      // lock, the compensation log and the whole-chain `--dry-run` preview all
      // live inside the table, so this commander action and the skill engine
      // cannot drift apart on guardrails.
      //
      // Every composite below rides the ONE POST Favro validates: a bad tag,
      // assignee, column or dependency target 403s the whole create and leaves
      // no card behind.
      const client = await createFavroClient();
      const { readConfig } = await import('./lib/config');
      const result = await dispatch<Card>(
        'create',
        {
          name: title ?? '',
          description: options.description ? options.description.replace(/\\n/g, '\n') : undefined,
          status: options.status,
          board: options.board,
          assignees: options.assignee,
          parent: options.parent,
          tags: options.tag,
          blockedBy: options.blockedBy,
          blocks: options.blocks,
        },
        {
          client,
          config: (await readConfig()) ?? {},
          force: options.force,
          dryRun: options.dryRun,
        },
      );
      // A refusal (scope lock, resolver, unknown intent) never reaches here — it
      // throws, and the catch below is the one place a throw becomes an exit code.
      if (reportDispatch(result, options.json)) process.exit(1);
      if (result.outcome === 'ok' && result.value) {
        // The intent returns the WHOLE card and this projects what it prints, so
        // the `--json` contract (`cardCommonId`, `columnId`, `sequentialId`, …)
        // is whatever `POST /cards` answered — unchanged by going through the table.
        console.log(`✓ Card created: ${result.value.cardId}`);
        if (options.json) console.log(JSON.stringify(result.value));
      }
    } catch (error) {
      logError(error, program.opts().verbose);
      process.exit(1);
    }
  });

// ─── cards update ─────────────────────────────────────────────────────────────
cards
  .command('update [card]')
  .description(
    'Update a card (single) or batch-update/move/assign cards.\n\n' +
    'Single card update:\n' +
    '  favro cards update <card> --status "Done"\n' +
    '  favro cards update <card> --name "New title" --status "In Progress"\n' +
    '  favro cards update <card> --assignees "alice,bob"\n' +
    '  favro cards update <card> --column "Developing" --board <boardId>\n' +
    '  favro cards update <card> --status "Done" --dry-run\n\n' +
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
  .option('--comment <text>', 'Add a comment to the card (non-destructive)')
  .option('--status <status>', 'Move the card to this column (name or columnId)')
  .option('--assignees <list>', 'Assignees, comma-separated — the whole set; drop one to unassign')
  .option('--assignee <user>', 'Assignee for batch assign (use with --board)')
  .option('--tags <list>', 'Tags (comma-separated, single card update)')
  .option('--column <column>', 'Move card to this column by name (use with --board)')
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
          allCards = await api.listCards(options.board);
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
          // Batch assign: add assignee to matching cards. `card.assignees` are
          // userIds and updateCard diffs against them, so the flag value has to
          // be a userId too — a bare name would unassign everyone else.
          const { resolveAssignee } = await import('./lib/assignee');
          const assignee = await resolveAssignee(client!, options.assignee);
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
      // Names must become userIds before the whole-array write is diffed —
      // an unresolved name would read as "remove everyone, add a stranger".
      if (options.assignees) {
        const { resolveAssignees } = await import('./lib/assignee');
        updateData.assignees = await resolveAssignees(
          client!,
          options.assignees.split(',').map((a: string) => a.trim()).filter(Boolean),
        );
      }
      if (options.tags) updateData.tags = options.tags.split(',');

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

      const { readConfig } = await import('./lib/config');
      const { checkScope, confirmAction } = await import('./lib/safety');
      await checkScope(card.boardId ?? '', client, await readConfig(), options.force);

      if (!(await confirmAction(`Update card "${card.name}" (${cardId})?`, { yes: options.yes }))) {
        console.log('Aborted.');
        process.exit(0);
      }

      // --comment: add a comment via the comments API (non-destructive)
      if (options.comment) {
        const commentText = options.comment.replace(/\\n/g, '\n');
        const { CommentsAPI } = await import('./lib/comments-api');
        const commentsApi = new CommentsAPI(client!);
        const cardCommonId = card.cardCommonId ?? cardId;
        await commentsApi.add(cardCommonId, commentText);
        console.log(`✓ Comment added to card "${card.name}"`);
      }

      // Only call updateCard if there are fields to update (not just a comment)
      if (Object.keys(updateData).length > 0) {
        const updatedCard = await api.updateCard(cardId, updateData);
        console.log(`✓ Card updated: ${updatedCard.cardId}`);
        if (options.json) console.log(JSON.stringify(updatedCard));
      } else if (!options.comment) {
        console.log('Nothing to update.');
      }
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
    'Handles 10,000+ cards with automatic pagination. Export is carved out of the\n' +
    'default output omission: it always carries card bodies, whole and unrendered.'
  )
  .option('--format <format>', 'Export format: json or csv', 'json')
  .option('--out <file>', 'Output file path (defaults to stdout)')
  .option(
    '--filter <expression>',
    'Filter cards (repeatable, e.g. "assignee:alice"). All conditions must match (AND logic)',
    (val: string, prev: string[]) => prev.concat([val]),
    [] as string[]
  )
  // No --limit: the board is always fetched to completion. A cap here could only
  // silently export part of a board and call it the export.
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

    try {
      const client = await createFavroClient();
      const api = new CardsAPI(client);

      const spinner = new (await import('./lib/progress')).Spinner('Fetching cards');
      spinner.start();
      let cardList = await api.listCards(board);
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
