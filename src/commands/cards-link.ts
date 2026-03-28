/**
 * cards link / unlink / move / show / dependencies / blockers / blocked-by
 * CLA-1786 (FAVRO-024): Card Relationship Operations
 */
import { Command } from 'commander';
import CardsAPI from '../lib/cards-api';
import { logError } from '../lib/error-handler';
import { createFavroClient } from '../lib/client-factory';

export const VALID_LINK_TYPES = ['depends-on', 'blocks', 'related', 'duplicates'];
const VALID_POSITIONS = ['top', 'bottom'];

/**
 * Detect if linking cardId → toCardId would create a cycle in the depends-on graph.
 * Simple BFS: starting from toCardId, check if cardId is reachable via depends-on links.
 */
async function wouldCreateCycle(
  api: CardsAPI,
  cardId: string,
  toCardId: string
): Promise<boolean> {
  const visited = new Set<string>();
  const queue = [toCardId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    try {
      const links = await api.getCardLinks(current);
      for (const link of links) {
        if (link.type === 'depends-on') {
          if (link.cardId === cardId) return true;
          if (!visited.has(link.cardId)) queue.push(link.cardId);
        }
      }
    } catch {
      // best effort — if we can't fetch links, skip
    }
  }
  return false;
}

/**
 * Register link / unlink / move / show / dependencies / blockers / blocked-by
 * subcommands on the `cards` parent command.
 */
