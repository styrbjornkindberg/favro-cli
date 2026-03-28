/**
 * Collections Update Command
 * CLA-1783 FAVRO-021: Implement Collections Endpoints
 *
 * favro collections update <id> [--name "NEW_NAME"] [--description "DESC"]
 */
import { Command } from 'commander';
import CollectionsAPI from '../lib/collections-api';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';

export function registerCollectionsUpdateCommand(collectionsParent: Command): void {
  collectionsParent
    .command('update <id>')
    .description('Update an existing collection')
    .option('--name <name>', 'New collection name')
    .option('--description <text>', 'New collection description')
    .option('--json', 'Output updated collection as JSON')
    .option('--dry-run', 'Print what would be updated without making API calls')
    .option('--yes, -y', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(async (id: string, options) => {
      const verbose = collectionsParent.parent?.opts()?.verbose ?? false;
      try {

        const name = options.name?.trim();
        if (options.name !== undefined && !name) {
          console.error('Error: Collection name cannot be empty or whitespace-only');
          process.exit(1);
        }

        if (!name && !options.description) {
          console.error('Error: Provide at least one field to update: --name or --description');
          process.exit(1);
        }

        const updateData: { name?: string; description?: string } = {};
        if (name) updateData.name = name;
        if (options.description) updateData.description = options.description;

        if (options.dryRun) {
          console.log(`[dry-run] Would update collection ${id} with:`, JSON.stringify(updateData));
          return;
        }

        const client = await createFavroClient();

        const { readConfig } = await import('../lib/config');
        const { checkCollectionScope, confirmAction } = await import('../lib/safety');
        
        checkCollectionScope(id, await readConfig(), options.force);
        
        if (!(await confirmAction(`Update collection ${id}?`, { yes: options.yes }))) {
          console.log('Aborted.');
          process.exit(0);
        }

        const api = new CollectionsAPI(client);

        const collection = await api.updateCollection(id, updateData);

        console.log(`✓ Collection updated: ${collection.collectionId}`);
        console.log(`  Name: ${collection.name}`);
        if (collection.description) {
          console.log(`  Description: ${collection.description}`);
        }

        if (options.json) {
          console.log(JSON.stringify(collection, null, 2));
        }
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

export default registerCollectionsUpdateCommand;
