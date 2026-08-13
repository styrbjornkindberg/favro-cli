#!/usr/bin/env node
/**
 * Favro CLI — Entry Point
 *
 * Usage:
 *   favro auth login                  # set up API key interactively
 *   favro auth check                  # verify API key is valid
 *   favro cards list [--board <board>] [--status <s>] [--assignee <a>] [--limit <n>]
 *   favro cards create <title> [--board <board>] [--status <s>] [--tag <t>] [--assignee <a>]
 *                              [--parent <card>] [--blocked-by <card>] [--blocks <card>]
 *   favro cards create --csv <file> --board <board> [--dry-run]
 *   favro cards update <card> [--name <n>] [--status <s>] [--assignees <a>] [--dry-run]
 *   favro cards export <board> --format json|csv [--out <file>] [--filter <expr>]
 *
 * Config (priority: --api-key flag > FAVRO_API_KEY env > ~/.favro/config.json):
 *   FAVRO_API_KEY    API key (new preferred env var)
 *   FAVRO_API_TOKEN  API key (legacy env var, still supported)
 */

import { Command, CommanderError } from 'commander';
import * as path from 'path';
// The shared dispatch table. Importing it here is what makes the CLI a caller of
// the one table rather than a second, drifting write path — and it registers
// every intent, so intents added by later tickets are reachable with no change.
import { dispatch, UpdateResult } from './lib/dispatch';
import { foldName } from './lib/fold-name';
import { writeCardsCSV, writeCardsJSON, normalizeCard, cardsToCSV } from './lib/csv';
import { applyFilters, ExportFormat } from './lib/cards-export';
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
import { registerRemovedCommands, refusePredicateBatch } from './commands/removed';
import { registerCollectionsListCommand } from './commands/collections-list';
import { registerCollectionsGetCommand } from './commands/collections-get';
import { registerCollectionsCreateCommand } from './commands/collections-create';
import { registerCollectionsUpdateCommand } from './commands/collections-update';
import { registerCollectionsDeleteCommand } from './commands/collections-delete';
import { registerCardsGetCommand } from './commands/cards-get';
import { registerCardsFindCommand } from './commands/cards-find';
import { registerCardsLinkCommands } from './commands/cards-link';
import { registerCardsTrackerCommands } from './commands/cards-tracker';
import { registerCardsDeleteCommand } from './commands/cards-delete';
import { registerCardsArchiveCommands } from './commands/cards-archive';
import { registerIssueTrackerHelp } from './commands/issue-tracker-help';
import { registerCustomFieldsCommands } from './commands/custom-fields';
import { registerMembersCommand } from './commands/members';
import { registerCommentsCommand } from './commands/comments';
import { registerActivityCommand } from './commands/activity';
import { registerWebhooksCommand } from './commands/webhooks';
import { registerContextCommand } from './commands/context';
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
import { logError, latchVerbose } from './lib/error-handler';
import { ProgressBar } from './lib/progress';
import { omitBulk, parseLimit } from './lib/read-shape';
import { RefusalError } from './lib/refusal';
import { Ctx, run } from './lib/run';

/** The flag row `cards export` declares. */
interface CardsExportFlags {
  format?: string;
  out?: string;
  filter?: string[];
}

/** The flag row `cards update` declares. */
interface CardsUpdateFlags {
  name?: string;
  description?: string;
  comment?: string;
  status?: string;
  assignees?: string;
  assignee?: string;
  tags?: string;
  column?: string;
  label?: string;
  board?: string;
  fromCsv?: string;
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
}

/** The flag row `cards create` declares. */
interface CardsCreateFlags {
  board?: string;
  description?: string;
  status?: string;
  tag?: string[];
  assignee?: string[];
  parent?: string;
  blockedBy?: string[];
  blocks?: string[];
  bulk?: string;
  csv?: string;
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
}

/** The flag row `cards list` declares, so the handler's `options` is not `any`. */
interface CardsListFlags {
  board?: string;
  status?: string;
  archived?: string;
  assignee?: string;
  tag?: string;
  filter?: string;
  body?: boolean;
  include?: string;
  limit?: string;
}

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
    '  favro cards list --board <board>  List cards on a board\n' +
    '  favro cards create "My card"      Create a card\n' +
    '  favro cards export <board> --format csv --out cards.csv\n\n' +
    'Working a ticket — claim it, block it, resolve it — or writing an agent\n' +
    'against this CLI? Start with `favro help issue-tracker`.\n\n' +
    'Authentication:\n' +
    '  Set FAVRO_API_KEY env var, or run `favro auth login` to save to ~/.favro/config.json\n\n' +
    'Full docs: https://github.com/square-moon/favro-cli#readme'
  )
  // Read from package.json, never a literal: the hardcoded '2.1.0' here drifted
  // three releases behind the published 2.4.1 before anyone noticed.
  .version(require('../package.json').version as string)
  .option('--verbose', 'Show stack traces for errors')
  // The two flags the command runner owns (ADR-0002, #113/#114). Declared once,
  // on the root, because commander accepts an ancestor's option at any depth —
  // so `favro boards list --human` resolves here rather than needing 128
  // re-declarations. `resolveFormat` reads them with `optsWithGlobals()`.
  .option('--human', 'Human-readable output instead of the default JSON')
  .option('--pretty', 'Indent JSON output (default: compact)');

