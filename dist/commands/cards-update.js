"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerCardsUpdateCommand = registerCardsUpdateCommand;
const cards_api_1 = __importDefault(require("../lib/cards-api"));
const http_client_1 = __importDefault(require("../lib/http-client"));
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
        .action(async (cardId, options) => {
        try {
            const client = new http_client_1.default({
                auth: { token: process.env.FAVRO_API_TOKEN || 'demo-token' }
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
            const card = await api.updateCard(cardId, updateData);
            console.log(`✓ Card updated: ${card.cardId}`);
            if (options.json)
                console.log(JSON.stringify(card));
        }
        catch (error) {
            console.error(`✗ Error: ${error}`);
            process.exit(1);
        }
    });
}
exports.default = registerCardsUpdateCommand;
//# sourceMappingURL=cards-update.js.map