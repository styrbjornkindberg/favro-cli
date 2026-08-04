/**
 * Collections Delete Command
 *
 * favro collections delete <id> [--yes] [--force]
 */
import { Command } from 'commander';
import { checkCollectionScope, confirmAction } from '../lib/safety';
import { run } from '../lib/run';

interface DeleteOptions {
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
}

export function registerCollectionsDeleteCommand(collectionsParent: Command): void {
  collectionsParent
    .command('delete <id>')
    .description('Delete a collection (destructive — cannot be undone)')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(run(async (ctx, id: string, options: DeleteOptions) => {
      // The lock runs BEFORE the preview (#152), same order as the `boards` pair.
      // No lock gate needed here and none wanted: `checkCollectionScope` is a pure
      // comparison against `ctx.config`, touches no client and issues no request, so
      // the refusal was available to the preview at zero cost all along and the
      // preview still did not make it. This half is the ticket's decisive one.
      checkCollectionScope(id, ctx.config, options.force);

      if (options.dryRun) {
        console.log(`[dry-run] Would delete collection ${id}`);
        return;
      }

      if (!(await confirmAction(`Delete collection ${id}? This cannot be undone.`, { yes: options.yes }))) {
        console.log('Aborted.');
        return;
      }

      await ctx.api.collections.deleteCollection(id).catch((error: any) => {
        if (error?.response?.status === 404) {
          throw new Error(`Collection not found: ${id}. Use 'favro collections list' to see available collections.`);
        }
        throw error;
      });

      // A machine shape for the delete, for the reason spelled out on
      // `boards delete`. The human line is unchanged.
      return {
        item: { deleted: true, collectionId: id },
        human: () => console.log(`✓ Collection deleted: ${id}`),
      };
    }));
}

export default registerCollectionsDeleteCommand;