// Commander's own exits — `--help`, `--version`, a parse error — become throws,
// which is what finally makes the catch at the bottom of this file reachable
// (ADR-0002). It must run BEFORE any `.command()` below: `copyInheritedSettings`
// hands the callback to each subcommand at creation time.
program.exitOverride();

// The flag is declared here and nowhere else, so it is resolved here and
// nowhere else (#85). Without this, `.opts()` being own-options-only left
// `--verbose` dead on every command below the root. See `latchVerbose`.
latchVerbose(program);

// ─── auth commands ────────────────────────────────────────────────────────────
registerAuthCommand(program);

// ─── scope command ────────────────────────────────────────────────────────────
registerScopeCommand(program);

// ─── the tracker contract, as a real --help topic ────────────────────────────
// `favro help issue-tracker`, and `favro issue-tracker --help` for MCP
// `favro_help`, which shells out to `--help` and so never sees a skill file.
registerIssueTrackerHelp(program);

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
registerRemovedCommands(program);

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
  '  delete  Delete ONE board instance of a card (irreversible)\n' +
  '  export  Export all cards from a board to JSON or CSV\n' +
  '  link    Record a blocking edge between two cards\n' +
  '  unlink  Remove the blocking edge between two cards\n' +
  '  move    Move a card to a different board\n' +
  '  claim   Assign yourself and move to the tracker\'s active column\n' +
  '  resolve Move a card to the tracker\'s done column\n' +
  '  retag   Set the triage roles — one category, one state\n\n' +
  'Examples:\n' +
  '  favro cards get <card> --include board,collection\n' +
  '  favro cards list <board> --filter "customField:value"\n' +
  '  favro cards link <card> --to <targetId> --type depends\n' +
  '  favro cards unlink <card> --from <linkedCardId>\n' +
  '  favro cards move <card> --to-board <board> --position top\n' +
  '  favro cards create "My card" --board <board>\n' +
  '  favro cards export <board> --format csv --out cards.csv'
);

// ─── cards get ───────────────────────────────────────────────────────────────
registerCardsGetCommand(cards);

// ─── cards find ──────────────────────────────────────────────────────────────
registerCardsFindCommand(cards);

