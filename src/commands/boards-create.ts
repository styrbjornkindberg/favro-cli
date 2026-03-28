/**
 * Boards Create Command
 * CLA-1784 FAVRO-022: Advanced Boards Endpoints
 *
 * favro boards create <collection-id> --name "NAME" [--type board|list|kanban]
 */
import { Command } from 'commander';
import BoardsAPI, { BoardType } from '../lib/boards-api';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';

const VALID_TYPES: BoardType[] = ['board', 'list', 'kanban'];

export function registerBoardsCreateCommand(boardsParent: Command): void {
  boardsParent
    .command('create <collection-id>')
    .description('Create a new board in a collection')
    .requiredOption('--name <name>', 'Board name')
    .option('--type <type>', 'Board type: board, list, or kanban', 'board')
    .option('--description <text>', 'Board description')
    .option('--json', 'Output created board as JSON')
    .option('--dry-run', 'Print what would be created without making API calls')
    .option('--force', 'Bypass scope check')
    .action(async (collectionId: string, options) => {
      const verbose = boardsParent.parent?.opts()?.verbose ?? false;
      try {

        const boardType = options.type as BoardType;
        if (!VALID_TYPES.includes(boardType)) {
          console.error(`✗ Invalid board type: "${options.type}". Use: ${VALID_TYPES.join(', ')}`);
          process.exit(1);
        }

        const name = (options.name || '').trim();
        if (!name) {
          console.error('✗ Board name cannot be empty or whitespace only.');
          process.exit(1);
        }

        const { readConfig } = await import('../lib/config');
        const { checkCollectionScope } = await import('../lib/safety');
        checkCollectionScope(collectionId, await readConfig(), options.force);

        if (options.dryRun) {
          console.log(`[dry-run] Would create board: "${name}"`);
          console.log(`[dry-run] Collection: ${collectionId}`);
          console.log(`[dry-run] Type: ${boardType}`);
          if (options.description) {
            console.log(`[dry-run] Description: "${options.description}"`);
          }
          return;
        }

        const client = await createFavroClient();
        const api = new BoardsAPI(client);

        const board = await api.createBoardInCollection(collectionId, {
          name,
          type: boardType,
          description: options.description,
        });

        if (options.json) {
          console.log(JSON.stringify(board, null, 2));
        } else {
          console.log(`✓ Board created: ${board.boardId}`);
          console.log(`  Name: ${board.name}`);
          console.log(`  Type: ${board.type ?? boardType}`);
          console.log(`  Collection: ${board.collectionId ?? collectionId}`);
          if (board.description) {
            console.log(`  Description: ${board.description}`);
          }
        }
      } catch (error: any) {
        if (error?.response?.status === 404) {
          console.error(`✗ Collection not found: ${collectionId}`);
          process.exit(1);
        }
        logError(error, verbose);
        process.exit(1);
      }
    });
}

export default registerBoardsCreateCommand;
