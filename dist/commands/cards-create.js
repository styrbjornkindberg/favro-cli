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
exports.registerCardsCreateCommand = registerCardsCreateCommand;
const client_factory_1 = require("../lib/client-factory");
const cards_api_1 = __importDefault(require("../lib/cards-api"));
const error_handler_1 = require("../lib/error-handler");
const progress_1 = require("../lib/progress");
const query_parser_1 = require("../lib/query-parser");
function registerCardsCreateCommand(program) {
    program
        .command('cards create <title>')
        .description('Create a new card (or bulk from JSON file)')
        .option('--board <id>', 'Target board ID')
        .option('--description <text>', 'Card description')
        .option('--status <status>', 'Card status')
        .option('--filter <filter>', 'Filter expression for card selection')
        .option('--bulk <file>', 'Bulk create from JSON file')
        .option('--json', 'Output as JSON')
        .action(async (_createArg, title, options) => {
        const verbose = program.parent?.opts()?.verbose ?? program.opts()?.verbose ?? false;
        try {
            const token = process.env.FAVRO_API_TOKEN;
            // Parse filter if provided
            if (options.filter) {
                try {
                    (0, query_parser_1.parseQuery)(options.filter);
                }
                catch (err) {
                    console.error(`✗ Invalid filter expression: ${err.message}`);
                    process.exit(1);
                }
            }
            const client = await (0, client_factory_1.createFavroClient)();
            const api = new cards_api_1.default(client);
            if (options.bulk) {
                // Bulk create from file
                const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
                const data = JSON.parse(await fs.readFile(options.bulk, 'utf-8'));
                const total = Array.isArray(data) ? data.length : 1;
                const progress = new progress_1.ProgressBar('Creating cards', total);
                progress.update(0);
                const cards = await api.createCards(data);
                progress.update(cards.length);
                progress.done(`Created ${cards.length} cards`);
                if (options.json)
                    console.log(JSON.stringify(cards));
            }
            else {
                // Single card create
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
            (0, error_handler_1.logError)(error, verbose);
            process.exit(1);
        }
    });
}
exports.default = registerCardsCreateCommand;
//# sourceMappingURL=cards-create.js.map