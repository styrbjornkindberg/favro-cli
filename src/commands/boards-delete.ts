/**
 * Boards Delete Command
 *
 * favro boards delete <id> [--yes] [--force]
 */
import { Command } from 'commander';
import BoardsAPI from '../lib/boards-api';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';

export function registerBoardsDeleteCommand(boardsParent: Command): void {
  boardsParent
    .command('delete <id>')
    .description('Delete a board (destructive — cannot be undone)')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(async (id: string, options) => {
      const verbose = boardsParent.parent?.opts()?.verbose ?? false;
      try {
        if (options.dryRun) {
          console.log(`[dry-run] Would delete board ${id}`);
          return;
        }

        const { readConfig } = await import('../lib/config');
        const { checkScope, confirmAction } = await import('../lib/safety');

        const client = await createFavroClient();
        await checkScope(id, client, await readConfig(), options.force);

        if (!(await confirmAction(`Delete board ${id}? This cannot be undone.`, { yes: options.yes }))) {
          console.log('Aborted.');
          return;
        }

        const api = new BoardsAPI(client);
        await api.deleteBoard(id);

        console.log(`✓ Board deleted: ${id}`);
      } catch (error: any) {
        if (error?.response?.status === 404) {
          console.error(`✗ Board not found: ${id}. Use 'favro boards list' to see available boards.`);
          process.exit(1);
        }
        logError(error, verbose);
        process.exit(1);
      }
    });
}

export default registerBoardsDeleteCommand;
