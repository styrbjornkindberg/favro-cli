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
exports.BATCH_LIMIT = void 0;
exports.confirmPrompt = confirmPrompt;
exports.registerCardsUpdateCommand = registerCardsUpdateCommand;
const readline = __importStar(require("readline"));
const cards_api_1 = __importDefault(require("../lib/cards-api"));
const http_client_1 = __importDefault(require("../lib/http-client"));
const error_handler_1 = require("../lib/error-handler");
/**
 * Max cards that can be updated in a single batch.
 * Spec: "Max 100 cards per command (warn if > 100 match)"
 */
exports.BATCH_LIMIT = 100;
/**
 * Prompt the user for confirmation (y/n).
 * Returns true if the user answered 'y' or 'yes'.
 * Exported for testing purposes.
 */
async function confirmPrompt(question) {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
        });
    });
}
function registerCardsUpdateCommand(program) {
    program
        .command('cards update <cardId>')
        .description('Update a card')
        .option('--name <name>', 'New card name')
        .option('--description <desc>', 'Card description')
        .option('--status <status>', 'Card status')
        .option('--assignees <list>', 'Assignees (comma-separated)')
        .option('--tags <list>', 'Tags (comma-separated)')
        .option('--json', 'Output as JSON')
        .option('--dry-run', 'Show what would be updated without making changes')
        .option('--yes', 'Skip confirmation prompt')
        .action(async (_updateArg, cardId, options) => {
        const verbose = program.parent?.opts()?.verbose ?? program.opts()?.verbose ?? false;
        try {
            const token = process.env.FAVRO_API_TOKEN;
            if (!token) {
                console.error(`Error: ${(0, error_handler_1.missingApiKeyError)()}`);
                process.exit(1);
            }
            const client = new http_client_1.default({
                auth: { token },
            });
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
            // Dry-run mode: show what would be updated without making changes
            if (options.dryRun) {
                console.log(`[dry-run] Would update card: ${cardId}`);
                console.log('[dry-run] Changes:', JSON.stringify(updateData, null, 2));
                return;
            }
            // Confirmation prompt (unless --yes flag is used)
            if (!options.yes) {
                const confirmed = await confirmPrompt(`Update card ${cardId}? (y/n) `);
                if (!confirmed) {
                    console.log('Update cancelled.');
                    return;
                }
            }
            const card = await api.updateCard(cardId, updateData);
            console.log(`✓ Card updated: ${card.cardId}`);
            if (options.json)
                console.log(JSON.stringify(card));
        }
        catch (error) {
            (0, error_handler_1.logError)(error, verbose);
            process.exit(1);
        }
    });
}
exports.default = registerCardsUpdateCommand;
//# sourceMappingURL=cards-update.js.map