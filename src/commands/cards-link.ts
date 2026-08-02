/**
 * cards link / unlink / move / show / dependencies / blocking / blocked-by
 * CLA-1786 (FAVRO-024): Card Relationship Operations
 */
import { Command } from 'commander';
import CardsAPI from '../lib/cards-api';
import { LINK_TYPES, linkTypeToIsBefore } from '../lib/dependency-direction';
import { logError } from '../lib/error-handler';
import { createFavroClient } from '../lib/client-factory';
// `link` and `unlink` write a blocking edge, and the shared table already owns
// that write as `add-blocking-edge` / `remove-blocking-edge`. Going through it
// is what stops this file being a second, weaker path to the same wire call
// (#63): the pre-read, the reverse-edge refusal and the compensation log are all
// on the intent, and a direct `api.linkCard` here would have none of them.
import { dispatch, AddedEdge, EdgeArgs } from '../lib/dispatch';
import { reportDispatch } from '../lib/report-dispatch';

// 'related' and 'duplicates' are gone — Favro has no API representation for them,
// so they were being silently discarded. See lib/dependency-direction.ts.
export const VALID_LINK_TYPES = [...LINK_TYPES];
const VALID_POSITIONS = ['top', 'bottom'];

/**
 * Register link / unlink / move / show / dependencies / blocking / blocked-by
 * subcommands on the `cards` parent command.
 */