export function registerCardsLinkCommands(cardsCmd: Command): void {
  // ─── cards link ─────────────────────────────────────────────────────────────
  cardsCmd
    .command('link <cardId> <toCardId>')
    .description(
      'Link a card to another card.\n\n' +
      'Examples:\n' +
      '  favro cards link CARD-A CARD-B --type depends-on\n' +
      '  favro cards link CARD-A CARD-B --type blocks\n' +
      '  favro cards link CARD-A CARD-B --type related\n\n' +
      `Valid types: ${VALID_LINK_TYPES.join(', ')}`
    )
    .requiredOption('--type <type>', `Link type: ${VALID_LINK_TYPES.join('|')}`)
    .option('--json', 'Output link details as JSON')
    .option('--yes, -y', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(async (cardId: string, toCardId: string, options) => {
      const verbose = cardsCmd.parent?.opts()?.verbose ?? cardsCmd.opts()?.verbose ?? false;
      try {

        // Self-link prevention
        if (cardId === toCardId) {
          console.error(`Error: Cannot link a card to itself.`);
          process.exit(1);
        }

        const type = options.type.toLowerCase();
        if (!VALID_LINK_TYPES.includes(type)) {
          console.error(`Error: Invalid link type '${options.type}'. Valid: ${VALID_LINK_TYPES.join(', ')}`);
          process.exit(1);
        }

        const client = await createFavroClient();
        const api = new CardsAPI(client);
        
        const card = await api.getCard(cardId);
        
        const { readConfig } = await import('../lib/config');
        const { checkScope, confirmAction } = await import('../lib/safety');
        await checkScope(card.boardId ?? '', client, await readConfig(), options.force);
        
        if (!(await confirmAction(`Link card ${cardId} to ${toCardId} (${type})?`, { yes: options.yes }))) {
          console.log('Aborted.');
          process.exit(0);
        }

        // Circular dependency detection for depends-on
        if (type === 'depends-on') {
          const hasCycle = await wouldCreateCycle(api, cardId, toCardId);
          if (hasCycle) {
            console.error(`Error: Linking would create a circular dependency. Aborting.`);
            process.exit(1);
          }
        }

        const link = await api.linkCard(cardId, { toCardId, type: type as any });

        console.log(`✓ Linked card ${cardId} → ${toCardId} (${type})`);
        if (options.json) {
          console.log(JSON.stringify(link, null, 2));
        }
      } catch (error: any) {
        if (error?.message === 'process.exit') throw error;
        if (error?.response?.status === 404) {
          console.error(`Error: Card '${cardId}' or target '${toCardId}' not found.`);
        } else {
          logError(error, verbose);
        }
        process.exit(1);
      }
    });

  // ─── cards unlink ───────────────────────────────────────────────────────────
  cardsCmd
    .command('unlink <cardId> <fromCardId>')
    .description(
      'Remove a link between two cards.\n\n' +
      'Examples:\n' +
      '  favro cards unlink CARD-A CARD-B\n'
    )
    .option('--yes, -y', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(async (cardId: string, fromCardId: string, options) => {
      const verbose = cardsCmd.parent?.opts()?.verbose ?? cardsCmd.opts()?.verbose ?? false;
      try {

        const client = await createFavroClient();
        const api = new CardsAPI(client);
        
        const card = await api.getCard(cardId);
        
        const { readConfig } = await import('../lib/config');
        const { checkScope, confirmAction } = await import('../lib/safety');
        await checkScope(card.boardId ?? '', client, await readConfig(), options.force);
        
        if (!(await confirmAction(`Unlink card ${cardId} from ${fromCardId}?`, { yes: options.yes }))) {
          console.log('Aborted.');
          process.exit(0);
        }

        await api.unlinkCard(cardId, fromCardId);
        console.log(`✓ Unlinked card ${cardId} from ${fromCardId}`);
      } catch (error: any) {
        if (error?.message === 'process.exit') throw error;
        if (error?.response?.status === 404) {
          console.error(`Error: Card '${cardId}' or link to '${fromCardId}' not found.`);
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
    .option('--yes, -y', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(async (cardId: string, options) => {
      const verbose = cardsCmd.parent?.opts()?.verbose ?? cardsCmd.opts()?.verbose ?? false;
      try {

        if (options.position && !VALID_POSITIONS.includes(options.position.toLowerCase())) {
          console.error(`Error: Invalid position '${options.position}'. Valid: ${VALID_POSITIONS.join(', ')}`);
          process.exit(1);
        }

        const client = await createFavroClient();
        const api = new CardsAPI(client);
        
        const cardOrigin = await api.getCard(cardId);
        
        const { readConfig } = await import('../lib/config');
        const { checkScope, confirmAction } = await import('../lib/safety');
        const config = await readConfig();
        
        // Check scope of both origin board and destination board
        await checkScope(cardOrigin.boardId ?? '', client, config, options.force);
        await checkScope(options.toBoard, client, config, options.force);
        
        if (!(await confirmAction(`Move card ${cardId} to board ${options.toBoard}?`, { yes: options.yes }))) {
          console.log('Aborted.');
          process.exit(0);
        }

        const card = await api.moveCard(cardId, {
          toBoardId: options.toBoard,
          position: options.position?.toLowerCase() as 'top' | 'bottom' | undefined,
        });

        console.log(`✓ Card ${cardId} moved to board ${options.toBoard}`);
        if (options.json) {
          console.log(JSON.stringify(card, null, 2));
        }
      } catch (error: any) {
        if (error?.message === 'process.exit') throw error;
        if (error?.response?.status === 404) {
          console.error(`Error: Card '${cardId}' or board '${options.toBoard}' not found.`);
        } else {
          logError(error, verbose);
        }
        process.exit(1);
      }
    });

  // ─── cards show --relationships ─────────────────────────────────────────────
  cardsCmd
    .command('show <cardId>')
    .description(
      'Show card details with optional relationship info.\n\n' +
      'Examples:\n' +
      '  favro cards show CARD-ID --relationships\n'
    )
    .option('--relationships', 'Show all relationship links for this card')
    .option('--json', 'Output as JSON')
    .action(async (cardId: string, options) => {
      const verbose = cardsCmd.parent?.opts()?.verbose ?? cardsCmd.opts()?.verbose ?? false;
      try {

        const client = await createFavroClient();
        const api = new CardsAPI(client);

        const includes = options.relationships ? ['links'] : [];
        const card = await api.getCard(cardId, { include: includes });

        if (options.json || options.relationships) {
          console.log(JSON.stringify(card, null, 2));
          return;
        }

        // Default output
        const row: Record<string, string> = {
          ID: card.cardId,
          Title: card.name ?? '—',
          Status: card.status ?? '—',
          Assignees: (card.assignees ?? []).join(', ') || '—',
          Tags: (card.tags ?? []).join(', ') || '—',
          'Due Date': card.dueDate ?? '—',
          Created: card.createdAt ? card.createdAt.slice(0, 10) : '—',
        };
        console.table([row]);
      } catch (error: any) {
        if (error?.message === 'process.exit') throw error;
        if (error?.response?.status === 404) {
          console.error(`Error: Card '${cardId}' not found.`);
        } else {
          logError(error, verbose);
        }
        process.exit(1);
      }
    });

  // ─── cards dependencies ─────────────────────────────────────────────────────
  cardsCmd
    .command('dependencies <cardId>')
    .description(
      'List all cards this card depends on.\n\n' +
      'Examples:\n' +
      '  favro cards dependencies CARD-ID\n'
    )
    .option('--json', 'Output as JSON')
    .action(async (cardId: string, options) => {
      const verbose = cardsCmd.parent?.opts()?.verbose ?? cardsCmd.opts()?.verbose ?? false;
      try {

        const client = await createFavroClient();
        const api = new CardsAPI(client);

        const links = await api.getCardLinks(cardId);
        const deps = links.filter(l => l.type === 'depends-on');

        if (options.json) {
          console.log(JSON.stringify(deps, null, 2));
          return;
        }

        if (deps.length === 0) {
          console.log(`Card ${cardId} has no dependencies.`);
          return;
        }

        console.log(`Dependencies of card ${cardId}:`);
        deps.forEach(l => console.log(`  → ${l.cardId}${l.cardName ? ` (${l.cardName})` : ''}`));
      } catch (error: any) {
        if (error?.message === 'process.exit') throw error;
        if (error?.response?.status === 404) {
          console.error(`Error: Card '${cardId}' not found.`);
        } else {
          logError(error, verbose);
        }
        process.exit(1);
      }
    });

  // ─── cards blockers ─────────────────────────────────────────────────────────
  cardsCmd
    .command('blockers <cardId>')
    .description(
      'List all cards blocked by this card.\n\n' +
      'Examples:\n' +
      '  favro cards blockers CARD-ID\n'
    )
    .option('--json', 'Output as JSON')
    .action(async (cardId: string, options) => {
      const verbose = cardsCmd.parent?.opts()?.verbose ?? cardsCmd.opts()?.verbose ?? false;
      try {

        const client = await createFavroClient();
        const api = new CardsAPI(client);

        const links = await api.getCardLinks(cardId);
        const blockers = links.filter(l => l.type === 'blocks');

        if (options.json) {
          console.log(JSON.stringify(blockers, null, 2));
          return;
        }

        if (blockers.length === 0) {
          console.log(`Card ${cardId} is not blocking any cards.`);
          return;
        }

        console.log(`Cards blocked by ${cardId}:`);
        blockers.forEach(l => console.log(`  ⛔ ${l.cardId}${l.cardName ? ` (${l.cardName})` : ''}`));
      } catch (error: any) {
        if (error?.message === 'process.exit') throw error;
        if (error?.response?.status === 404) {
          console.error(`Error: Card '${cardId}' not found.`);
        } else {
          logError(error, verbose);
        }
        process.exit(1);
      }
    });

  // ─── cards blocked-by ───────────────────────────────────────────────────────
  cardsCmd
    .command('blocked-by <cardId>')
    .description(
      'List all cards that are blocking this card.\n\n' +
      'Examples:\n' +
      '  favro cards blocked-by CARD-ID\n'
    )
    .option('--json', 'Output as JSON')
    .action(async (cardId: string, options) => {
      const verbose = cardsCmd.parent?.opts()?.verbose ?? cardsCmd.opts()?.verbose ?? false;
      try {

        const client = await createFavroClient();
        const api = new CardsAPI(client);

        // blocked-by = links where other cards block this card.
        // We look at this card's links of type 'blocks' pointed inward,
        // which in Favro's model means this card has incoming 'blocks' links.
        // We use getCardLinks which returns outgoing links, so we look at
        // 'depends-on' links from this card (this card depends on cards that block it).
        const links = await api.getCardLinks(cardId);
        const blockedBy = links.filter(l => l.type === 'depends-on');

        if (options.json) {
          console.log(JSON.stringify(blockedBy, null, 2));
          return;
        }

        if (blockedBy.length === 0) {
          console.log(`Card ${cardId} is not blocked by any cards.`);
          return;
        }

        console.log(`Cards blocking ${cardId}:`);
        blockedBy.forEach(l => console.log(`  🚫 ${l.cardId}${l.cardName ? ` (${l.cardName})` : ''}`));
      } catch (error: any) {
        if (error?.message === 'process.exit') throw error;
        if (error?.response?.status === 404) {
          console.error(`Error: Card '${cardId}' not found.`);
        } else {
          logError(error, verbose);
        }
        process.exit(1);
      }
    });
}

export default registerCardsLinkCommands;
