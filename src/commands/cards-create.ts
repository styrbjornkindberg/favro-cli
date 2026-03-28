/**
 * Cards Create Command
 * FAVRO-006: Cards Create Command (Bulk + Single)
 */
import { Command } from 'commander';
import { createFavroClient } from '../lib/client-factory';
import CardsAPI from '../lib/cards-api';
import { logError, missingApiKeyError } from '../lib/error-handler';
import { ProgressBar } from '../lib/progress';
import { parseQuery } from '../lib/query-parser';

export function registerCardsCreateCommand(program: Command): void {
  program
    .command('cards create <title>')
    .description('Create a new card (or bulk from JSON file)')
    .option('--board <id>', 'Target board ID')
    .option('--description <text>', 'Card description')
    .option('--status <status>', 'Card status')
    .option('--filter <filter>', 'Filter expression for card selection')
    .option('--bulk <file>', 'Bulk create from JSON file')
    .option('--json', 'Output as JSON')
    .action(async (_createArg: string, title: string, options: {
      board?: string;
      description?: string;
      status?: string;
      filter?: string;
      bulk?: string;
      json?: boolean;
    }) => {
      const verbose = program.parent?.opts()?.verbose ?? program.opts()?.verbose ?? false;
      try {
        const token = process.env.FAVRO_API_TOKEN;

        // Parse filter if provided
        if (options.filter) {
          try {
            parseQuery(options.filter);
          } catch (err: any) {
            console.error(`✗ Invalid filter expression: ${err.message}`);
            process.exit(1);
          }
        }

        const client = await createFavroClient();
        const api = new CardsAPI(client);

        if (options.bulk) {
          // Bulk create from file
          const fs = await import('fs/promises');
          const data = JSON.parse(await fs.readFile(options.bulk, 'utf-8'));
          const total = Array.isArray(data) ? data.length : 1;
          const progress = new ProgressBar('Creating cards', total);
          progress.update(0);
          const cards = await api.createCards(data);
          progress.update(cards.length);
          progress.done(`Created ${cards.length} cards`);
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
        logError(error, verbose);
        process.exit(1);
      }
    });
}

export default registerCardsCreateCommand;