// ─── cards list ──────────────────────────────────────────────────────────────
cards
  .command('list [board]')
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
    '  favro cards list <board>\n' +
    '  favro cards list <board> --filter "unblocked" --json\n' +
    '  favro cards list <board> --status "In Progress" --limit 100\n' +
    '  favro cards list <board> --archived all --json\n' +
    '  favro cards list <board> --filter "status:done AND tag:bug" --json\n' +
    '  favro cards list <board> --body --include custom-fields --json\n\n' +
    'Tip: The board takes a name or a boardId. Run `favro boards list` to see both.'
  )
  .option('--board <board>', 'Board to list cards from, by name or boardId (alternative to positional arg)')
  .option('--status <column>', 'Narrow to one column, by name or columnId. Filtered on the wire.')
  .option('--archived <mode>', 'Which cards to read: true, false or all. Filtered on the wire.', 'false')
  .option('--assignee <user>', 'Narrow to one assignee — a name, an email, a userId or @me. Same as --filter "assignee:…".')
  .option('--tag <tag>', 'Narrow to one tag, by exact name. Same as --filter "tag:…"; an unknown name is refused.')
  .option('--filter <expression>', 'Filter cards using query syntax (e.g. "status:done AND tag:bug")')
  .option('--body', 'Include card descriptions, omitted by default')
  .option('--include <keys>', 'Comma-separated extras to keep in output: custom-fields')
  .option('--limit <number>', 'Cap how many cards are printed (default 25); sets "truncated"', '25')
  .action(run(async (ctx: Ctx, boardArg: string | undefined, options: CardsListFlags) => {
      const client = ctx.client;

      // Support the positional board or the --board option. Either spelling is
      // a NAME or a boardId; `boardRef` is what was typed, `boardId` below is
      // what it settled to.
      const boardRef = boardArg ?? options.board;

      if (!boardRef) {
        throw new RefusalError('Error: A board is required. Pass it as the positional argument or use --board <board> — a name or a boardId.');
      }

      const archived = String(options.archived ?? 'false').toLowerCase();
      if (archived !== 'true' && archived !== 'false' && archived !== 'all') {
        throw new RefusalError(`Error: --archived takes true, false or all — got "${options.archived}"`);
      }

      const include: string[] = options.include
        ? String(options.include).split(',').map((s: string) => s.trim()).filter(Boolean)
        : [];
      const unknownIncludes = include.filter((key) => key !== 'custom-fields');
      if (unknownIncludes.length > 0) {
        throw new RefusalError(`Error: unknown --include value(s): ${unknownIncludes.join(', ')}. Valid: custom-fields`);
      }

      // Parsed BEFORE the fetch, not left to `capRows` inside the runner: a
      // malformed `--limit` refuses (#142), and a refusal evaluated after the
      // `rows:` are in hand costs a whole board read that is then thrown away.
      // A pure OUTPUT cap either way — there is nothing to clamp.
      const limit = parseLimit(options.limit) ?? 25;

      const api = ctx.api.cards;

      // The board is settled ONCE, here, because two consumers need it and the
      // filter validator runs first: handed a NAME it looks a column up on a
      // board that does not exist and refuses with "No column named done on
      // board Backlog - Web Hub" — the wrong problem, named confidently (#82).
      // `listCards` settles its own board too; an id costs a cache read.
      const boardId = await ctx.api.boards.resolveBoardId(boardRef);

      // The WHOLE filtering flag row — `--filter`, `--tag`, `--assignee` — is
      // parsed AND its values settled against Favro's own vocabularies BEFORE
      // the fetch, so a typo'd tag, user or column refuses instead of costing a
      // whole board read and answering a plausible 0 rows. `--tag`/`--assignee`
      // are the flag spelling of `tag:`/`assignee:` and take the same call
      // rather than a filter of their own (#84).
      const { resolveCardFilter } = await import('./lib/query-values');
      const query = await resolveCardFilter(
        { filter: options.filter, tag: options.tag, assignee: options.assignee },
        { client, boardId }
      );

      // `--status` and `--archived` are resolved and narrowed on the wire.
      let cardList = await api.listCards({
        boardId,
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
        // Named `evalCtx`, not `ctx`: the handler's own `ctx` is the runner's.
        let evalCtx: import('./lib/query-parser').EvalContext = {};
        if (queryNames(query, 'unblocked')) {
          const { judgeBlockers } = await import('./lib/blocking');
          const judged = await judgeBlockers(cardList, client);
          evalCtx = { doneBlockers: judged.done };
          unreachable = judged.unreachable;
        }
        cardList = filterCards(query, cardList, evalCtx);
      }

      // Omission is rendering only — the read returned every field, and this
      // projects what is PRINTED. Applied to the whole list rather than to a
      // capped slice because the cap is the runner's now (`capRows`), and both
      // orders render the same rows.
      const keep = [
        ...(options.body ? ['description', 'detailedDescription'] : []),
        ...(include.includes('custom-fields') ? ['customFields'] : []),
      ];

      return {
        rows: omitBulk('card', cardList, keep),
        limit,
        // The holes ride out on the envelope rather than passing as "not
        // blocked". `unreachable` is the runner's third envelope key since
        // #119; before that this action wrote the envelope itself, which is
        // why it was the only list read that could carry one.
        ...(unreachable.length > 0 ? { unreachable } : {}),
        human: (rows: Card[]) => {
          console.log(`Found ${rows.length} card(s):`);
          if (rows.length > 0) {
            console.table(rows.map(card => ({
              ID: card.cardId,
              Title: (card.name ?? '').length > 40 ? (card.name ?? '').slice(0, 37) + '...' : (card.name ?? ''),
              Status: card.status ?? '—',
              Assignees: (card.assignees ?? []).join(', ') || '—',
              Tags: (card.tags ?? []).join(', ') || '—',
              Created: card.createdAt ? card.createdAt.slice(0, 10) : '—',
            })));
          }
        },
      };
  }));

// ─── cards link / unlink / move ──────────────────────────────────────────────
registerCardsLinkCommands(cards);

// ─── cards claim / resolve / retag ───────────────────────────────────────────
registerCardsTrackerCommands(cards);

// ─── cards delete ────────────────────────────────────────────────────────────
registerCardsDeleteCommand(cards);

// ─── cards archive / unarchive ───────────────────────────────────────────────
registerCardsArchiveCommands(cards);

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
/** Commander reducer for a repeatable flag. */
const collect = (value: string, acc: string[]): string[] => [...acc, value];

cards
  .command('create [title]')
  .description(
    'Create a new card, or bulk-import cards from CSV or JSON.\n\n' +
    'Examples:\n' +
    '  favro cards create "Fix login bug" --board <board>\n' +
    '  favro cards create "My card" --board <board> --status "Todo" --description "Details"\n' +
    '  favro cards create "Ship it" --board <board> --tag bug --assignee alice --parent CLA-1804\n' +
    '  favro cards create "Ship it" --board <board> --blocked-by CLA-1800 --blocks CLA-1900\n' +
    '  favro cards create --csv tasks.csv --board <board>\n' +
    '  favro cards create --bulk tasks.json --board <board>\n' +
    '  favro cards create --csv tasks.csv --board <board> --dry-run\n\n' +
    'CSV format (columns: name, description, status):\n' +
    '  name,description,status\n' +
    '  "Fix bug","Safari issue","In Progress"\n' +
    '  "Add feature","User request","Backlog"\n\n' +
    'Tip: Always test with --dry-run before bulk importing.\n\n' +
    '--csv/--bulk create an ENUMERATED list of at most 20 cards as ONE transaction: a failure\n' +
    'part-way through rolls the whole batch back. A longer list is refused, not truncated.\n\n' +
    'Composites (--tag/--assignee/--parent/--blocked-by/--blocks/--status) all ride the ONE\n' +
    'create call Favro validates, so a bad value fails the whole create and leaves no card behind.'
  )
  .option('--board <board>', 'Target board, by name or boardId')
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
      '                         --csv/--bulk go through the same table, so they need credentials too.',
  )
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--force', 'Bypass scope check')
  // On intent-carrying commands only. A pointer on every command would be noise
  // an agent learns to skip.
  .addHelpText('after', '\nIntent contract: run `favro help issue-tracker`.')
  .action(run(async (ctx: Ctx, title: string | undefined, options: CardsCreateFlags) => {
    if (!title && !options.csv && !options.bulk) {
      // A `RefusalError`, so the runner owns the stream and the code. It was
      // OUTSIDE the try before, so under the JSON default `console.error` plus a
      // return would have been exit 0 with an empty stdout.
      throw new RefusalError('Error: provide a title or use --csv/--bulk for bulk import');
    }
      const fs = await import('fs/promises');

      // ── Multi-create: CSV or JSON, one bounded transaction ──────────────────
      // An ENUMERATED list — the file names every card — dispatched as ONE
      // `create` invocation, which loops `txCards.create` so every card made
      // carries its own undo handle. A failure part-way through unwinds the
      // whole batch, LIFO, and reports `rolled-back`. There is no bulk route to
      // reach for: `POST /cards/bulk` does not exist (200 + HTML), and a
      // half-successful bulk would give no per-card undo handle at all.
      if (options.csv || options.bulk) {
        const source = (options.csv ?? options.bulk)!;
        const raw = await fs.readFile(source, 'utf-8');
        const entries: Array<Record<string, any>> = options.csv
          ? parseCSV(raw)
          : (() => { const d = JSON.parse(raw); return Array.isArray(d) ? d : [d]; })();

        // A CSV cell is always a string, a JSON field may already be an array —
        // and `tags: "bug"` reaching the intent as a string would be resolved
        // character by character. One coercion, both sources.
        const list = (v: unknown): string[] | undefined => {
          if (Array.isArray(v)) return v.map(String);
          if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean);
          return undefined;
        };
        const cards = entries
          .map((row) => ({
            name: row.name || row.title || row.Name || row.Title || '',
            description: row.description || row.Description || undefined,
            status: row.status || row.Status || undefined,
            board: row.board || row.boardId || options.board,
            tags: list(row.tags),
            assignees: list(row.assignees),
            // `||`, not `??`, exactly like every sibling: `parseCSV` gives every
            // declared header a key, `''` when the cell is blank, and `''` would
            // reach the wire as `parentCardId: ""` and 403 the whole atomic batch.
            parent: row.parent || row.parentCardId || undefined,
            blockedBy: list(row.blockedBy),
            blocks: list(row.blocks),
          }))
          .filter((c) => c.name);

        if (cards.length === 0) {
          throw new RefusalError(`Error: ${source} has no rows with a name`);
        }

        const result = await dispatch<Card[]>('create', { cards }, {
          client: ctx.client,
          config: ctx.config,
          force: options.force,
          dryRun: options.dryRun,
        });
        return {
          dispatch: result,
          human: (value: Card[]) => `✓ Created ${value.length} cards`,
        };
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
          client: ctx.client,
          config: ctx.config,
          force: options.force,
          dryRun: options.dryRun,
        },
      );
      // A refusal (scope lock, resolver, unknown intent) never reaches here — it
      // throws, and the runner's boundary is the one place a throw becomes an
      // exit code.
      return {
        dispatch: result,
        // The intent returns the WHOLE card and the runner emits it, so the
        // machine contract (`cardCommonId`, `columnId`, `sequentialId`, …) is
        // whatever `POST /cards` answered — unchanged by going through the
        // table. The ✓ is the HUMAN line: it used to print to stdout ahead of
        // that payload, which is what stopped the documented default parsing.
        human: (value: Card) => `✓ Card created: ${value.cardId}`,
      };
  }));

