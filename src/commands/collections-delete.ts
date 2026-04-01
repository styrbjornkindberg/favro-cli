/**
 * Collections Delete Command
 *
 * favro collections delete <id> [--yes] [--force]
 */
import { Command } from 'commander';
import CollectionsAPI from '../lib/collections-api';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';

export function registerCollectionsDeleteCommand(collectionsParent: Command): void {
  collectionsParent
    .command('delete <id>')
    .description('Delete a collection (destructive — cannot be undone)')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(async (id: string, options) => {
      const verbose = collectionsParent.parent?.opts()?.verbose ?? false;
      try {
        if (options.dryRun) {
          console.log(`[dry-run] Would delete collection ${id}`);
          return;
        }

        const { readConfig } = await import('../lib/config');
        const { checkCollectionScope, confirmAction } = await import('../lib/safety');

        checkCollectionScope(id, await readConfig(), options.force);

        if (!(await confirmAction(`Delete collection ${id}? This cannot be undone.`, { yes: options.yes }))) {
          console.log('Aborted.');
          return;
        }

        const client = await createFavroClient();
        const api = new CollectionsAPI(client);
        await api.deleteCollection(id);

        console.log(`✓ Collection deleted: ${id}`);
      } catch (error: any) {
        if (error?.response?.status === 404) {
          console.error(`✗ Collection not found: ${id}. Use 'favro collections list' to see available collections.`);
          process.exit(1);
        }
        logError(error, verbose);
        process.exit(1);
      }
    });
}

export default registerCollectionsDeleteCommand;
