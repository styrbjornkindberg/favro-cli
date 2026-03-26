/**
 * Cards Export Command
 * FAVRO-009: Cards Export Command (JSON, CSV)
 *
 * Usage:
 *   favro cards export <board> --format json --out report.json
 *   favro cards export <board> --format csv --out report.csv
 *   favro cards export <board> --format csv --filter "assignee:alice" --out alice.csv
 */
import { Command } from 'commander';
import path from 'path';
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

  // Validate filter value is non-empty
  if (!value.trim()) {
    console.error('✗ Filter value cannot be empty');
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

export function registerCardsExportCommand(program: Command): void {
  program
    .command('cards export <board>')
    .description('Export cards from a board to JSON or CSV')
    .option('--format <format>', 'Export format: json or csv', 'json')
    .option('--out <file>', 'Output file path')
    .option('--filter <expression>', 'Filter cards (e.g. "assignee:alice", "status:done")')
    .option('--limit <number>', 'Maximum cards to fetch', '10000')
    .action(async (_exportArg: string, board: string, options: {
      format?: string;
      out?: string;
      filter?: string;
      limit?: string;
    }) => {
      // Validate required options
      if (!options.out) {
        console.error(`✗ Missing required option: --out <file>`);
        process.exit(1);
      }

      // Validate format
      const format = (options.format ?? 'json').toLowerCase() as ExportFormat;
      if (format !== 'json' && format !== 'csv') {
        console.error(`✗ Invalid format "${options.format}". Use: json or csv`);
        process.exit(1);
      }

      // Fix #1 & #5: explicit NaN and range check — prevents --limit 0 and --limit -5 silently becoming 10000
      const parsedLimit = parseInt(options.limit ?? '10000', 10);
      const safeLimit = isNaN(parsedLimit) || parsedLimit < 1 ? 10000 : parsedLimit;

      // Fix #2: explicit token check — never silently fall back to demo-token
      const token = process.env.FAVRO_API_TOKEN;
      if (!token) {
        console.error('✗ Missing FAVRO_API_TOKEN. Run: favro auth login');
        process.exit(1);
      }

      // Fix #3: path traversal protection — output must be within current working directory
      const resolvedOut = path.resolve(options.out!);
      const cwd = process.cwd();
      if (!resolvedOut.startsWith(cwd)) {
        console.error('✗ Output path must be within current directory');
        process.exit(1);
      }

      try {
        const client = new FavroHttpClient({
          auth: { token },
        });
        const api = new CardsAPI(client);

        // Fetch cards
        let cards = await api.listCards(board, safeLimit);

        // Apply optional filter
        if (options.filter) {
          const before = cards.length;
          cards = applyFilter(cards, options.filter);
          console.log(`ℹ Filter "${options.filter}": ${before} → ${cards.length} card(s)`);
        }

        if (cards.length === 0) {
          console.log('⚠ No cards to export (0 results after filtering).');
          process.exit(0);
        }

        // Write output
        if (format === 'csv') {
          await writeCardsCSV(cards, resolvedOut);
        } else {
          await writeCardsJSON(cards, resolvedOut);
        }

        console.log(`✓ Exported ${cards.length} card(s) to "${options.out}" (${format.toUpperCase()})`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`✗ Export failed: ${msg}`);
        process.exit(1);
      }
    });
}

export default registerCardsExportCommand;