// ─── cards update ─────────────────────────────────────────────────────────────
cards
  .command('update [card]')
  .description(
    'Update one card, or an enumerated batch of at most 20 from a CSV file.\n\n' +
    'Single card update:\n' +
    '  favro cards update <card> --status "Done"\n' +
    '  favro cards update <card> --name "New title" --status "In Progress"\n' +
    '  favro cards update <card> --assignees "alice,bob"\n' +
    '  favro cards update <card> --column "Developing"\n' +
    '  favro cards update <card> --status "Done" --dry-run\n\n' +
    '  Routed through the shared dispatch table, so each field is written through\n' +
    '  its own primitive and carries its own compensating write: a failure on the\n' +
    '  third field unwinds the first two. The scope lock runs BEFORE the --dry-run\n' +
    '  preview, so a preview is never a way around it.\n\n' +
    'Batch update from CSV:\n' +
    '  favro cards update --from-csv bulk.csv\n' +
    '  favro cards update --from-csv bulk.csv --dry-run\n\n' +
    '  CSV columns: card_id (required), status, owner, due_date. cardId, assignee\n' +
    '  and dueDate are accepted as aliases; any OTHER column refuses, because the\n' +
    '  parser this replaced accepted custom_field_* and silently wrote none of it.\n' +
    '  The whole file is ONE transaction, capped at 20 rows: a failure on row 12\n' +
    '  unwinds rows 1-11 rather than leaving them standing.\n\n' +
    'Removed in 4.0 — the predicate batch (`--board` with no card):\n' +
    '  Enumerate first with `favro cards list --filter …`, then --from-csv.\n\n' +
    'Tip: Use `favro cards list --json` to find card IDs.'
  )
  .option('--name <name>', 'New card name (single card update)')
  .option('--description <desc>', 'Card description (single card update)')
  .option('--comment <text>', 'Add a comment to the card (non-destructive)')
  .option('--status <status>', 'Move the card to this column (name or columnId)')
  .option('--assignees <list>', 'Assignees, comma-separated — the whole set; drop one to unassign')
  // Still declared so the removed predicate batch reaches a refusal that names
  // its replacement, rather than commander's "unknown option".
  .option('--assignee <user>', 'Removed in 4.0 — see --from-csv')
  .option('--tags <list>', 'Tags (comma-separated, single card update)')
  .option('--column <column>', 'Move card to this column by name — a second spelling of --status')
  .option('--label <label>', 'Removed in 4.0 — see --from-csv')
  .option('--board <board>', 'Removed in 4.0 as a batch selector; ignored on a single card update')
  .option('--from-csv <file>', 'CSV file with card updates (columns: card_id, status, owner, due_date)')
  .option('--dry-run', 'Preview changes without writing — with --from-csv under a scope lock this still reads each row\'s card, because the lock runs before the preview, by design, so a preview cannot be a way around it')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--force', 'Bypass scope check')
  // The removed `--board` predicate batch is refused ABOVE the runner, not
  // inside the handler, and that placement is load-bearing: `run()` resolves the
  // credential BEFORE it calls the handler, so a refusal written inside answers
  // "API key not found" to a user who has none — a refusal naming the wrong
  // problem, on the one input whose whole job is to name the right one.
  //
  // A DERIVED write set — "every card on this board matching this label" — is
  // the shape #92 retired along with `batch move` and `batch assign`. The
  // command read the board, decided the set itself, and wrote to whatever came
  // back, so what it wrote to was never in the invocation and never in any
  // record. `--from-csv` is the same job with the set enumerated by the caller.
  //
  // Registered rather than removed: an agent that hits "unknown option" has
  // nothing to recover with, and this one is a FLAG COMBINATION, so commander
  // could not have refused it by name at all.
  //
  // `refusePredicateBatch` is `run({ anonymous: true })`, so it builds no client
  // and still writes through the same boundary — the envelope on stdout under
  // the JSON default, `✗ Error: …` on stderr under `--human`. The `command` is
  // passed so the runner resolves `--human` from the real invocation. The other
  // five removed spellings refuse through that same boundary.
  .action((cardId: string | undefined, options: CardsUpdateFlags, command: Command) =>
    options.board && !cardId
      ? refusePredicateBatch(command)
      : updateCard(cardId, options, command));

