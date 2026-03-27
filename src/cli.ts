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
import FavroHttpClient from './lib/http-client';
import { writeCardsCSV, writeCardsJSON, normalizeCard, cardsToCSV } from './lib/csv';
import { parseFilter, applyFilters, ExportFormat } from './commands/cards-export';
import { Card } from './lib/cards-api';
import { registerAuthCommand } from './commands/auth';
import { registerBoardsListCommand } from './commands/boards-list';
import { logError, missingApiKeyError } from './lib/error-handler';
import { ProgressBar } from './lib/progress';

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
  .version('0.1.0')
  .option('--verbose', 'Show stack traces for errors');

// ─── auth commands ────────────────────────────────────────────────────────────
registerAuthCommand(program);

// ─── boards parent ────────────────────────────────────────────────────────────
const boardsCmd = program.command('boards').description('Board operations');

// ─── boards list ─────────────────────────────────────────────────────────────
registerBoardsListCommand(boardsCmd);

// ─── cards parent ────────────────────────────────────────────────────────────
const cards = program.command('cards').description(
  'Card operations — list, create, update, and export cards.\n\n' +
  'Subcommands:\n' +
  '  list    List cards from a board\n' +
  '  create  Create a card (single, bulk JSON, or CSV import)\n' +
  '  update  Update an existing card by ID\n' +
  '  export  Export all cards from a board to JSON or CSV\n\n' +
  'Examples:\n' +
  '  favro cards list --board <id>\n' +
  '  favro cards create "My card" --board <id>\n' +
  '  favro cards create --csv tasks.csv --board <id>\n' +
  '  favro cards update <cardId> --status "Done"\n' +
  '  favro cards export <id> --format csv --out cards.csv'
);

// ─── cards list ──────────────────────────────────────────────────────────────
cards
  .command('list')
  .description(
    'List cards from a board with optional filters.\n\n' +
    'Examples:\n' +
    '  favro cards list --board <id>\n' +
    '  favro cards list --board <id> --status "In Progress" --limit 100\n' +
    '  favro cards list --board <id> --assignee alice --json\n' +
    '  favro cards list --board <id> --tag bug\n\n' +
    'Tip: Use `favro boards list` to find board IDs.'
  )
  .option('--board <id>', 'Board ID to list cards from')
  .option('--status <status>', 'Filter by status')
  .option('--assignee <user>', 'Filter by assignee')
  .option('--tag <tag>', 'Filter by tag')
  .option('--limit <number>', 'Maximum number of cards to return', '50')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const token = process.env.FAVRO_API_TOKEN;
    if (!token) {
      console.error(`Error: ${missingApiKeyError()}`);
      process.exit(1);
    }
    try {
      const client = new FavroHttpClient({ auth: { token } });
      const api = new CardsAPI(client);

      const limit = parseInt(options.limit, 10) || 50;
      let cardList = await api.listCards(options.board, limit);

      if (options.status) {
        cardList = cardList.filter(c => c.status?.toLowerCase() === options.status.toLowerCase());
      }
      if (options.assignee) {
        cardList = cardList.filter(c => (c.assignees || []).some(
          a => a.toLowerCase().includes(options.assignee.toLowerCase())
        ));
      }
      if (options.tag) {
        cardList = cardList.filter(c => (c.tags || []).some(
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
            Title: card.name.length > 40 ? card.name.slice(0, 37) + '...' : card.name,
            Status: card.status || '—',
            Assignees: (card.assignees || []).join(', ') || '—',
            Tags: (card.tags || []).join(', ') || '—',
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
  .command('create <title>')
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
  .option('--bulk <file>', 'Bulk create from JSON file')
  .option('--csv <file>', 'Bulk import from CSV file (columns: name, description, status)')
  .option('--dry-run', 'Print what would be created without making API calls')
  .option('--json', 'Output as JSON')
  .action(async (title: string, options) => {
    const token = process.env.FAVRO_API_TOKEN;
    if (!token) {
      console.error(`Error: ${missingApiKeyError()}`);
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

        const client = new FavroHttpClient({ auth: { token } });
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
        const client = new FavroHttpClient({ auth: { token } });
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

      const client = new FavroHttpClient({ auth: { token } });
      const api = new CardsAPI(client);
      const card = await api.createCard({
        name: title,
        description: options.description,
        status: options.status,
        boardId: options.board,
        assignees: options.assignee ? [options.assignee] : undefined,
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
  .command('update <cardId>')
  .description(
    'Update an existing card by its card ID.\n\n' +
    'Examples:\n' +
    '  favro cards update <cardId> --status "Done"\n' +
    '  favro cards update <cardId> --name "New title" --status "In Progress"\n' +
    '  favro cards update <cardId> --assignees "alice,bob"\n' +
    '  favro cards update <cardId> --tags "bug,sprint-42"\n' +
    '  favro cards update <cardId> --status "Done" --dry-run\n\n' +
    'Tip: Use `favro cards list --json` to find card IDs.'
  )
  .option('--name <name>', 'New card name')
  .option('--description <desc>', 'Card description')
  .option('--status <status>', 'Card status')
  .option('--assignees <list>', 'Assignees (comma-separated)')
  .option('--tags <list>', 'Tags (comma-separated)')
  .option('--dry-run', 'Print what would be updated without making API calls')
  .option('--json', 'Output as JSON')
  .action(async (cardId: string, options) => {
    const token = process.env.FAVRO_API_TOKEN;
    if (!token) {
      console.error(`Error: ${missingApiKeyError()}`);
      process.exit(1);
    }
    try {
      const updateData: UpdateCardRequest = {};
      if (options.name) updateData.name = options.name;
      if (options.description) updateData.description = options.description;
      if (options.status) updateData.status = options.status;
      if (options.assignees) updateData.assignees = options.assignees.split(',');
      if (options.tags) updateData.tags = options.tags.split(',');

      if (options.dryRun) {
        console.log(`[dry-run] Would update card ${cardId} with:`, JSON.stringify(updateData));
        return;
      }

      const client = new FavroHttpClient({ auth: { token } });
      const api = new CardsAPI(client);
      const card = await api.updateCard(cardId, updateData);
      console.log(`✓ Card updated: ${card.cardId}`);
      if (options.json) console.log(JSON.stringify(card));
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
    const token = process.env.FAVRO_API_TOKEN;
    if (!token) {
      console.error(`Error: ${missingApiKeyError()}`);
      process.exit(1);
    }

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
      const client = new FavroHttpClient({ auth: { token } });
      const api = new CardsAPI(client);

      const spinner = new (await import('./lib/progress')).Spinner('Fetching cards');
      spinner.start();
      let cardList = await api.listCards(board, limit);
      spinner.stop();

      const filters: string[] = options.filter ?? [];
      if (filters.length > 0) {
        const before = cardList.length;
        cardList = applyFilters(cardList, filters);
        console.error(`ℹ Filters applied: ${before} → ${cardList.length} card(s)`);
      }

      if (cardList.length === 0) {
        console.error('⚠ No cards to export (0 results after filtering).');
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
        console.error(`ℹ Exported ${cardList.length} card(s) to stdout (${format.toUpperCase()})`);
      }
    } catch (error) {
      logError(error, program.opts().verbose);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  logError(err, program.opts().verbose);
  process.exit(1);
});
