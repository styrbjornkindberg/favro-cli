/**
 * Collections Create Command
 * CLA-1783 FAVRO-021: Implement Collections Endpoints
 *
 * favro collections create --name "NAME" [--description "DESC"]
 */
import { Command } from 'commander';
import CollectionsAPI from '../lib/collections-api';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';

// No scope-lock check here, and that is the decision (#104), not an oversight.
// The lock is a COLLECTION lock — it resolves the board (or collection) a write
// targets and asks whether it is the locked one. `collections update` and
// `collections delete` both call `checkCollectionScope`, because both name an
// existing collection to check. `create` names none: the collection does not
// exist until the request returns, so it is outside the lock by construction.
// The asymmetry inside the `collections` group is decided, not forgotten.
//
// The same reasoning covers this write generally: guarding it could only mean a
// check that always passes (a lie) or one that always refuses (no locked user
// could ever create a collection). Restricting who may create org-level entities
// is an ORG-level guardrail, which does not exist — not this one wearing a
// costume. `confirmAction` is the guard the org-level writes actually carry.
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

        const name = options.name?.trim();
        if (!name) {
          console.error('Error: Collection name cannot be empty or whitespace-only');
          process.exit(1);
        }

        if (options.dryRun) {
          console.log(`[dry-run] Would create collection: "${name}"`);
          if (options.description) {
            console.log(`[dry-run] Description: "${options.description}"`);
          }
          return;
        }

        const client = await createFavroClient();
        const api = new CollectionsAPI(client);

        const collection = await api.createCollection({
          name,
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
