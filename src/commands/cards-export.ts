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
import { createFavroClient } from '../lib/client-factory';
import * as path from 'path';
import CardsAPI, { Card } from '../lib/cards-api';
import { writeCardsCSV, writeCardsJSON } from '../lib/csv';
import { logError, missingApiKeyError, suggestBoard } from '../lib/error-handler';
import BoardsAPI from '../lib/boards-api';
import { ProgressBar, Spinner } from '../lib/progress';
import { filterCards, queryNames, ParseError } from '../lib/query-parser';
import { resolveQuery, ValueContext } from '../lib/query-values';

export type ExportFormat = 'json' | 'csv';

/**
 * Apply a filter expression to cards.
 *
 * Fails closed on the WHOLE grammar, not half of it (#83): the expression goes
 * through `resolveQuery`, so an unknown field, an unparseable token, a tag
 * outside the org vocabulary and a column the board does not have all refuse
 * with the same `ParseError` `cards list` raises. It used to run the parse step
 * alone, which checks field names and nothing else — `--filter "tag:typoo"`
 * then exported zero rows and called it the export.
 *
 * `ctx` is required, not optional: a caller with no client would silently be
 * back to the half-protocol, which is the bug this signature exists to prevent.
 *
 * @throws ParseError on any refusal — the caller lets it reach `logError`, so
 *         the wording and the structured `detail` match `cards list` exactly.
 */
export async function applyFilter(
  cards: Card[],
  filterExpression: string,
  ctx: ValueContext,
): Promise<Card[]> {
  const query = await resolveQuery(filterExpression, ctx);

  // `unblocked` is refused here rather than answered wrong (#47). Judging whether
  // a blocker is FINISHED takes extra reads, and an export writes a file — it is
  // carved out of the envelope contract, so it has no `unreachable` to report the
  // blockers it could not check. Answering anyway would silently drop every card
  // that has any edge at all.
  if (queryNames(query, 'unblocked')) {
    throw new ParseError(
      `"unblocked" is not available on export: it has to judge each blocker, and an ` +
        `export has no way to tell you which ones it could not reach. ` +
        `Ask the frontier instead: favro cards list <board> --filter "unblocked"`,
      { kind: 'unsupported-here', field: 'unblocked', value: 'unblocked' },
    );
  }

  return filterCards(query, cards);
}

/**
 * Apply multiple filters to cards using the enhanced query parser.
 * Combines all filters with AND logic (all filters must match).
 * @throws ParseError if any filter names or values are outside the vocabulary
 */
export async function applyFilters(
  cards: Card[],
  filterExpressions: string[],
  ctx: ValueContext,
): Promise<Card[]> {
  if (filterExpressions.length === 0) return cards;

  // Combine multiple filter expressions with AND operator
  const combinedFilter = filterExpressions.join(' AND ');
  return applyFilter(cards, combinedFilter, ctx);
}

export function registerCardsExportCommand(program: Command): void {
  program
    .command('cards export <board>')
    .description('Export cards from a board to JSON or CSV')
    .option('--format <format>', 'Export format: json or csv', 'json')
    .option('--out <file>', 'Output file path (defaults to stdout)')
    .option('--filter <expression>', 'Filter cards (repeatable, e.g. "assignee:alice"). All conditions must match (AND logic)', (val, prev: string[]) => prev.concat([val]), [] as string[])
    // #44: no --limit. The board is fetched to completion; a cap here could only
    // silently export part of a board and call it the export.
    .action(async (_exportArg: string, board: string, options: {
      format?: string;
      out?: string;
      filter: string[];
    }) => {
      const verbose = program.parent?.opts()?.verbose ?? program.opts()?.verbose ?? false;
      // Check FAVRO_API_TOKEN early
      const token = process.env.FAVRO_API_TOKEN;

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

      try {
        const client = await createFavroClient();
        const api = new CardsAPI(client);

        // Fetch cards (pagination handled in CardsAPI)
        const spinner = new Spinner('Fetching cards');
        spinner.start();
        let cards = await api.listCards(board);
        spinner.stop();

        // Apply optional filters (AND logic — all must match)
        const filters = options.filter ?? [];
        if (filters.length > 0) {
          const before = cards.length;
          cards = await applyFilters(cards, filters, { client, boardId: board });
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
