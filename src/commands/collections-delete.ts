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
      if (options.dryRun) {
        console.log(`[dry-run] Would delete collection ${id}`);
        return;
      }

      checkCollectionScope(id, ctx.config, options.force);

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

      // ponytail: the streaming arm, printed in JSON mode too — exactly what it
      // did before. See the same note on `boards delete`.
      console.log(`✓ Collection deleted: ${id}`);
    }));
}

export default registerCollectionsDeleteCommand;
