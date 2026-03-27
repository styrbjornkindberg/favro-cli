/**
 * cards link / unlink / move — Card relation commands
 * CLA-1785 (FAVRO-023): Advanced Cards Endpoints
 */
import { Command } from 'commander';
import CardsAPI from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';
import { logError, missingApiKeyError } from '../lib/error-handler';
import { resolveApiKey } from '../lib/config';

const VALID_LINK_TYPES = ['depends', 'blocks', 'duplicates', 'relates'];
const VALID_POSITIONS = ['top', 'bottom'];

/**
 * Register link / unlink / move subcommands on the `cards` parent command.
 */
export function registerCardsLinkCommands(cardsCmd: Command): void {
  // ─── cards link ─────────────────────────────────────────────────────────────
  cardsCmd
    .command('link <cardId>')
    .description(
      'Link a card to another card.\n\n' +
      'Examples:\n' +
      '  favro cards link <cardId> --to <targetId> --type depends\n' +
      '  favro cards link <cardId> --to <targetId> --type blocks\n' +
      '  favro cards link <cardId> --to <targetId> --type relates\n\n' +
      `Valid types: ${VALID_LINK_TYPES.join(', ')}`
    )
    .requiredOption('--to <cardId>', 'Target card ID to link to')
    .requiredOption('--type <type>', `Link type: ${VALID_LINK_TYPES.join('|')}`)
    .option('--json', 'Output link details as JSON')
    .action(async (cardId: string, options) => {
      const verbose = cardsCmd.parent?.opts()?.verbose ?? cardsCmd.opts()?.verbose ?? false;
      try {
        const token = await resolveApiKey();
        if (!token) {
          console.error(`Error: ${missingApiKeyError()}`);
          process.exit(1);
        }

        const type = options.type.toLowerCase();
        if (!VALID_LINK_TYPES.includes(type)) {
          console.error(`Error: Invalid link type '${options.type}'. Valid: ${VALID_LINK_TYPES.join(', ')}`);
          process.exit(1);
        }

        const client = new FavroHttpClient({ auth: { token } });
        const api = new CardsAPI(client);

        const link = await api.linkCard(cardId, { toCardId: options.to, type: type as any });

        console.log(`✓ Linked card ${cardId} → ${options.to} (${type})`);
        if (options.json) {
          console.log(JSON.stringify(link, null, 2));
        }
      } catch (error: any) {
        if (error?.response?.status === 404) {
          console.error(`Error: Card '${cardId}' or target '${options.to}' not found.`);
        } else {
          logError(error, verbose);
        }
        process.exit(1);
      }
    });

  // ─── cards unlink ───────────────────────────────────────────────────────────
  cardsCmd
    .command('unlink <cardId>')
    .description(
      'Remove a link between two cards.\n\n' +
      'Examples:\n' +
      '  favro cards unlink <cardId> --from <linkedCardId>\n'
    )
    .requiredOption('--from <cardId>', 'Card ID to unlink from')
    .action(async (cardId: string, options) => {
      const verbose = cardsCmd.parent?.opts()?.verbose ?? cardsCmd.opts()?.verbose ?? false;
      try {
        const token = await resolveApiKey();
        if (!token) {
          console.error(`Error: ${missingApiKeyError()}`);
          process.exit(1);
        }

        const client = new FavroHttpClient({ auth: { token } });
        const api = new CardsAPI(client);

        await api.unlinkCard(cardId, options.from);
        console.log(`✓ Unlinked card ${cardId} from ${options.from}`);
      } catch (error: any) {
        if (error?.response?.status === 404) {
          console.error(`Error: Card '${cardId}' or link to '${options.from}' not found.`);
        } else {
          logError(error, verbose);
        }
        process.exit(1);
      }
    });

  // ─── cards move ─────────────────────────────────────────────────────────────
  cardsCmd
    .command('move <cardId>')
    .description(
      'Move a card to a different board.\n\n' +
      'Examples:\n' +
      '  favro cards move <cardId> --to-board <boardId>\n' +
      '  favro cards move <cardId> --to-board <boardId> --position top\n' +
      '  favro cards move <cardId> --to-board <boardId> --position bottom\n\n' +
      `Valid positions: ${VALID_POSITIONS.join(', ')}`
    )
    .requiredOption('--to-board <boardId>', 'Destination board ID')
    .option('--position <pos>', `Position on board: ${VALID_POSITIONS.join('|')}`)
    .option('--json', 'Output updated card as JSON')
    .action(async (cardId: string, options) => {
      const verbose = cardsCmd.parent?.opts()?.verbose ?? cardsCmd.opts()?.verbose ?? false;
      try {
        const token = await resolveApiKey();
        if (!token) {
          console.error(`Error: ${missingApiKeyError()}`);
          process.exit(1);
        }

        if (options.position && !VALID_POSITIONS.includes(options.position.toLowerCase())) {
          console.error(`Error: Invalid position '${options.position}'. Valid: ${VALID_POSITIONS.join(', ')}`);
          process.exit(1);
        }

        const client = new FavroHttpClient({ auth: { token } });
        const api = new CardsAPI(client);

        const card = await api.moveCard(cardId, {
          toBoardId: options.toBoard,
          position: options.position?.toLowerCase() as 'top' | 'bottom' | undefined,
        });

        console.log(`✓ Card ${cardId} moved to board ${options.toBoard}`);
        if (options.json) {
          console.log(JSON.stringify(card, null, 2));
        }
      } catch (error: any) {
        if (error?.response?.status === 404) {
          console.error(`Error: Card '${cardId}' or board '${options.toBoard}' not found.`);
        } else {
          logError(error, verbose);
        }
        process.exit(1);
      }
    });
}

export default registerCardsLinkCommands;
