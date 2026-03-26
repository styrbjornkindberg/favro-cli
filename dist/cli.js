#!/usr/bin/env node
"use strict";
/**
 * Favro CLI — Entry Point
 *
 * Usage:
 *   favro cards list [--board <id>] [--status <s>] [--assignee <a>] [--limit <n>]
 *   favro cards create <title> [--description <d>] [--status <s>] [--board <id>] [--dry-run]
 *   favro cards create --csv <file> --board <id> [--dry-run]
 *   favro cards update <cardId> [--name <n>] [--status <s>] [--assignees <a>] [--dry-run]
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
// ─── boards parent ────────────────────────────────────────────────────────────
const boardsCmd = program.command('boards').description('Board operations');
// ─── boards list ─────────────────────────────────────────────────────────────
boardsCmd
    .command('list')
    .description('List all boards')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
    const token = process.env.FAVRO_API_TOKEN;
    if (!token) {
        console.error('✗ Missing required environment variable: FAVRO_API_TOKEN');
        process.exit(1);
    }
    try {
        const client = new http_client_1.default({ auth: { token } });
        const data = await client.get('/boards', { params: { limit: 100 } });
        const boards = Array.isArray(data) ? data : (data?.entities ?? data?.boards ?? []);
        if (options.json) {
            console.log(JSON.stringify(boards, null, 2));
        }
        else {
            console.log(`Found ${boards.length} board(s):`);
            if (boards.length > 0) {
                const rows = boards.map((b) => ({
                    ID: b.boardId ?? b.id,
                    Name: b.name,
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
/**
 * Parse a CSV string into an array of objects using the header row.
 * Handles simple RFC 4180 CSV (no quoted newlines).
 */
function parseCSV(content) {
    const lines = content.trim().split('\n').filter(l => l.trim().length > 0);
    if (lines.length < 2)
        return [];
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    return lines.slice(1).map(line => {
        const values = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
        const obj = {};
        headers.forEach((h, i) => { obj[h] = values[i] ?? ''; });
        return obj;
    });
}
// ─── cards create ─────────────────────────────────────────────────────────────
cards
    .command('create <title>')
    .description('Create a new card, bulk from JSON file, or import from CSV')
    .option('--board <id>', 'Target board ID')
    .option('--description <text>', 'Card description')
    .option('--status <status>', 'Card status')
    .option('--bulk <file>', 'Bulk create from JSON file')
    .option('--csv <file>', 'Bulk import from CSV file (columns: name, description, status)')
    .option('--dry-run', 'Print what would be created without making API calls')
    .option('--json', 'Output as JSON')
    .action(async (title, options) => {
    const token = process.env.FAVRO_API_TOKEN;
    if (!token) {
        console.error('✗ Missing required environment variable: FAVRO_API_TOKEN');
        process.exit(1);
    }
    try {
        const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
        // ── CSV import ──────────────────────────────────────────────────────────
        if (options.csv) {
            const content = await fs.readFile(options.csv, 'utf-8');
            const rows = parseCSV(content);
            if (rows.length === 0) {
                console.error('✗ Error: CSV file is empty or has no data rows');
                process.exit(1);
            }
            const cards = rows.map(row => ({
                name: row.name || row.title || row.Name || row.Title || '',
                description: row.description || row.Description || undefined,
                status: row.status || row.Status || undefined,
                boardId: options.board,
            })).filter(c => c.name);
            if (options.dryRun) {
                console.log(`[dry-run] Would create ${cards.length} cards from CSV:`);
                cards.forEach(c => console.log(`  - ${c.name}`));
                return;
            }
            const client = new http_client_1.default({ auth: { token } });
            const api = new cards_api_1.default(client);
            const createdCards = await api.createCards(cards);
            console.log(`✓ Created ${createdCards.length} cards from CSV`);
            if (options.json)
                console.log(JSON.stringify(createdCards, null, 2));
            return;
        }
        // ── Bulk JSON import ────────────────────────────────────────────────────
        if (options.bulk) {
            const data = JSON.parse(await fs.readFile(options.bulk, 'utf-8'));
            if (options.dryRun) {
                const count = Array.isArray(data) ? data.length : 1;
                console.log(`[dry-run] Would create ${count} cards from bulk JSON`);
                return;
            }
            const client = new http_client_1.default({ auth: { token } });
            const api = new cards_api_1.default(client);
            const createdCards = await api.createCards(data);
            console.log(`✓ Created ${createdCards.length} cards`);
            if (options.json)
                console.log(JSON.stringify(createdCards));
            return;
        }
        // ── Single card ─────────────────────────────────────────────────────────
        if (options.dryRun) {
            console.log(`[dry-run] Would create card: "${title}" on board ${options.board}`);
            return;
        }
        const client = new http_client_1.default({ auth: { token } });
        const api = new cards_api_1.default(client);
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
    .option('--dry-run', 'Print what would be updated without making API calls')
    .option('--json', 'Output as JSON')
    .action(async (cardId, options) => {
    const token = process.env.FAVRO_API_TOKEN;
    if (!token) {
        console.error('✗ Missing required environment variable: FAVRO_API_TOKEN');
        process.exit(1);
    }
    try {
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
        if (options.dryRun) {
            console.log(`[dry-run] Would update card ${cardId} with:`, JSON.stringify(updateData));
            return;
        }
        const client = new http_client_1.default({ auth: { token } });
        const api = new cards_api_1.default(client);
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