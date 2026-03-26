"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseFilter = parseFilter;
exports.applyFilter = applyFilter;
exports.registerCardsExportCommand = registerCardsExportCommand;
const cards_api_1 = __importDefault(require("../lib/cards-api"));
const http_client_1 = __importDefault(require("../lib/http-client"));
const csv_1 = require("../lib/csv");
/**
 * Parse a simple filter expression like "assignee:alice" or "status:done".
 * Returns {field, value} or null if the expression is not recognised.
 */
function parseFilter(filter) {
    const idx = filter.indexOf(':');
    if (idx === -1)
        return null;
    const field = filter.slice(0, idx).trim().toLowerCase();
    const value = filter.slice(idx + 1).trim().toLowerCase();
    return { field, value };
}
/**
 * Apply a parsed filter to a list of cards.
 * Supported fields: assignee, status, label, tag
 */
function applyFilter(cards, filter) {
    const parsed = parseFilter(filter);
    if (!parsed) {
        console.warn(`⚠ Unrecognised filter format: "${filter}" — expected field:value`);
        return cards;
    }
    const { field, value } = parsed;
    switch (field) {
        case 'assignee':
            return cards.filter(c => (c.assignees ?? []).some(a => a.toLowerCase().includes(value)));
        case 'status':
            return cards.filter(c => (c.status ?? '').toLowerCase() === value);
        case 'label':
        case 'tag':
            return cards.filter(c => (c.tags ?? []).some(t => t.toLowerCase().includes(value)));
        default:
            console.warn(`⚠ Unknown filter field: "${field}". Supported: assignee, status, label`);
            return cards;
    }
}
function registerCardsExportCommand(program) {
    program
        .command('cards export <board>')
        .description('Export cards from a board to JSON or CSV')
        .option('--format <format>', 'Export format: json or csv', 'json')
        .option('--out <file>', 'Output file path')
        .option('--filter <expression>', 'Filter cards (e.g. "assignee:alice", "status:done")')
        .option('--limit <number>', 'Maximum cards to fetch', '10000')
        .action(async (_exportArg, board, options) => {
        // Validate required options
        if (!options.out) {
            console.error(`✗ Missing required option: --out <file>`);
            process.exit(1);
        }
        // Validate format
        const format = (options.format ?? 'json').toLowerCase();
        if (format !== 'json' && format !== 'csv') {
            console.error(`✗ Invalid format "${options.format}". Use: json or csv`);
            process.exit(1);
        }
        const limit = parseInt(options.limit ?? '10000', 10) || 10000;
        try {
            const client = new http_client_1.default({
                auth: { token: process.env.FAVRO_API_TOKEN || 'demo-token' },
            });
            const api = new cards_api_1.default(client);
            // Fetch cards
            let cards = await api.listCards(board, limit);
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
                await (0, csv_1.writeCardsCSV)(cards, options.out);
            }
            else {
                await (0, csv_1.writeCardsJSON)(cards, options.out);
            }
            console.log(`✓ Exported ${cards.length} card(s) to "${options.out}" (${format.toUpperCase()})`);
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(`✗ Export failed: ${msg}`);
            process.exit(1);
        }
    });
}
exports.default = registerCardsExportCommand;
//# sourceMappingURL=cards-export.js.map