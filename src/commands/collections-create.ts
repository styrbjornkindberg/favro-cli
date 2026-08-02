/**
 * Collections Create Command
 * CLA-1783 FAVRO-021: Implement Collections Endpoints
 *
 * favro collections create --name "NAME" [--description "DESC"]
 */
import { Command } from 'commander';
import { Collection } from '../lib/collections-api';
import { run } from '../lib/run';

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
    .option('--dry-run', 'Print what would be created without making API calls')
    .action(run(async (ctx, options: { name?: string; description?: string; dryRun?: boolean }) => {
      const name = options.name?.trim();
      if (!name) {
        throw new Error('Collection name cannot be empty or whitespace-only');
      }

      if (options.dryRun) {
        console.log(`[dry-run] Would create collection: "${name}"`);
        if (options.description) {
          console.log(`[dry-run] Description: "${options.description}"`);
        }
        return;
      }

      return {
        item: await ctx.api.collections.createCollection({
          name,
          description: options.description,
        }),
        human: (created: Collection) => {
          console.log(`✓ Collection created: ${created.collectionId}`);
          console.log(`  Name: ${created.name}`);
          if (created.description) {
            console.log(`  Description: ${created.description}`);
          }
        },
      };
    }));
}

export default registerCollectionsCreateCommand;
