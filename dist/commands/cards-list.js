"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerCardsListCommand = registerCardsListCommand;
const cards_api_1 = __importDefault(require("../lib/cards-api"));
const http_client_1 = __importDefault(require("../lib/http-client"));
const error_handler_1 = require("../lib/error-handler");
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
        .option('--status <status>', 'Filter by status')
        .option('--assignee <user>', 'Filter by assignee')
        .option('--tag <tag>', 'Filter by tag')
        .option('--limit <number>', 'Maximum number of cards to return', '50')
        .option('--json', 'Output as JSON')
        .option('--csv', 'Output as CSV')
        .action(async (_listArg, options) => {
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
            // Apply client-side filters
            if (options.status) {
                cards = cards.filter(c => c.status?.toLowerCase() === options.status.toLowerCase());
            }
            if (options.assignee) {
                cards = cards.filter(c => (c.assignees || []).some(a => a.toLowerCase().includes(options.assignee.toLowerCase())));
            }
            if (options.tag) {
                cards = cards.filter(c => (c.tags || []).some(t => t.toLowerCase().includes(options.tag.toLowerCase())));
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
            (0, error_handler_1.logError)(error);
            process.exit(1);
        }
    });
}
exports.default = registerCardsListCommand;
//# sourceMappingURL=cards-list.js.map