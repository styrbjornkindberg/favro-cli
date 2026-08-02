/**
 * cards find <url> — Find a card from its Favro web URL.
 * Parses the `card=` sequential ID from the URL and looks the card up via the API.
 */
import { Command } from 'commander';
import { Card } from '../lib/cards-api';
import { run } from '../lib/run';

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
      '  favro cards find "<url>" --human'
    )
    .action(run(async (ctx, url: string) => {
      const card = await ctx.api.cards.findCardByUrl(url);

      if (!card) {
        throw new Error(`No card found for URL: ${url}`);
      }

      return {
        item: card,
        human: (found: Card) => {
          const row: Record<string, string> = {
            ID: found.cardId,
            Title: found.name ?? '—',
            Status: found.status ?? '—',
            Assignees: (found.assignees ?? []).join(', ') || '—',
            Tags: (found.tags ?? []).join(', ') || '—',
            'Due Date': found.dueDate ?? '—',
            Created: found.createdAt ? found.createdAt.slice(0, 10) : '—',
          };
          console.table([row]);
        },
      };
    }));
}

export default registerCardsFindCommand;