const updateCard = run(async (
  ctx: Ctx,
  cardId: string | undefined,
  options: CardsUpdateFlags,
  // Declared, never read: commander appends the `Command` to every action's
  // arguments and `run()`'s `commandFrom` detects it by shape at the END of the
  // list, so the handler's own arity has to leave room for it.
  _command: Command,
) => {

    // ── CSV batch update ──────────────────────────────────────────────────────
    if (options.fromCsv) {
      if (!options.dryRun) {
        const { confirmAction } = await import('./lib/safety');
        if (!(await confirmAction('Apply these bulk updates to cards from CSV?', { yes: options.yes }))) {
          return { item: { updated: 0, aborted: true }, human: () => 'Aborted.' };
        }
      }

      {
        const fs = await import('fs/promises');
        const { parseCSVContent } = await import('./lib/csv');

        let content: string;
        try {
          content = await fs.readFile(options.fromCsv, 'utf-8');
        } catch (err: any) {
          throw new RefusalError(`✗ Cannot read CSV file "${options.fromCsv}": ${err.message}`);
        }

        const { rows, errors: parseErrors } = parseCSVContent(content);

        if (parseErrors.length > 0) {
          // ONE refusal carrying every row, rather than N `console.error` lines
          // and a hard exit: the runner writes it to stdout as an envelope under
          // the machine default, and a per-line print would have put the reasons
          // on stderr with nothing parseable beside them.
          throw new RefusalError(
            ['✗ CSV validation errors:', ...parseErrors.map((e) => `  Row ${e.row}: [${e.field}] ${e.message}`)].join('\n'),
          );
        }

        if (rows.length === 0) {
          throw new RefusalError('✗ CSV file has no valid data rows');
        }

        // One `update` invocation over the whole file, which is what #110 bought
        // by deleting `BulkTransaction`. The rows are an ENUMERATED batch, so the
        // intent owns everything this branch used to hand-roll: the scope lock on
        // every distinct board before the first write, the whole-batch refusal
        // when one row straddles it, the 20-row cap, and — the part the old
        // transaction could not do — a compensating write per FIELD, so a failure
        // on row 12 unwinds rows 1-11 and reports `rolled-back` instead of
        // best-effort PUTting the old values back.
        //
        // A row naming nothing but `card_id` now REFUSES rather than being a
        // silent no-op success: see `updateEntries` for why a skipped entry
        // inside a batch is the wrong answer.
        const cards = rows.map((row) => ({
          card: row.card_id,
          ...(row.status ? { status: row.status } : {}),
          // Whole-array semantics, unchanged: the `owner` cell is the assignee
          // list the card ends with. A display name is settled to a `userId`
          // inside the intent.
          ...(row.owner ? { assignees: [row.owner] } : {}),
          // Only a NON-EMPTY cell: `setDueDate` refuses `""` because
          // `PUT {dueDate: ""}` is a measured silent no-op (#106), so an empty
          // column has to mean "leave it alone" rather than "clear it".
          ...(row.due_date ? { dueDate: row.due_date } : {}),
        }));

        // With nothing locked there is no lock to take and no board to resolve,
        // so the preview is rendered from the intent's own pure `preview()` and
        // costs zero requests — the #102/#104 price for an unlocked path, and
        // what this branch already had. Under a lock it dispatches instead, so
        // the table takes the lock BEFORE it previews (#103/#155).
        //
        // `previewOnly` writes for itself, so this is the `void` streaming arm.
        if (options.dryRun && !ctx.config.scopeCollectionId) {
          const { previewOnly } = await import('./lib/report-dispatch');
          previewOnly('update', { cards }, ctx.config);
          return;
        }

        const result = await dispatch<UpdateResult[]>(
          'update',
          { cards },
          { client: ctx.client, config: ctx.config, force: options.force, dryRun: options.dryRun },
        );
        // CLOSES THE OPEN EDGE #110 RECORDED. Both the report and the payload
        // keyed on the LEAF `--json` flag, so this branch defaulted to HUMAN
        // while the refusal at the top of the same action obeyed ADR-0002's
        // default of JSON with `--human` opting out — one action, two output
        // defaults, depending on which branch you hit. The runner owns both now,
        // and the leaf flag is gone.
        return {
          dispatch: result,
          human: (value: UpdateResult[]) =>
            [
              `✓ ${value.length} card(s) updated`,
              ...value.map((one) => `  ${one.cardId} (${one.wrote.join(', ')})`),
            ].join('\n'),
        };
      }
    // (end of fromCsv path)
    }

    // ── Single card update ────────────────────────────────────────────────────
    if (!cardId) {
      throw new RefusalError('Error: provide a card ID, --from-csv <file>, or --board <board> for batch operations');
    }

    {
      // `--column` is a second SPELLING of `--status`, not a second field: both
      // mean "put the card in this column", and the `update` intent resolves the
      // name through `TxCards.moveColumn`, against the card's OWN board. So
      // `--board` is no longer consulted here, and no longer required — it existed
      // to disambiguate the column name, which the card's own board now does.
      //
      // What that gives up, stated rather than hidden: a name that is not a column
      // of the card's board now REFUSES by name (`ColumnResolutionError`, listing
      // that board's real columns) instead of PUTting `{columnId, boardId}` — a
      // combined cross-board move nothing has measured, and one with no
      // compensating write, since moving a card back across boards is not the
      // inverse of moving it back across columns.
      if (options.status && options.column && foldName(options.status) !== foldName(options.column)) {
        throw new RefusalError(
          `✗ --status "${options.status}" and --column "${options.column}" name different columns. ` +
            `They are two spellings of one field — pass one of them.`,
        );
      }
      // Trimmed, which `--tags` was not. The reason is narrower than it looks, and
      // was overstated here before a mutation run checked it: every downstream
      // resolver already trims — `tags-api.ts` trims its key before `foldName`,
      // `hasIdShape` trims before matching, `resolveAssignee` trims its value — so
      // a spaced-but-nonempty ` bug ` resolved correctly all along. Deleting this
      // `.map(trim)` leaves the whole suite green for exactly that reason.
      //
      // What it does buy: an entry that is nothing but spaces. `filter(Boolean)`
      // keeps `' '`, because a space is truthy, and a blank tag NAME on a write is
      // an unknown name, which is a tag CREATION. The trim turns it into `''` so it
      // drops. Pinned in `cards-update-intent-wire.test.ts`.
      const csv = (list: string): string[] =>
        list.split(',').map((v: string) => v.trim()).filter(Boolean);
      const args = {
        card: cardId,
        ...(options.name !== undefined ? { name: options.name } : {}),
        ...(options.description !== undefined
          ? { description: options.description.replace(/\\n/g, '\n') }
          : {}),
        ...(options.status || options.column ? { status: options.status ?? options.column } : {}),
        ...(options.tags ? { tags: csv(options.tags) } : {}),
        // Names are resolved to userIds INSIDE the intent now, so the skill engine
        // and the MCP passthrough get the resolution this flag used to keep to
        // itself. `setAssignees` refuses anything that is not a userId.
        ...(options.assignees ? { assignees: csv(options.assignees) } : {}),
      };
      const hasFields = Object.keys(args).length > 1;

      const card = await ctx.api.cards.getCard(cardId);

      const { checkScope, confirmAction } = await import('./lib/safety');
      const config = ctx.config;
      // HOISTED ABOVE THE PREVIEW (#108). This check used to sit below the
      // `--dry-run` return, so under a scope lock a dry run cheerfully previewed a
      // write the real run refuses — misinformation in the one flag a careful
      // caller reaches for FIRST. The `--from-csv` path (#103) and the `--board`
      // predicate path already ordered it this way; the single-card path was the
      // straggler. It costs one `GET /cards/<id>` on a dry run that used to make
      // none, which is what an opted-into preview buys.
      await checkScope(card.boardId ?? '', ctx.client, config, options.force);

      if (
        !options.dryRun &&
        !(await confirmAction(`Update card "${card.name}" (${cardId})?`, { yes: options.yes }))
      ) {
        return { item: { updated: false, aborted: true, card: cardId }, human: () => 'Aborted.' };
      }

      // --comment: add a comment via the comments API (non-destructive).
      // The client owns the `cardId` → `cardCommonId` translation the endpoint
      // needs (#89) — resolving it here would be the second implementation.
      // It costs one redundant `GET /cards/<id>`: `card.cardCommonId` is already
      // in hand from the read above, but passing it would be that second
      // implementation again. One call is the price of one resolver.
      //
      // Outside the dispatch table on purpose: a comment has no compensating
      // write, so it is not an intent and cannot join the transaction. The lock
      // above is therefore the only one guarding it, which is why that check is
      // NOT skipped when there are no fields to dispatch.
      let commented = false;
      if (options.comment) {
        const commentText = options.comment.replace(/\\n/g, '\n');
        if (options.dryRun) {
          console.log(`[dry-run] add a comment to card ${cardId} (${commentText.length} characters)`);
        } else {
          await ctx.api.comments.addComment(cardId, commentText);
          commented = true;
        }
      }

      // The field writes go through the ONE dispatch table, so they inherit the
      // mandatory scope lock, the boardless-write refusal and — the part this path
      // never had — a compensation log. A failure on the third field unwinds the
      // first two and reports `rolled-back`.
      if (hasFields) {
        const result = await dispatch<UpdateResult>('update', args, {
          client: ctx.client,
          config,
          force: options.force,
          dryRun: options.dryRun,
        });
        return {
          dispatch: result,
          human: (value: UpdateResult) => {
            // The comment write has no dispatch of its own — it is not an intent
            // — so its ✓ rides here rather than printing above the payload.
            if (commented) console.log(`✓ Comment added to card "${card.name}"`);
            return `✓ Card updated: ${value.cardId} (${value.wrote.join(', ')})`;
          },
        };
      }
      if (options.comment) {
        return {
          item: { card: cardId, commented, wrote: [] as string[] },
          human: () => (commented ? `✓ Comment added to card "${card.name}"` : undefined),
        };
      }
      return { item: { card: cardId, wrote: [] as string[] }, human: () => 'Nothing to update.' };
    }
});

