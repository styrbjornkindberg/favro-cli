/**
 * Dependencies Commands
 * CLA-1804 FAVRO-XXX: Dependencies Endpoints
 *
 * favro dependencies list <cardId>
 * favro dependencies add <sourceId> <targetId> --type blocks
 */
import { Command } from 'commander';
import CardsAPI from '../lib/cards-api';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';
import { checkScope, confirmAction, dryRunLog } from '../lib/safety';
import { readConfig } from '../lib/config';

export function registerDependenciesCommands(program: Command): void {
  const depsCommand = program.command('dependencies').description('Manage card dependencies (blockers/related)');

  depsCommand
    .command('list <cardId>')
    .description('List dependencies for a card')
    .option('--json', 'Output as JSON')
    .action(async (cardId: string, options) => {
      const verbose = depsCommand.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const api = new CardsAPI(client);
        const links = await api.getCardLinks(cardId);

        if (options.json) {
          console.log(JSON.stringify(links, null, 2));
        } else {
          console.log(`Found ${links.length} dependencies for card ${cardId}:`);
          const rows = links.map(lnk => ({
            Type: lnk.type,
            Target: lnk.cardId,
            Name: lnk.cardName || '—',
          }));
          console.table(rows);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  depsCommand
    .command('add <sourceId> <targetId>')
    .description('Add a dependency link between two cards')
    .requiredOption('--type <type>', 'Link type: depends-on, blocks, related, duplicates')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass bounds checking')
    .action(async (sourceId: string, targetId: string, options) => {
      const verbose = depsCommand.opts()?.verbose ?? false;
      try {
        const config = await readConfig();
        const client = await createFavroClient();
        
        // Safety bound: check scope for source card
        const api = new CardsAPI(client);
        const sourceCard = await api.getCard(sourceId);
        if (sourceCard && sourceCard.boardId) {
            await checkScope(sourceCard.boardId, client, config, options.force);
        }

        if (options.dryRun) {
          dryRunLog('adding', 'dependency', `${sourceId} -> ${targetId} (${options.type})`);
          process.exit(0);
        }

        if (!(await confirmAction(`Link ${sourceId} -> ${targetId} (${options.type})?`, { yes: options.yes }))) {
          process.exit(0);
        }

        const link = await api.linkCard(sourceId, { toCardId: targetId, type: options.type });

        if (options.json) {
          console.log(JSON.stringify(link, null, 2));
        } else {
          console.log(`✓ Dependency added: ${sourceId} -> ${targetId} (${options.type})`);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}
