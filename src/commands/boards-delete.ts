/**
 * Boards Delete Command
 *
 * favro boards delete <id> [--yes] [--force]
 */
import { Command } from 'commander';
import { checkScope, confirmAction } from '../lib/safety';
import { run } from '../lib/run';

interface DeleteOptions {
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
}

export function registerBoardsDeleteCommand(boardsParent: Command): void {
  boardsParent
    .command('delete <id>')
    .description('Delete a board (destructive — cannot be undone)')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(run(async (ctx, id: string, options: DeleteOptions) => {
      if (options.dryRun) {
        console.log(`[dry-run] Would delete board ${id}`);
        return;
      }

      await checkScope(id, ctx.client, ctx.config, options.force);

      if (!(await confirmAction(`Delete board ${id}? This cannot be undone.`, { yes: options.yes }))) {
        console.log('Aborted.');
        return;
      }

      await ctx.api.boards.deleteBoard(id).catch((error: any) => {
        if (error?.response?.status === 404) {
          throw new Error(`Board not found: ${id}. Use 'favro boards list' to see available boards.`);
        }
        throw error;
      });

      // ponytail: the streaming arm, so this line is printed in JSON mode too —
      // exactly what it did before. There is no `--json` branch here to delete
      // and #114 is a migration, not a redesign; giving the delete a machine
      // shape is a change to the CONTRACT and belongs on its own issue.
      console.log(`✓ Board deleted: ${id}`);
    }));
}

export default registerBoardsDeleteCommand;
