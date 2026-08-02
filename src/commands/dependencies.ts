/**
 * Dependencies Commands
 * CLA-1804 FAVRO-XXX: Dependencies Endpoints
 *
 * favro dependencies list <card>
 * favro dependencies add <sourceId> <targetId> --type blocks
 */
import { Command } from 'commander';
import CardsAPI from '../lib/cards-api';
import { linkTypeToIsBefore } from '../lib/dependency-direction';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';
import { checkScope, confirmAction, dryRunLog } from '../lib/safety';
import { capRows, noteTruncation, writeEnvelope } from '../lib/read-shape';
import { readConfig } from '../lib/config';

export function registerDependenciesCommands(program: Command): void {
  const depsCommand = program.command('dependencies').description('Manage card dependencies (blockers/related)');

  depsCommand
    .command('list <card>')
    .description('List dependencies for a card')
    .option('--limit <n>', 'Cap how many rows are printed; sets "truncated"')
    .option('--json', 'Output as JSON')
    .action(async (cardId: string, options) => {
      const verbose = depsCommand.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const api = new CardsAPI(client);
        const links = await api.getCardLinks(cardId);
        // The fetch already ran to completion; `--limit` cuts the PRINT (#99).
        const envelope = capRows(links, options.limit);

        if (options.json) {
          writeEnvelope(envelope);
        } else {
          console.log(`Found ${envelope.rows.length} dependencies for card ${cardId}:`);
          const rows = envelope.rows.map(lnk => ({
            Direction: lnk.isBefore ? 'before (blocks this card)' : 'after (blocked by this card)',
            Target: lnk.cardId,
            Name: lnk.cardName || '—',
          }));
          console.table(rows);
          noteTruncation(envelope, links.length);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  depsCommand
    .command('add <sourceId> <targetId>')
    .description('Add a dependency link between two cards')
    .requiredOption('--type <type>', 'Link type: depends-on, blocks')
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
        await checkScope(sourceCard?.boardId ?? '', client, config, options.force);

        if (options.dryRun) {
          dryRunLog('adding', 'dependency', `${sourceId} -> ${targetId} (${options.type})`);
          process.exit(0);
        }

        if (!(await confirmAction(`Link ${sourceId} -> ${targetId} (${options.type})?`, { yes: options.yes }))) {
          process.exit(0);
        }

        const link = await api.linkCard(sourceId, { toCardId: targetId, isBefore: linkTypeToIsBefore(options.type) });

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

  depsCommand
    .command('delete <card> <targetId>')
    .description('Remove a single dependency link between two cards')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass bounds checking')
    .action(async (cardId: string, targetId: string, options) => {
      const verbose = depsCommand.opts()?.verbose ?? false;
      try {
        if (options.dryRun) {
          dryRunLog('removing', 'dependency', `${cardId} -> ${targetId}`);
          return;
        }

        const config = await readConfig();
        const client = await createFavroClient();
        const api = new CardsAPI(client);
        const card = await api.getCard(cardId);
        await checkScope(card?.boardId ?? '', client, config, options.force);

        if (!(await confirmAction(`Remove dependency ${cardId} -> ${targetId}?`, { yes: options.yes }))) {
          return;
        }

        await api.unlinkCard(cardId, targetId);

        console.log(`✓ Dependency removed: ${cardId} -> ${targetId}`);
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  depsCommand
    .command('delete-all <card>')
    .description('Remove all dependencies from a card')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass bounds checking')
    .action(async (cardId: string, options) => {
      const verbose = depsCommand.opts()?.verbose ?? false;
      try {
        if (options.dryRun) {
          dryRunLog('removing all dependencies from', 'card', cardId);
          return;
        }

        const config = await readConfig();
        const client = await createFavroClient();
        const api = new CardsAPI(client);
        const card = await api.getCard(cardId);
        await checkScope(card?.boardId ?? '', client, config, options.force);

        if (!(await confirmAction(`Remove ALL dependencies from card ${cardId}? This cannot be undone.`, { yes: options.yes }))) {
          return;
        }

        await api.deleteAllDependencies(cardId);

        console.log(`✓ All dependencies removed from card ${cardId}`);
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}
