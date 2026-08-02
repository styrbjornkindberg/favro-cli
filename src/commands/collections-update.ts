/**
 * Collections Update Command
 * CLA-1783 FAVRO-021: Implement Collections Endpoints
 *
 * favro collections update <id> [--name "NEW_NAME"] [--description "DESC"]
 */
import { Command } from 'commander';
import { Collection } from '../lib/collections-api';
import { checkCollectionScope, confirmAction } from '../lib/safety';
import { run } from '../lib/run';

interface UpdateOptions {
  name?: string;
  description?: string;
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
}

export function registerCollectionsUpdateCommand(collectionsParent: Command): void {
  collectionsParent
    .command('update <id>')
    .description('Update an existing collection')
    .option('--name <name>', 'New collection name')
    .option('--description <text>', 'New collection description')
    .option('--dry-run', 'Print what would be updated without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(run(async (ctx, id: string, options: UpdateOptions) => {
      const name = options.name?.trim();
      if (options.name !== undefined && !name) {
        throw new Error('Collection name cannot be empty or whitespace-only');
      }

      if (!name && !options.description) {
        throw new Error('Provide at least one field to update: --name or --description');
      }

      const updateData: { name?: string; description?: string } = {};
      if (name) updateData.name = name;
      if (options.description) updateData.description = options.description;

      if (options.dryRun) {
        console.log(`[dry-run] Would update collection ${id} with:`, JSON.stringify(updateData));
        return;
      }

      checkCollectionScope(id, ctx.config, options.force);

      if (!(await confirmAction(`Update collection ${id}?`, { yes: options.yes }))) {
        console.log('Aborted.');
        return;
      }

      const collection = await ctx.api.collections.updateCollection(id, updateData).catch((error: any) => {
        if (error?.response?.status === 404) {
          throw new Error(`Collection not found: ${id}. Use 'favro collections list' to see available collections.`);
        }
        throw error;
      });

      return {
        item: collection,
        human: (updated: Collection) => {
          console.log(`✓ Collection updated: ${updated.collectionId}`);
          console.log(`  Name: ${updated.name}`);
          if (updated.description) {
            console.log(`  Description: ${updated.description}`);
          }
        },
      };
    }));
}

export default registerCollectionsUpdateCommand;
