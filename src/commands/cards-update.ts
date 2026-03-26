/**
 * Cards Update Command
 * FAVRO-007: Cards Update Command
 */
import { Command } from 'commander';
import * as readline from 'readline';
import CardsAPI, { UpdateCardRequest } from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';

/**
 * Max cards that can be updated in a single batch.
 * Spec: "Max 100 cards per command (warn if > 100 match)"
 */
export const BATCH_LIMIT = 100;

/**
 * Prompt the user for confirmation (y/n).
 * Returns true if the user answered 'y' or 'yes'.
 * Exported for testing purposes.
 */
export async function confirmPrompt(question: string): Promise<boolean> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}

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
    .option('--dry-run', 'Show what would be updated without making changes')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (_updateArg: string, cardId: string, options: {
      name?: string;
      description?: string;
      status?: string;
      assignees?: string;
      tags?: string;
      json?: boolean;
      dryRun?: boolean;
      yes?: boolean;
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

        const updateData: UpdateCardRequest = {};
        if (options.name) updateData.name = options.name;
        if (options.description) updateData.description = options.description;
        if (options.status) updateData.status = options.status;
        if (options.assignees) updateData.assignees = options.assignees.split(',');
        if (options.tags) updateData.tags = options.tags.split(',');

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
        if (options.json) console.log(JSON.stringify(card));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`✗ Error: ${msg}`);
        process.exit(1);
      }
    });
}

export default registerCardsUpdateCommand;
