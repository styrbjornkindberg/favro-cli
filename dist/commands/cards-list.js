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
exports.registerCardsListCommand = registerCardsListCommand;
const cards_api_1 = __importDefault(require("../lib/cards-api"));
const http_client_1 = __importDefault(require("../lib/http-client"));
const error_handler_1 = require("../lib/error-handler");
const boards_api_1 = __importDefault(require("../lib/boards-api"));
const query_parser_1 = require("../lib/query-parser");
function formatCardsTable(cards) {
    if (cards.length === 0) {
        console.log('No cards found.');
        return;
    }
    const rows = cards.map(card => ({
        ID: card.cardId,
        Title: card.name.length > 40 ? card.name.slice(0, 37) + '...' : card.name,
        Status: card.status || '—',
        Assignees: (card.assignees || []).join(', ') || '—',
        Tags: (card.tags || []).join(', ') || '—',
        Created: card.createdAt ? card.createdAt.slice(0, 10) : '—',
    }));
    console.table(rows);
}
function formatCardsCSV(cards) {
    const header = ['ID', 'Title', 'Status', 'Assignees', 'Tags', 'DueDate', 'Created', 'Updated'];
    const rows = cards.map(card => [
        card.cardId,
        card.name,
        card.status || '',
        (card.assignees || []).join(';'),
        (card.tags || []).join(';'),
        card.dueDate || '',
        card.createdAt ? card.createdAt.slice(0, 10) : '',
        card.updatedAt ? card.updatedAt.slice(0, 10) : '',
    ]);
    const escape = (v) => `"${String(v).replace(/"/g, '""')}"`;
    console.log(header.map(escape).join(','));
    rows.forEach(row => console.log(row.map(escape).join(',')));
}
function registerCardsListCommand(program) {
    program
        .command('cards list')
        .description('List cards from a board')
        .option('--board <id>', 'Board ID to list cards from')
        .option('--status <status>', 'Filter by status (legacy, use --filter instead)')
        .option('--assignee <user>', 'Filter by assignee (legacy, use --filter instead)')
        .option('--tag <tag>', 'Filter by tag (legacy, use --filter instead)')
        .option('--filter <expression>', 'Filter cards using enhanced query syntax (e.g. "status:done OR status:in-progress")', (val, prev) => prev.concat([val]), [])
        .option('--limit <number>', 'Maximum number of cards to return', '50')
        .option('--json', 'Output as JSON')
        .option('--csv', 'Output as CSV')
        .action(async (_listArg, options) => {
        const verbose = program.parent?.opts()?.verbose ?? program.opts()?.verbose ?? false;
        try {
            const token = process.env.FAVRO_API_TOKEN;
            if (!token) {
                console.error(`Error: ${(0, error_handler_1.missingApiKeyError)()}`);
                process.exit(1);
            }
            const client = new http_client_1.default({
                auth: { token }
            });
            const api = new cards_api_1.default(client);
            const parsedLimit = parseInt(options.limit, 10);
            const limit = isNaN(parsedLimit) || parsedLimit < 1 ? 50 : parsedLimit;
            let cards = await api.listCards(options.board, limit);
            // Apply enhanced query filters (if provided)
            if (options.filter && options.filter.length > 0) {
                try {
                    const combinedFilter = options.filter.join(' AND ');
                    const query = (0, query_parser_1.parseQuery)(combinedFilter);
                    cards = (0, query_parser_1.filterCards)(query, cards);
                }
                catch (err) {
                    console.error(`✗ Invalid filter expression: ${err.message}`);
                    process.exit(1);
                }
            }
            else {
                // Fallback to legacy options for backward compatibility
                if (options.status) {
                    cards = cards.filter(c => c.status?.toLowerCase() === options.status.toLowerCase());
                }
                if (options.assignee) {
                    cards = cards.filter(c => (c.assignees || []).some(a => a.toLowerCase().includes(options.assignee.toLowerCase())));
                }
                if (options.tag) {
                    cards = cards.filter(c => (c.tags || []).some(t => t.toLowerCase().includes(options.tag.toLowerCase())));
                }
            }
            if (options.json) {
                console.log(JSON.stringify(cards, null, 2));
            }
            else if (options.csv) {
                formatCardsCSV(cards);
            }
            else {
                console.log(`Found ${cards.length} card(s):`);
                formatCardsTable(cards);
            }
        }
        catch (error) {
            if (options.board && error?.response?.status === 404) {
                // Board not found — fetch available boards and suggest
                try {
                    const boardsApi = new boards_api_1.default(new (await Promise.resolve().then(() => __importStar(require('../lib/http-client')))).default({ auth: { token: process.env.FAVRO_API_TOKEN } }));
                    const boards = await boardsApi.listBoards();
                    const boardNames = boards.map(b => b.name);
                    const helpfulMsg = (0, error_handler_1.suggestBoard)(options.board, boardNames);
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
exports.default = registerCardsListCommand;
//# sourceMappingURL=cards-list.js.map