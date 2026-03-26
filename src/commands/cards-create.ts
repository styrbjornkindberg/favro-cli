/**
 * Cards Create Command
 * FAVRO-006: Cards Create Command (Bulk + Single)
 */
import { Command } from 'commander';
import CardsAPI from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';

export function registerCardsCreateCommand(program: Command): void {
  program
    .command('cards create <title>')
    .description('Create a new card (or bulk from JSON file)')
    .option('--board <id>', 'Target board ID')
    .option('--description <text>', 'Card description')
    .option('--status <status>', 'Card status')
    .option('--bulk <file>', 'Bulk create from JSON file')
    .option('--json', 'Output as JSON')
    .action(async (_createArg: string, title: string, options: {
      board?: string;
      description?: string;
      status?: string;
      bulk?: string;
      json?: boolean;
    }) => {
      try {
        const token = process.env.FAVRO_API_TOKEN;
        if (!token) {
          console.error('✗ Missing required environment variable: FAVRO_API_TOKEN');
          process.exit(1);
        }

        const client = new FavroHttpClient({
          auth: { token },
        });
        const api = new CardsAPI(client);

        if (options.bulk) {
          // Bulk create from file
          const fs = await import('fs/promises');
          const data = JSON.parse(await fs.readFile(options.bulk, 'utf-8'));
          const cards = await api.createCards(data);
          console.log(`✓ Created ${cards.length} cards`);
          if (options.json) console.log(JSON.stringify(cards));
        } else {
          // Single card create
          const card = await api.createCard({
            name: title,
            description: options.description,
            status: options.status,
            boardId: options.board,
          });
          console.log(`✓ Card created: ${card.cardId}`);
          if (options.json) console.log(JSON.stringify(card));
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`✗ Error: ${msg}`);
        process.exit(1);
      }
    });
}

export default registerCardsCreateCommand;
