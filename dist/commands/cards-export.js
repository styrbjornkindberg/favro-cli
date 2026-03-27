"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyFilter = applyFilter;
exports.applyFilters = applyFilters;
exports.registerCardsExportCommand = registerCardsExportCommand;
const path = __importStar(require("path"));
const cards_api_1 = __importDefault(require("../lib/cards-api"));
const http_client_1 = __importDefault(require("../lib/http-client"));
const csv_1 = require("../lib/csv");
const error_handler_1 = require("../lib/error-handler");
const boards_api_1 = __importDefault(require("../lib/boards-api"));
const progress_1 = require("../lib/progress");
const query_parser_1 = require("../lib/query-parser");
/**
 * Apply a filter expression to cards using the enhanced query parser.
 * Supports: field:value, AND/OR operators, parentheses, date predicates, relationships, etc.
 * @throws Error if the filter syntax is invalid
 */
function applyFilter(cards, filterExpression) {
    try {
        const query = (0, query_parser_1.parseQuery)(filterExpression);
        return (0, query_parser_1.filterCards)(query, cards);
    }
    catch (err) {
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
function applyFilters(cards, filterExpressions) {
    if (filterExpressions.length === 0)
        return cards;
    // Combine multiple filter expressions with AND operator
    const combinedFilter = filterExpressions.join(' AND ');
    return applyFilter(cards, combinedFilter);
}
function registerCardsExportCommand(program) {
    program
        .command('cards export <board>')
        .description('Export cards from a board to JSON or CSV')
        .option('--format <format>', 'Export format: json or csv', 'json')
        .option('--out <file>', 'Output file path (defaults to stdout)')
        .option('--filter <expression>', 'Filter cards (repeatable, e.g. "assignee:alice"). All conditions must match (AND logic)', (val, prev) => prev.concat([val]), [])
        .option('--limit <number>', 'Maximum cards to fetch', '10000')
        .action(async (_exportArg, board, options) => {
        const verbose = program.parent?.opts()?.verbose ?? program.opts()?.verbose ?? false;
        // Check FAVRO_API_TOKEN early
        const token = process.env.FAVRO_API_TOKEN;
        if (!token) {
            console.error(`Error: ${(0, error_handler_1.missingApiKeyError)()}`);
            process.exit(1);
        }
        // Validate format
        const format = (options.format ?? 'json').toLowerCase();
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
            const client = new http_client_1.default({
                auth: { token },
            });
            const api = new cards_api_1.default(client);
            // Fetch cards (pagination handled in CardsAPI)
            const spinner = new progress_1.Spinner('Fetching cards');
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
                const progress = new progress_1.ProgressBar('Exporting cards', cards.length);
                progress.update(0);
                if (format === 'csv') {
                    await (0, csv_1.writeCardsCSV)(cards, options.out);
                }
                else {
                    await (0, csv_1.writeCardsJSON)(cards, options.out);
                }
                progress.update(cards.length);
                progress.done(`Exported ${cards.length} card(s) to "${options.out}" (${format.toUpperCase()})`);
            }
            else {
                // Output to stdout
                const { normalizeCard } = await Promise.resolve().then(() => __importStar(require('../lib/csv')));
                const normalized = cards.map(normalizeCard);
                if (format === 'csv') {
                    const { cardsToCSV } = await Promise.resolve().then(() => __importStar(require('../lib/csv')));
                    process.stdout.write(cardsToCSV(normalized));
                }
                else {
                    process.stdout.write(JSON.stringify(normalized, null, 2) + '\n');
                }
                console.error(`ℹ Exported ${cards.length} card(s) to stdout (${format.toUpperCase()})`);
            }
        }
        catch (error) {
            if (board && error?.response?.status === 404) {
                // Board not found — fetch available boards and suggest
                try {
                    const boardsApi = new boards_api_1.default(new (await Promise.resolve().then(() => __importStar(require('../lib/http-client')))).default({ auth: { token: token } }));
                    const boards = await boardsApi.listBoards();
                    const boardNames = boards.map(b => b.name);
                    const helpfulMsg = (0, error_handler_1.suggestBoard)(board, boardNames);
                    console.error(`Error: ${helpfulMsg}`);
                }
                catch {
                    (0, error_handler_1.logError)(error, verbose);
                }
            }
            else {
                (0, error_handler_1.logError)(error, verbose);
            }
            process.exit(1);
        }
    });
}
exports.default = registerCardsExportCommand;
//# sourceMappingURL=cards-export.js.map