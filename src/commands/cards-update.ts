import { Command } from 'commander';
import CardsAPI from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';

export function registerCardsUpdateCommand(program: Command): void {
  program
    .command('cards update <cardId>')
    .description('Update a card')
    .option('--name <name>', 'New card name')
    .option('--description <desc>', 'Card description')
    .option('--status <status>', 'Card status')
    .option('--assignees <list>', 'Assignees (comma-separated)')
    .option('--tags <list>', 'Tags (comma-separated)')
    .option('--json', 'Output as JSON')
    .action(async (_updateArg, cardId, options) => {
      try {
        const client = new FavroHttpClient({ 
          auth: { token: process.env.FAVRO_API_TOKEN || 'demo-token' }
        });
        const api = new CardsAPI(client);

        const updateData: any = {};
        if (options.name) updateData.name = options.name;
        if (options.description) updateData.description = options.description;
        if (options.status) updateData.status = options.status;
        if (options.assignees) updateData.assignees = options.assignees.split(',');
        if (options.tags) updateData.tags = options.tags.split(',');

        const card = await api.updateCard(cardId, updateData);
        console.log(`✓ Card updated: ${card.cardId}`);
        if (options.json) console.log(JSON.stringify(card));
      } catch (error) {
        console.error(`✗ Error: ${error}`);
        process.exit(1);
      }
    });
}

export default registerCardsUpdateCommand;