export function registerCardsLinkCommands(cardsCmd: Command): void {
  // ─── cards link ─────────────────────────────────────────────────────────────
  cardsCmd
    .command('link <card> <toCardId>')
    .description(
      'Record a blocking edge between two cards — the CLI surface of the\n' +
      '`add-blocking-edge` intent.\n\n' +
      'There is at most ONE edge per card pair (undirected identity, directed\n' +
      'semantics), so a pair\n' +
      'already holding the reverse edge is REFUSED, not overwritten — reversing is\n' +
      '`cards unlink` then `cards link`. An edge that is already there is reported,\n' +
      'not rewritten, so retrying after a failure is safe.\n\n' +
      'Examples:\n' +
      '  favro cards link CARD-A CARD-B --type depends-on   # B blocks A\n' +
      '  favro cards link CARD-A CARD-B --type blocks       # A blocks B\n\n' +
      `Valid types: ${VALID_LINK_TYPES.join(', ')}`
    )
    .requiredOption('--type <type>', `Link type: ${VALID_LINK_TYPES.join('|')}`)
    .option('--json', 'Output link details as JSON')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--dry-run', 'Preview the edge write without making it')
    .option('--force', 'Bypass scope check')
    .addHelpText('after', '\nIntent contract: run `favro help issue-tracker`.')
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
        const { readConfig } = await import('../lib/config');
        const { confirmAction } = await import('../lib/safety');

        if (!(await confirmAction(`Link card ${cardId} to ${toCardId} (${type})?`, { yes: options.yes }))) {
          console.log('Aborted.');
          process.exit(0);
        }

        // One intent, two spellings of the same edge. `depends-on` means the
        // target comes BEFORE this card, so the target is the blocker; `blocks`
        // is that same edge read from the other end, so the arguments swap.
        //
        // No cycle walk here and none in the intent: the old `wouldCreateCycle`
        // BFS was unbounded (derived N), followed `depends-on` only, and
        // swallowed every read failure — and the one real thing it caught, a
        // pair linked both ways round, is what the intent's bounded pre-read
        // settles for BOTH directions in one call.
        const args: EdgeArgs = linkTypeToIsBefore(type)
          ? { card: cardId, blockedBy: toCardId }
          : { card: toCardId, blockedBy: cardId };

        const result = await dispatch<AddedEdge>('add-blocking-edge', { ...args }, {
          client,
          config: (await readConfig()) ?? {},
          force: options.force,
          dryRun: options.dryRun,
        });
        if (reportDispatch(result, options.json)) process.exit(1);
        if (result.outcome === 'ok' && result.value !== undefined) {
          // "Created" and "already there" stay distinguishable, exactly as the
          // intent keeps them: reporting a no-op as a fresh write is the
          // silent-wrong-answer class this build exists to close.
          //
          // Both arms speak the refs the CALLER typed. The intent answers
          // resolved 24-hex ids, and echoing those on one arm only made one
          // command talk in two vocabularies.
          const blocker = args.card === cardId ? toCardId : cardId;
          const blocked = args.card === cardId ? cardId : toCardId;
          console.log(
            result.value.created
              ? `✓ Linked card ${cardId} → ${toCardId} (${type})`
              : `✓ Already linked: ${blocker} blocks ${blocked} — nothing written`,
          );
          if (options.json) {
            console.log(JSON.stringify(result.value, null, 2));
          }
        }
      } catch (error: any) {
        if (String(error?.message).startsWith('process.exit')) throw error;
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
    .command('unlink <card> <fromCardId>')
    .description(
      'Remove the blocking edge between two cards — the CLI surface of the\n' +
      '`remove-blocking-edge` intent.\n\n' +
      'Direction-agnostic: there is at most one edge per pair, so this removes\n' +
      'whichever way round it points. No edge to remove is reported as such and is\n' +
      'not an error, so a retry after a failed run can still reach a clean result.\n\n' +
      'Examples:\n' +
      '  favro cards unlink CARD-A CARD-B\n'
    )
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--json', 'Output the removal as JSON')
    .option('--dry-run', 'Preview the removal without making it')
    .option('--force', 'Bypass scope check')
    .addHelpText('after', '\nIntent contract: run `favro help issue-tracker`.')
    .action(async (cardId: string, fromCardId: string, options) => {
      const verbose = cardsCmd.parent?.opts()?.verbose ?? cardsCmd.opts()?.verbose ?? false;
      try {

        const client = await createFavroClient();
        const { readConfig } = await import('../lib/config');
        const { confirmAction } = await import('../lib/safety');

        if (!(await confirmAction(`Unlink card ${cardId} from ${fromCardId}?`, { yes: options.yes }))) {
          console.log('Aborted.');
          process.exit(0);
        }

        const result = await dispatch<{ removed: boolean; isBefore?: boolean }>(
          'remove-blocking-edge',
          { ...({ card: cardId, blockedBy: fromCardId } as EdgeArgs) },
          {
            client,
            config: (await readConfig()) ?? {},
            force: options.force,
            dryRun: options.dryRun,
          },
        );
        if (reportDispatch(result, options.json)) process.exit(1);
        if (result.outcome === 'ok' && result.value !== undefined) {
          console.log(
            result.value.removed
              ? `✓ Unlinked card ${cardId} from ${fromCardId}`
              : `✓ No edge between ${cardId} and ${fromCardId} — nothing written`,
          );
          if (options.json) {
            console.log(JSON.stringify(result.value, null, 2));
          }
        }
      } catch (error: any) {
        if (String(error?.message).startsWith('process.exit')) throw error;
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
    .command('move <card>')
    .description(
      'Move a card to a different board.\n\n' +
      'Examples:\n' +
      '  favro cards move <card> --to-board <board>\n' +
      '  favro cards move <card> --to-board <board> --position top\n' +
      '  favro cards move <card> --to-board <board> --position bottom\n\n' +
      `Valid positions: ${VALID_POSITIONS.join(', ')}`
    )
    .requiredOption('--to-board <board>', 'Destination board, by name or boardId')
    .option('--position <pos>', `Position on board: ${VALID_POSITIONS.join('|')}`)
    .option('--json', 'Output updated card as JSON')
    .option('-y, --yes', 'Skip confirmation prompt')
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
        if (String(error?.message).startsWith('process.exit')) throw error;
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
    .command('show <card>')
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
        if (String(error?.message).startsWith('process.exit')) throw error;
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
    .command('dependencies <card>')
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
        const deps = links.filter(l => l.isBefore);

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
        if (String(error?.message).startsWith('process.exit')) throw error;
        if (error?.response?.status === 404) {
          console.error(`Error: Card '${cardId}' not found.`);
        } else {
          logError(error, verbose);
        }
        process.exit(1);
      }
    });

  // ─── cards blocking ─────────────────────────────────────────────────────────
  // Renamed from `cards blockers` (#47): it returns the cards this card BLOCKS,
  // exactly as its own help string always said. `blockers` named the other end.
  cardsCmd
    .command('blocking <card>')
    .description(
      'List all cards blocked by this card.\n\n' +
      'Examples:\n' +
      '  favro cards blocking CARD-ID\n'
    )
    .option('--json', 'Output as JSON')
    .action(async (cardId: string, options) => {
      const verbose = cardsCmd.parent?.opts()?.verbose ?? cardsCmd.opts()?.verbose ?? false;
      try {

        const client = await createFavroClient();
        const api = new CardsAPI(client);

        const links = await api.getCardLinks(cardId);
        // Cards this card blocks come after it: isBefore === false.
        const blocked = links.filter(l => !l.isBefore);

        if (options.json) {
          console.log(JSON.stringify(blocked, null, 2));
          return;
        }

        if (blocked.length === 0) {
          console.log(`Card ${cardId} is not blocking any cards.`);
          return;
        }

        console.log(`Cards blocked by ${cardId}:`);
        blocked.forEach(l => console.log(`  ⛔ ${l.cardId}${l.cardName ? ` (${l.cardName})` : ''}`));
      } catch (error: any) {
        if (String(error?.message).startsWith('process.exit')) throw error;
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
    .command('blocked-by <card>')
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

        // blocked-by = cards that come before this one, i.e. edges with
        // isBefore === true. Same edge set as `cards dependencies`.
        const links = await api.getCardLinks(cardId);
        const blockedBy = links.filter(l => l.isBefore);

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
        if (String(error?.message).startsWith('process.exit')) throw error;
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
