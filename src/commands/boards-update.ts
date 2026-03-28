/**
 * Boards Update Command
 * CLA-1784 FAVRO-022: Advanced Boards Endpoints
 *
 * favro boards update <id> [--name "NEW"] [--description "DESC"]
 */
import { Command } from 'commander';
import BoardsAPI from '../lib/boards-api';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';

export function registerBoardsUpdateCommand(boardsParent: Command): void {
  boardsParent
    .command('update <id>')
    .description('Update an existing board')
    .option('--name <name>', 'New board name')
    .option('--description <text>', 'New board description')
    .option('--json', 'Output updated board as JSON')
    .option('--dry-run', 'Print what would be updated without making API calls')
    .action(async (id: string, options) => {
      const verbose = boardsParent.parent?.opts()?.verbose ?? false;
      try {

        const name = options.name?.trim();
        if (options.name && !name) {
          console.error('Error: Board name cannot be empty or whitespace-only');
          process.exit(1);
        }
        const description = options.description?.trim();

        if (!name && !description) {
          console.error('✗ No update fields provided. Use --name or --description.');
          process.exit(1);
        }

        const updateData: { name?: string; description?: string } = {};
        if (name) updateData.name = name;
        if (description) updateData.description = description;

        if (options.dryRun) {
          console.log(`[dry-run] Would update board ${id} with:`, JSON.stringify(updateData));
          return;
        }

        const client = await createFavroClient();
        const api = new BoardsAPI(client);

        const board = await api.updateBoard(id, updateData);

        if (options.json) {
          console.log(JSON.stringify(board, null, 2));
        } else {
          console.log(`✓ Board updated: ${board.boardId}`);
          console.log(`  Name: ${board.name}`);
          if (board.description) {
            console.log(`  Description: ${board.description}`);
          }
          console.log(`  Updated: ${board.updatedAt?.slice(0, 10) ?? '—'}`);
        }
      } catch (error: any) {
        if (error?.response?.status === 404) {
          console.error(`✗ Board not found: ${id}`);
          process.exit(1);
        }
        logError(error, verbose);
        process.exit(1);
      }
    });
}

export default registerBoardsUpdateCommand;