// ─── cards export ─────────────────────────────────────────────────────────────
cards
  .command('export <board>')
  .description(
    'Export all cards from a board to JSON or CSV.\n\n' +
    'Examples:\n' +
    '  favro cards export <board> --format csv --out sprint.csv\n' +
    '  favro cards export <board> --format json --out sprint.json\n' +
    '  favro cards export <board> --format json | jq \'.[].name\'\n' +
    '  favro cards export <board> --format csv --filter "assignee:alice"\n' +
    '  favro cards export <board> --format json --filter "status:Done" --filter "tag:sprint-42"\n\n' +
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
  // `cards export` returns `void` — the STREAMING arm, deliberately (ADR-0002).
  // `--format json|csv` survives here where it was deleted from `webhooks`,
  // `collections list` and `activity`, because CSV is a serialization axis
  // rather than a view of the envelope: this command writes its own file, or
  // its own bytes to stdout, and there is no envelope for `--human` to opt out
  // of. What it DOES gain is the runner's error boundary — a refusal is now an
  // envelope on stdout at exit 1 instead of a stderr line with stdout empty.
  .action(run(async (ctx: Ctx, board: string, options: CardsExportFlags) => {
    const format = (options.format ?? 'json').toLowerCase() as ExportFormat;
    if (format !== 'json' && format !== 'csv') {
      throw new RefusalError(`Error: Invalid format "${options.format}". Use --format json or --format csv`);
    }

    if (options.out) {
      const resolved = path.resolve(options.out);
      const cwd = process.cwd();
      if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
        throw new RefusalError(`Error: Output path must be within current directory: ${options.out}`);
      }
    }

    {
      const client = ctx.client;
      const api = ctx.api.cards;

      // The whole protocol `cards list` runs \u2014 parse AND settle the values \u2014 so
      // a typo'd tag or column refuses instead of exporting zero rows (#83), and
      // settled BEFORE the fetch, where `cards list` settles it. A refusal needs
      // no board data: paging the board first spends the most expensive read
      // this CLI makes on nothing, and when that read is what fails the user
      // gets a 403 where `cards list` names the typo.
      // ponytail: costs a second `resolveQuery` below, served from the name
      // cache. Thread one query through if it ever shows up in a profile.
      const filters: string[] = options.filter ?? [];
      if (filters.length > 0) await applyFilters([], filters, { client, boardId: board });

      const spinner = new (await import('./lib/progress')).Spinner('Fetching cards');
      spinner.start();
      // `finally`, because `Spinner.start` uses an `unref`'d `setInterval` that
      // only `stop()` clears: a throwing `listCards` skipped it, and the frames
      // then drew over the very error message the `catch` below prints, until
      // the process exited. Under test `process.exit` is stubbed, so the
      // interval instead survived for the rest of the Jest worker's life and
      // scribbled across later suites' output — the stderr half of #97's leak.
      // Annotated: `let cardList;` is an implicit `any`, and every use below it
      // — `.length`, `applyFilters`, `.map(normalizeCard)` — then stops being
      // checked. The old `let cardList = await …` was typed by inference.
      let cardList: Card[];
      try {
        cardList = await api.listCards(board);
      } finally {
        spinner.stop();
      }

      if (filters.length > 0) {
        const before = cardList.length;
        cardList = await applyFilters(cardList, filters, { client, boardId: board });
        console.error(`\u2139 Filters applied: ${before} \u2192 ${cardList.length} card(s)`);
      }

      if (cardList.length === 0) {
        // Exit 0 — an empty board is not a failure, and it never was. It used to
        // be a hard exit with code 0; under `run()` that is the code nobody
        // sets. The notice stays on stderr, where the export's own bytes are not.
        console.error('\u26a0 No cards to export (0 results after filtering).');
        return;
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
    }
  }));

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

  // ─── query command ───────────────────────────────────────────────────────────
  registerQueryCommand(program);

  // ─── standup command ─────────────────────────────────────────────────────────
  registerStandupCommand(program);

  // ─── sprint-plan command ─────────────────────────────────────────────────────
  registerSprintPlanCommand(program);

  return program;
} // end buildProgram()

