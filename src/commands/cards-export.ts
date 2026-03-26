/**
 * Cards Export Command
 * FAVRO-009: Cards Export Command (JSON, CSV)
 *
 * Usage:
 *   favro cards export <board> --format json --out report.json
 *   favro cards export <board> --format csv --out report.csv
 *   favro cards export <board> --format csv --filter "assignee:alice" --out alice.csv
 *   favro cards export <board> --format csv --filter "assignee:alice" --filter "status:done" --out done.csv
 */
import { Command } from 'commander';
import * as path from 'path';
import CardsAPI, { Card } from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';
import { writeCardsCSV, writeCardsJSON } from '../lib/csv';

export type ExportFormat = 'json' | 'csv';

/**
 * Parse a simple filter expression like "assignee:alice" or "status:done".
 * Returns {field, value} or null if the expression is not recognised.
 */
export function parseFilter(filter: string): { field: string; value: string } | null {
  const idx = filter.indexOf(':');
  if (idx === -1) return null;
  const field = filter.slice(0, idx).trim().toLowerCase();
  const value = filter.slice(idx + 1).trim().toLowerCase();
  return { field, value };
}

/**
 * Apply a parsed filter to a list of cards.
 * Supported fields: assignee, status, label, tag
 */
export function applyFilter(cards: Card[], filter: string): Card[] {
  const parsed = parseFilter(filter);
  if (!parsed) {
    console.warn(`⚠ Unrecognised filter format: "${filter}" — expected field:value`);
    return cards;
  }

  const { field, value } = parsed;

  if (!value) {
    console.error(`✗ Filter value cannot be empty: "${filter}"`);
    process.exit(1);
  }

  switch (field) {
    case 'assignee':
      return cards.filter(c =>
        (c.assignees ?? []).some(a => a.toLowerCase().includes(value))
      );
    case 'status':
      return cards.filter(c => (c.status ?? '').toLowerCase() === value);
    case 'label':
    case 'tag':
      return cards.filter(c =>
        (c.tags ?? []).some(t => t.toLowerCase().includes(value))
      );
    default:
      console.warn(`⚠ Unknown filter field: "${field}". Supported: assignee, status, label`);
      return cards;
  }
}

/**
 * Apply multiple filters to cards (AND logic — all filters must match).
 */
export function applyFilters(cards: Card[], filters: string[]): Card[] {
  let result = cards;
  for (const filter of filters) {
    result = applyFilter(result, filter);
  }
  return result;
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
      // Check FAVRO_API_TOKEN early
      const token = process.env.FAVRO_API_TOKEN;
      if (!token) {
        console.error('✗ Missing required environment variable: FAVRO_API_TOKEN');
        process.exit(1);
      }

      // Validate format
      const format = (options.format ?? 'json').toLowerCase() as ExportFormat;
      if (format !== 'json' && format !== 'csv') {
        console.error(`✗ Invalid format "${options.format}". Use --format json or --format csv`);
        process.exit(1);
      }

      // Validate --out path (must be within cwd if specified)
      if (options.out) {
        const resolved = path.resolve(options.out);
        const cwd = process.cwd();
        if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
          console.error(`✗ Output path must be within current directory: ${options.out}`);
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
        let cards = await api.listCards(board, limit);

        // Apply optional filters (AND logic — all must match)
        const filters = options.filter ?? [];
        if (filters.length > 0) {
          const before = cards.length;
          cards = applyFilters(cards, filters);
          console.log(`ℹ Filters applied: ${before} → ${cards.length} card(s)`);
        }

        if (cards.length === 0) {
          console.log('⚠ No cards to export (0 results after filtering).');
          process.exit(0);
        }

        // Write output to file or stdout
        if (options.out) {
          if (format === 'csv') {
            await writeCardsCSV(cards, options.out);
          } else {
            await writeCardsJSON(cards, options.out);
          }
          console.log(`✓ Exported ${cards.length} card(s) to "${options.out}" (${format.toUpperCase()})`);
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
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`✗ Export failed: ${msg}`);
        process.exit(1);
      }
    });
}

export default registerCardsExportCommand;
