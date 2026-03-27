/**
 * Collections Create Command
 * CLA-1783 FAVRO-021: Implement Collections Endpoints
 *
 * favro collections create --name "NAME" [--description "DESC"]
 */
import { Command } from 'commander';
import CollectionsAPI from '../lib/collections-api';
import FavroHttpClient from '../lib/http-client';
import { resolveApiKey } from '../lib/config';
import { logError, missingApiKeyError } from '../lib/error-handler';

export function registerCollectionsCreateCommand(collectionsParent: Command): void {
  collectionsParent
    .command('create')
    .description('Create a new collection')
    .requiredOption('--name <name>', 'Collection name')
    .option('--description <text>', 'Collection description')
    .option('--json', 'Output created collection as JSON')
    .option('--dry-run', 'Print what would be created without making API calls')
    .action(async (options) => {
      const verbose = collectionsParent.parent?.opts()?.verbose ?? false;
      try {
        const token = await resolveApiKey();
        if (!token) {
          console.error(`Error: ${missingApiKeyError()}`);
          process.exit(1);
        }

        if (options.dryRun) {
          console.log(`[dry-run] Would create collection: "${options.name}"`);
          if (options.description) {
            console.log(`[dry-run] Description: "${options.description}"`);
          }
          return;
        }

        const client = new FavroHttpClient({ auth: { token } });
        const api = new CollectionsAPI(client);

        const collection = await api.createCollection({
          name: options.name,
          description: options.description,
        });

        console.log(`✓ Collection created: ${collection.collectionId}`);
        console.log(`  Name: ${collection.name}`);
        if (collection.description) {
          console.log(`  Description: ${collection.description}`);
        }

        if (options.json) {
          console.log(JSON.stringify(collection, null, 2));
        }
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}

export default registerCollectionsCreateCommand;
