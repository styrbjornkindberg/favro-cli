/**
 * cards get — Retrieve a single card with optional metadata includes
 * CLA-1785 (FAVRO-023): Advanced Cards Endpoints
 */
import { Command } from 'commander';
import CardsAPI from '../lib/cards-api';
import { logError } from '../lib/error-handler';
import { createFavroClient } from '../lib/client-factory';

const VALID_INCLUDES = ['board', 'collection', 'custom-fields', 'links', 'comments', 'relations'];

/**
 * Register `cards get <id>` as a subcommand on the `cards` parent command.
 */
export function registerCardsGetCommand(cardsCmd: Command): void {
  cardsCmd
    .command('get <cardId>')
    .description(
      'Retrieve a card by ID with optional metadata.\n\n' +
      'Examples:\n' +
      '  favro cards get <cardId>\n' +
      '  favro cards get <cardId> --include board,collection\n' +
      '  favro cards get <cardId> --include board,collection,custom-fields,links,comments\n\n' +
      `Valid includes: ${VALID_INCLUDES.join(', ')}`
    )
    .option(
      '--include <items>',
      'Comma-separated list of metadata to include: board,collection,custom-fields,links,comments,relations'
    )
    .option('--json', 'Output as JSON (default when includes present)')
    .action(async (cardId: string, options) => {
      const verbose = cardsCmd.parent?.opts()?.verbose ?? cardsCmd.opts()?.verbose ?? false;
      try {

        const includes: string[] = [];
        if (options.include) {
          const requested = options.include.split(',').map((s: string) => s.trim().toLowerCase());
          const invalid = requested.filter((i: string) => !VALID_INCLUDES.includes(i));
          if (invalid.length > 0) {
            console.error(`Error: Invalid include value(s): ${invalid.join(', ')}. Valid: ${VALID_INCLUDES.join(', ')}`);
            process.exit(1);
          }
          includes.push(...requested);
        }

        const client = await createFavroClient();
        const api = new CardsAPI(client);

        const card = await api.getCard(cardId, { include: includes });

        if (options.json || includes.length > 0) {
          console.log(JSON.stringify(card, null, 2));
          return;
        }

        // Default table-style output
        const row: Record<string, string> = {
          ID: card.cardId,
          Title: card.name ?? '—',  // null guard: API may return null name (CLA-1785 critic fix)
          Status: card.status ?? '—',
          Assignees: (card.assignees ?? []).join(', ') || '—',
          Tags: (card.tags ?? []).join(', ') || '—',
          'Due Date': card.dueDate ?? '—',
          Created: card.createdAt ? card.createdAt.slice(0, 10) : '—',
          Updated: card.updatedAt ? card.updatedAt.slice(0, 10) : '—',
        };
        console.table([row]);
      } catch (error: any) {
        if (error?.response?.status === 404) {
          console.error(`Error: Card '${cardId}' not found.`);
        } else {
          logError(error, verbose);
        }
        process.exit(1);
      }
    });
}

export default registerCardsGetCommand;
