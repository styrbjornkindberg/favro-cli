/**
 * Cards Export Command
 * FAVRO-009: Cards Export Command (JSON, CSV)
 *
 * Usage:
 *   favro cards export <board> --format json --out report.json
 *   favro cards export <board> --format csv --out report.csv
 *   favro cards export <board> --format csv --filter "assignee:alice" --out alice.csv
 *   favro cards export <board> --format csv --filter "status:done OR status:in-progress" --out done.csv
 */
import { Command } from 'commander';
import * as path from 'path';
import CardsAPI, { Card } from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';
import { writeCardsCSV, writeCardsJSON } from '../lib/csv';
import { logError, missingApiKeyError, suggestBoard } from '../lib/error-handler';
import BoardsAPI from '../lib/boards-api';
import { ProgressBar, Spinner } from '../lib/progress';
import { parseQuery, filterCards } from '../lib/query-parser';

export type ExportFormat = 'json' | 'csv';

/**
 * Apply a filter expression to cards using the enhanced query parser.
 * Supports: field:value, AND/OR operators, parentheses, date predicates, relationships, etc.
 * @throws Error if the filter syntax is invalid
 */
export function applyFilter(cards: Card[], filterExpression: string): Card[] {
  try {
    const query = parseQuery(filterExpression);
    return filterCards(query, cards);
  } catch (err: any) {
    console.error(`✗ Invalid filter expression: "${filterExpression}"`);
    console.error(`  Error: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Apply multiple filters to cards using the enhanced query parser.
 * Combines all filters with AND logic (all filters must match).
 * @throws Error if any filter syntax is invalid
 */
export function applyFilters(cards: Card[], filterExpressions: string[]): Card[] {
  if (filterExpressions.length === 0) return cards;
  
  // Combine multiple filter expressions with AND operator
  const combinedFilter = filterExpressions.join(' AND ');
  return applyFilter(cards, combinedFilter);
}

export function registerCardsExportCommand(program: Command): void {
  program
    .command('cards export <board>')
    .description('Export cards from a board to JSON or CSV')
    .option('--format <format>', 'Export format: json or csv', 'json')
    .option('--out <file>', 'Output file path (defaults to stdout)')
    .option('--filter <expression>', 'Filter cards (repeatable, e.g. "assignee:alice"). All conditions must match (AND logic)', (val, prev: string[]) => prev.concat([val]), [] as string[])
    .option('--limit <number>', 'Maximum cards to fetch', '10000')
    .action(async (_exportArg: string, board: string, options: {
      format?: string;
      out?: string;
      filter: string[];
      limit?: string;
    }) => {
      const verbose = program.parent?.opts()?.verbose ?? program.opts()?.verbose ?? false;
      // Check FAVRO_API_TOKEN early
      const token = process.env.FAVRO_API_TOKEN;
      if (!token) {
        console.error(`Error: ${missingApiKeyError()}`);
        process.exit(1);
      }

      // Validate format
      const format = (options.format ?? 'json').toLowerCase() as ExportFormat;
      if (format !== 'json' && format !== 'csv') {
        console.error(`Error: Invalid format "${options.format}". Use --format json or --format csv`);
        process.exit(1);
      }

      // Validate --out path (must be within cwd if specified)
      if (options.out) {
        const resolved = path.resolve(options.out);
        const cwd = process.cwd();
        if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
          console.error(`Error: Output path must be within current directory: ${options.out}`);
          process.exit(1);
        }
      }

      // Validate --limit: treat <= 0 as fallback to 10000
      const parsedLimit = parseInt(options.limit ?? '10000', 10);
      const limit = !isNaN(parsedLimit) && parsedLimit >= 1 ? parsedLimit : 10000;

      try {
        const client = new FavroHttpClient({
          auth: { token },
        });
        const api = new CardsAPI(client);

        // Fetch cards (pagination handled in CardsAPI)
        const spinner = new Spinner('Fetching cards');
        spinner.start();
        let cards = await api.listCards(board, limit);
        spinner.stop();

        // Apply optional filters (AND logic — all must match)
        const filters = options.filter ?? [];
        if (filters.length > 0) {
          const before = cards.length;
          cards = applyFilters(cards, filters);
          console.error(`ℹ Filters applied: ${before} → ${cards.length} card(s)`);
        }

        if (cards.length === 0) {
          console.error('⚠ No cards to export (0 results after filtering).');
          process.exit(0);
        }

        // Write output to file or stdout
        if (options.out) {
          const progress = new ProgressBar('Exporting cards', cards.length);
          progress.update(0);
          if (format === 'csv') {
            await writeCardsCSV(cards, options.out);
          } else {
            await writeCardsJSON(cards, options.out);
          }
          progress.update(cards.length);
          progress.done(`Exported ${cards.length} card(s) to "${options.out}" (${format.toUpperCase()})`);
        } else {
          // Output to stdout
          const { normalizeCard } = await import('../lib/csv');
          const normalized = cards.map(normalizeCard);
          if (format === 'csv') {
            const { cardsToCSV } = await import('../lib/csv');
            process.stdout.write(cardsToCSV(normalized));
          } else {
            process.stdout.write(JSON.stringify(normalized, null, 2) + '\n');
          }
          console.error(`ℹ Exported ${cards.length} card(s) to stdout (${format.toUpperCase()})`);
        }
      } catch (error: any) {
        if (board && error?.response?.status === 404) {
          // Board not found — fetch available boards and suggest
          try {
            const boardsApi = new BoardsAPI(new (await import('../lib/http-client')).default({ auth: { token: token! } }));
            const boards = await boardsApi.listBoards();
            const boardNames = boards.map(b => b.name);
            const helpfulMsg = suggestBoard(board, boardNames);
            console.error(`Error: ${helpfulMsg}`);
          } catch {
            logError(error, verbose);
          }
        } else {
          logError(error, verbose);
        }
        process.exit(1);
      }
    });
}

export default registerCardsExportCommand;
