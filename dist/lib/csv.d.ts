/**
 * CSV and JSON Export Utilities
 * FAVRO-009: Cards Export Command
 *
 * Supports:
 * - JSON export: array of card objects, pretty-printed, UTF-8
 * - CSV export: headers in first row, quoted fields, escape handling
 * - Streaming writes for large exports (10k+ cards)
 */
import { Card } from './cards-api';
export declare const EXPORT_FIELDS: readonly ["id", "title", "description", "status", "assignees", "labels", "dueDate", "createdAt", "updatedAt"];
export type ExportField = (typeof EXPORT_FIELDS)[number];
/**
 * Normalize a Card object to the canonical export shape.
 * Maps internal Card properties to spec-required field names.
 */
export interface ExportCard {
    id: string;
    title: string;
    description: string;
    status: string;
    assignees: string;
    labels: string;
    dueDate: string;
    createdAt: string;
    updatedAt: string;
}
export declare function normalizeCard(card: Card): ExportCard;
/**
 * Escape and quote a single CSV cell value.
 * - Wraps in double-quotes
 * - Doubles any embedded double-quotes
 */
export declare function escapeCsvField(value: string): string;
/**
 * Convert an array of ExportCard objects to a CSV string.
 * Suitable for small in-memory exports.
 */
export declare function cardsToCSV(cards: ExportCard[]): string;
/**
 * Write cards as CSV to a file using streaming writes.
 * Handles large exports (10k+ cards) without loading everything into memory.
 *
 * @param cards     Array of Card objects to export
 * @param filePath  Output file path
 */
export declare function writeCardsCSV(cards: Card[], filePath: string): Promise<void>;
/**
 * Write cards as pretty-printed JSON to a file.
 * For very large exports, uses streaming to avoid OOM.
 *
 * @param cards     Array of Card objects to export
 * @param filePath  Output file path
 */
export declare function writeCardsJSON(cards: Card[], filePath: string): Promise<void>;
//# sourceMappingURL=csv.d.ts.map