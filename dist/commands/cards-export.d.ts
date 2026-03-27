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
import { Card } from '../lib/cards-api';
export type ExportFormat = 'json' | 'csv';
/**
 * Apply a filter expression to cards using the enhanced query parser.
 * Supports: field:value, AND/OR operators, parentheses, date predicates, relationships, etc.
 * @throws Error if the filter syntax is invalid
 */
export declare function applyFilter(cards: Card[], filterExpression: string): Card[];
/**
 * Apply multiple filters to cards using the enhanced query parser.
 * Combines all filters with AND logic (all filters must match).
 * @throws Error if any filter syntax is invalid
 */
export declare function applyFilters(cards: Card[], filterExpressions: string[]): Card[];
export declare function registerCardsExportCommand(program: Command): void;
export default registerCardsExportCommand;
//# sourceMappingURL=cards-export.d.ts.map