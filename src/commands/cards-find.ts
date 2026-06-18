/**
 * cards find <url> — Find a card from its Favro web URL.
 * Parses the `card=` sequential ID from the URL and looks the card up via the API.
 */
import { Command } from 'commander';
import CardsAPI from '../lib/cards-api';
import { logError } from '../lib/error-handler';
import { createFavroClient } from '../lib/client-factory';

/**
 * Register `cards find <url>` as a subcommand on the `cards` parent command.
 */
export function registerCardsFindCommand(cardsCmd: Command): void {
  cardsCmd
    .command('find <url>')
    .description(
      'Find a card by its Favro web URL.\n\n' +
      'Examples:\n' +
      '  favro cards find "https://favro.com/organization/<orgId>/<board>?card=Squ-8850"\n' +
      '  favro cards find "<url>" --json'
    )
    .option('--json', 'Output as JSON')
    .action(async (url: string, options) => {
      const verbose = cardsCmd.parent?.opts()?.verbose ?? cardsCmd.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const api = new CardsAPI(client);

        const card = await api.findCardByUrl(url);

        if (!card) {
          console.error(`Error: No card found for URL: ${url}`);
          process.exit(1);
        }

        if (options.json) {
          console.log(JSON.stringify(card, null, 2));
          return;
        }

        const row: Record<string, string> = {
          ID: card.cardId,
          Title: card.name ?? '—',
          Status: card.status ?? '—',
          Assignees: (card.assignees ?? []).join(', ') || '—',
          Tags: (card.tags ?? []).join(', ') || '—',
          'Due Date': card.dueDate ?? '—',
          Created: card.createdAt ? card.createdAt.slice(0, 10) : '—',
          Updated: card.updatedAt ? card.updatedAt.slice(0, 10) : '—',
        };
        console.table([row]);
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}

export default registerCardsFindCommand;
