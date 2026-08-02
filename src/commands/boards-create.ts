/**
 * Boards Create Command
 * CLA-1784 FAVRO-022: Advanced Boards Endpoints
 *
 * favro boards create <collection-id> --name "NAME" [--type board|list|kanban]
 */
import { Command } from 'commander';
import { Board, BoardType } from '../lib/boards-api';
import { checkCollectionScope } from '../lib/safety';
import { run } from '../lib/run';

const VALID_TYPES: BoardType[] = ['board', 'list', 'kanban'];

interface CreateOptions {
  name: string;
  type: string;
  description?: string;
  dryRun?: boolean;
  force?: boolean;
}

export function registerBoardsCreateCommand(boardsParent: Command): void {
  boardsParent
    .command('create <collection-id>')
    .description('Create a new board in a collection')
    .requiredOption('--name <name>', 'Board name')
    .option('--type <type>', 'Board type: board, list, or kanban', 'board')
    .option('--description <text>', 'Board description')
    .option('--dry-run', 'Print what would be created without making API calls')
    .option('--force', 'Bypass scope check')
    .action(run(async (ctx, collectionId: string, options: CreateOptions) => {
      const boardType = options.type as BoardType;
      if (!VALID_TYPES.includes(boardType)) {
        throw new Error(`Invalid board type: "${options.type}". Use: ${VALID_TYPES.join(', ')}`);
      }

      const name = (options.name || '').trim();
      if (!name) {
        throw new Error('Board name cannot be empty or whitespace only.');
      }

      checkCollectionScope(collectionId, ctx.config, options.force);

      if (options.dryRun) {
        console.log(`[dry-run] Would create board: "${name}"`);
        console.log(`[dry-run] Collection: ${collectionId}`);
        console.log(`[dry-run] Type: ${boardType}`);
        if (options.description) {
          console.log(`[dry-run] Description: "${options.description}"`);
        }
        return;
      }

      // The one arm the runner's boundary cannot word for itself: a 404 here
      // names the COLLECTION, and "Not Found" off the wire does not say which.
      const board = await ctx.api.boards
        .createBoardInCollection(collectionId, {
          name,
          type: boardType,
          description: options.description,
        })
        .catch((error: any) => {
          if (error?.response?.status === 404) throw new Error(`Collection not found: ${collectionId}`);
          throw error;
        });

      return {
        item: board,
        human: (created: Board) => {
          console.log(`✓ Board created: ${created.boardId}`);
          console.log(`  Name: ${created.name}`);
          console.log(`  Type: ${created.type ?? boardType}`);
          console.log(`  Collection: ${created.collectionId ?? collectionId}`);
          if (created.description) {
            console.log(`  Description: ${created.description}`);
          }
        },
      };
    }));
}

export default registerBoardsCreateCommand;
