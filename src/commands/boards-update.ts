/**
 * Boards Update Command
 * CLA-1784 FAVRO-022: Advanced Boards Endpoints
 *
 * favro boards update <id> [--name "NEW"] [--description "DESC"]
 */
import { Command } from 'commander';
import BoardsAPI from '../lib/boards-api';
import FavroHttpClient from '../lib/http-client';
import { resolveApiKey } from '../lib/config';
import { logError, missingApiKeyError } from '../lib/error-handler';

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
        const token = await resolveApiKey();
        if (!token) {
          console.error(`Error: ${missingApiKeyError()}`);
          process.exit(1);
        }

        if (!options.name && !options.description) {
          console.error('✗ No update fields provided. Use --name and/or --description.');
          process.exit(1);
        }

        const updateData: { name?: string; description?: string } = {};
        if (options.name) updateData.name = options.name;
        if (options.description) updateData.description = options.description;

        if (options.dryRun) {
          console.log(`[dry-run] Would update board ${id} with:`, JSON.stringify(updateData));
          return;
        }

        const client = new FavroHttpClient({ auth: { token } });
        const api = new BoardsAPI(client);

        const board = await api.updateBoard(id, updateData);

        console.log(`✓ Board updated: ${board.boardId}`);
        console.log(`  Name: ${board.name}`);
        if (board.description) {
          console.log(`  Description: ${board.description}`);
        }
        console.log(`  Updated: ${board.updatedAt?.slice(0, 10) ?? '—'}`);

        if (options.json) {
          console.log(JSON.stringify(board, null, 2));
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
