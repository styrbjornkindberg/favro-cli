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

      // The delete had no machine path at all before, so this invents one
      // rather than replacing one. It has to: with JSON the default, the
      // streaming arm would put `✓ Board deleted: …` on an agent's stdout and
      // make the group's contract inconsistent on day one — `boards update`
      // parses, `boards delete` throws. The human line is unchanged.
      return {
        item: { deleted: true, boardId: id },
        human: () => console.log(`✓ Board deleted: ${id}`),
      };
    }));
}

export default registerBoardsDeleteCommand;
