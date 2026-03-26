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
import { Card } from '../lib/cards-api';
export type ExportFormat = 'json' | 'csv';
/**
 * Parse a simple filter expression like "assignee:alice" or "status:done".
 * Returns {field, value} or null if the expression is not recognised.
 */
export declare function parseFilter(filter: string): {
    field: string;
    value: string;
} | null;
/**
 * Apply a parsed filter to a list of cards.
 * Supported fields: assignee, status, label, tag
 */
export declare function applyFilter(cards: Card[], filter: string): Card[];
/**
 * Apply multiple filters to cards (AND logic — all filters must match).
 */
export declare function applyFilters(cards: Card[], filters: string[]): Card[];
export declare function registerCardsExportCommand(program: Command): void;
export default registerCardsExportCommand;
//# sourceMappingURL=cards-export.d.ts.map