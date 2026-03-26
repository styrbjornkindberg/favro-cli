#!/usr/bin/env node
"use strict";
/**
 * Favro CLI — Entry Point
 *
 * Usage:
 *   favro cards list [--board <id>] [--status <s>] [--assignee <a>] [--limit <n>]
 *   favro cards create <title> [--description <d>] [--status <s>] [--board <id>]
 *   favro cards update <cardId> [--name <n>] [--status <s>] [--assignees <a>]
 *   favro cards export <board> --format json|csv [--out <file>] [--filter <expr>]
 *
 * Environment:
 *   FAVRO_API_TOKEN  Required. Favro API bearer token.
 */
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
const commander_1 = require("commander");
const path = __importStar(require("path"));
const cards_api_1 = __importDefault(require("./lib/cards-api"));
const http_client_1 = __importDefault(require("./lib/http-client"));
const csv_1 = require("./lib/csv");
const cards_export_1 = require("./commands/cards-export");
const program = new commander_1.Command();
program
    .name('favro')
    .description('Favro command-line interface')
    .version('0.1.0');
// ─── cards parent ────────────────────────────────────────────────────────────
const cards = program.command('cards').description('Card operations');
// ─── cards list ──────────────────────────────────────────────────────────────
cards
    .command('list')
    .description('List cards from a board')
    .option('--board <id>', 'Board ID to list cards from')
    .option('--status <status>', 'Filter by status')
    .option('--assignee <user>', 'Filter by assignee')
    .option('--tag <tag>', 'Filter by tag')
    .option('--limit <number>', 'Maximum number of cards to return', '50')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
    const token = process.env.FAVRO_API_TOKEN;
    if (!token) {
        console.error('✗ Missing required environment variable: FAVRO_API_TOKEN');
        process.exit(1);
    }
    try {
        const client = new http_client_1.default({ auth: { token } });
        const api = new cards_api_1.default(client);
        const limit = parseInt(options.limit, 10) || 50;
        let cardList = await api.listCards(options.board, limit);
        if (options.status) {
            cardList = cardList.filter(c => c.status?.toLowerCase() === options.status.toLowerCase());
        }
        if (options.assignee) {
            cardList = cardList.filter(c => (c.assignees || []).some(a => a.toLowerCase().includes(options.assignee.toLowerCase())));
        }
        if (options.tag) {
            cardList = cardList.filter(c => (c.tags || []).some(t => t.toLowerCase().includes(options.tag.toLowerCase())));
        }
        if (options.json) {
            console.log(JSON.stringify(cardList, null, 2));
        }
        else {
            console.log(`Found ${cardList.length} card(s):`);
            if (cardList.length > 0) {
                const rows = cardList.map(card => ({
                    ID: card.cardId,
                    Title: card.name.length > 40 ? card.name.slice(0, 37) + '...' : card.name,
                    Status: card.status || '—',
                    Assignees: (card.assignees || []).join(', ') || '—',
                    Tags: (card.tags || []).join(', ') || '—',
                    Created: card.createdAt ? card.createdAt.slice(0, 10) : '—',
                }));
                console.table(rows);
            }
        }
    }
    catch (error) {
        console.error(`✗ Error: ${error instanceof Error ? error.message : error}`);
        process.exit(1);
    }
});
// ─── cards create ─────────────────────────────────────────────────────────────
cards
    .command('create <title>')
    .description('Create a new card (or bulk from JSON file)')
    .option('--board <id>', 'Target board ID')
    .option('--description <text>', 'Card description')
    .option('--status <status>', 'Card status')
    .option('--bulk <file>', 'Bulk create from JSON file')
    .option('--json', 'Output as JSON')
    .action(async (title, options) => {
    const token = process.env.FAVRO_API_TOKEN;
    if (!token) {
        console.error('✗ Missing required environment variable: FAVRO_API_TOKEN');
        process.exit(1);
    }
    try {
        const client = new http_client_1.default({ auth: { token } });
        const api = new cards_api_1.default(client);
        if (options.bulk) {
            const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
            const data = JSON.parse(await fs.readFile(options.bulk, 'utf-8'));
            const createdCards = await api.createCards(data);
            console.log(`✓ Created ${createdCards.length} cards`);
            if (options.json)
                console.log(JSON.stringify(createdCards));
        }
        else {
            const card = await api.createCard({
                name: title,
                description: options.description,
                status: options.status,
                boardId: options.board,
            });
            console.log(`✓ Card created: ${card.cardId}`);
            if (options.json)
                console.log(JSON.stringify(card));
        }
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`✗ Error: ${msg}`);
        process.exit(1);
    }
});
// ─── cards update ─────────────────────────────────────────────────────────────
cards
    .command('update <cardId>')
    .description('Update a card')
    .option('--name <name>', 'New card name')
    .option('--description <desc>', 'Card description')
    .option('--status <status>', 'Card status')
    .option('--assignees <list>', 'Assignees (comma-separated)')
    .option('--tags <list>', 'Tags (comma-separated)')
    .option('--json', 'Output as JSON')
    .action(async (cardId, options) => {
    const token = process.env.FAVRO_API_TOKEN;
    if (!token) {
        console.error('✗ Missing required environment variable: FAVRO_API_TOKEN');
        process.exit(1);
    }
    try {
        const client = new http_client_1.default({ auth: { token } });
        const api = new cards_api_1.default(client);
        const updateData = {};
        if (options.name)
            updateData.name = options.name;
        if (options.description)
            updateData.description = options.description;
        if (options.status)
            updateData.status = options.status;
        if (options.assignees)
            updateData.assignees = options.assignees.split(',');
        if (options.tags)
            updateData.tags = options.tags.split(',');
        const card = await api.updateCard(cardId, updateData);
        console.log(`✓ Card updated: ${card.cardId}`);
        if (options.json)
            console.log(JSON.stringify(card));
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`✗ Error: ${msg}`);
        process.exit(1);
    }
});
// ─── cards export ─────────────────────────────────────────────────────────────
cards
    .command('export <board>')
    .description('Export cards from a board to JSON or CSV')
    .option('--format <format>', 'Export format: json or csv', 'json')
    .option('--out <file>', 'Output file path (defaults to stdout)')
    .option('--filter <expression>', 'Filter cards (repeatable, e.g. "assignee:alice"). All conditions must match (AND logic)', (val, prev) => prev.concat([val]), [])
    .option('--limit <number>', 'Maximum cards to fetch', '10000')
    .action(async (board, options) => {
    const token = process.env.FAVRO_API_TOKEN;
    if (!token) {
        console.error('✗ Missing required environment variable: FAVRO_API_TOKEN');
        process.exit(1);
    }
    const format = (options.format ?? 'json').toLowerCase();
    if (format !== 'json' && format !== 'csv') {
        console.error(`✗ Invalid format "${options.format}". Use --format json or --format csv`);
        process.exit(1);
    }
    if (options.out) {
        const resolved = path.resolve(options.out);
        const cwd = process.cwd();
        if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
            console.error(`✗ Output path must be within current directory: ${options.out}`);
            process.exit(1);
        }
    }
    const parsedLimit = parseInt(options.limit ?? '10000', 10);
    const limit = !isNaN(parsedLimit) && parsedLimit >= 1 ? parsedLimit : 10000;
    try {
        const client = new http_client_1.default({ auth: { token } });
        const api = new cards_api_1.default(client);
        let cardList = await api.listCards(board, limit);
        const filters = options.filter ?? [];
        if (filters.length > 0) {
            const before = cardList.length;
            cardList = (0, cards_export_1.applyFilters)(cardList, filters);
            console.log(`ℹ Filters applied: ${before} → ${cardList.length} card(s)`);
        }
        if (cardList.length === 0) {
            console.log('⚠ No cards to export (0 results after filtering).');
            process.exit(0);
        }
        if (options.out) {
            if (format === 'csv') {
                await (0, csv_1.writeCardsCSV)(cardList, options.out);
            }
            else {
                await (0, csv_1.writeCardsJSON)(cardList, options.out);
            }
            console.log(`✓ Exported ${cardList.length} card(s) to "${options.out}" (${format.toUpperCase()})`);
        }
        else {
            const normalized = cardList.map(csv_1.normalizeCard);
            if (format === 'csv') {
                process.stdout.write((0, csv_1.cardsToCSV)(normalized));
            }
            else {
                process.stdout.write(JSON.stringify(normalized, null, 2) + '\n');
            }
            console.error(`ℹ Exported ${cardList.length} card(s) to stdout (${format.toUpperCase()})`);
        }
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`✗ Export failed: ${msg}`);
        process.exit(1);
    }
});
program.parseAsync(process.argv).catch((err) => {
    console.error(`✗ Fatal: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map