/**
 * The last error boundary: anything `run()` did not already catch.
 *
 * EXPORTED, and that is the whole reason it exists as a function. The `.catch`
 * it replaces lived inside `if (require.main === module)`, which Jest never
 * executes — every test drives `buildProgram().parseAsync(…)` — so the arm had
 * no reachable call site and had never run. `cli-top-level-catch.test.ts` calls
 * this directly.
 *
 * `.exitOverride()` routes `--help`, `--version` and parse errors here as
 * `CommanderError`. Commander has already written its own output, so the only
 * thing left is the code it asked for — logging it again would put
 * "✗ Error: (outputHelp)" under every `--help`.
 *
 * `process.exitCode`, never a hard exit: ADR-0002's rule, and this file is
 * scanned for the spelling (#133). `logError` takes no second argument — it
 * reads `isVerbose()`, which is #85's single spelling; passing
 * `prog.opts().verbose` here would be a second one.
 *
 * WHAT IT IS AND IS NOT REACHABLE FROM, measured rather than claimed: `run()`
 * catches everything an action can throw, so no ordinary command path arrives
 * here. What does is commander itself — an unknown command, a missing required
 * option, `--help`, `--version` — all `CommanderError`, which is the first arm.
 * The second arm's live sources are the root `preAction` hook (`latchVerbose`)
 * and `commandFrom`/`resolveFormat` inside `run.ts`; no input was found that
 * reaches it, so the test drives it with a constructed error rather than
 * claiming a command that does.
 */
export function reportUncaught(err: unknown): void {
  if (err instanceof CommanderError) {
    process.exitCode = err.exitCode;
    return;
  }
  logError(err);
  process.exitCode = 1;
}

// Only run when executed directly (not when imported in tests)
if (require.main === module) {
  const prog = buildProgram();

  // No subcommand given → run persistent interactive menu
  const userArgs = process.argv.slice(2);
  if (userArgs.length === 0) {
    // `runMainMenu` is `run(handler)` (#118): it owns the error boundary and
    // the exit code, and it never rejects — so there is nothing to `.catch`,
    // and no hard exit to make. The menu releases stdin on the way
    // out and node leaves once the event loop drains, after stdout flushes.
    void runMainMenu(prog.version() ?? '', prog);
  } else {
    prog.parseAsync(process.argv).catch(reportUncaught);
  }
}
