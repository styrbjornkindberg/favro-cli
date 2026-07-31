/**
 * Boards List Command
 * FAVRO-010: Boards List Command with collection filter and table output
 * CLA-1784 FAVRO-022: Enhanced with collection-id arg and --include stats,velocity
 */
import { Command } from 'commander';
import BoardsAPI, { Board, ExtendedBoard, aggregateBoardStats, calculateVelocity } from '../lib/boards-api';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';

export function formatBoardsTable(boards: Board[]): void {
  if (boards.length === 0) {
    console.log('No boards found. Check your API key or collection permissions.');
    return;
  }

  const rows = boards.map(board => ({
    ID: board.boardId,
    Name: (board.name ?? '—').length > 35 ? (board.name ?? '—').slice(0, 32) + '...' : (board.name ?? '—'),
    Cards: board.cardCount ?? '—',
    Columns: board.columns ?? '—',
    Updated: board.updatedAt ? board.updatedAt.slice(0, 10) : '—',
  }));

  console.table(rows);
}

export function formatBoardsExtendedTable(boards: ExtendedBoard[]): void {
  if (boards.length === 0) {
    console.log('No boards found. Check your API key or collection permissions.');
    return;
  }

  const rows = boards.map(board => {
    const row: Record<string, string | number> = {
      ID: board.boardId,
      Name: (board.name ?? '—').length > 30 ? (board.name ?? '—').slice(0, 27) + '...' : (board.name ?? '—'),
      Cards: board.cardCount ?? '—',
      Updated: board.updatedAt ? board.updatedAt.slice(0, 10) : '—',
    };
    if (board.stats) {
      row['Open'] = board.stats.openCards;
      row['Done'] = board.stats.doneCards;
    }
    if (board.velocity && board.velocity.length > 0) {
      const latest = board.velocity[board.velocity.length - 1];
      row['Velocity'] = latest.completed;
    }
    return row;
  });

  console.table(rows);
}

const VALID_LIST_INCLUDES = ['stats', 'velocity'];

export function registerBoardsListCommand(boardsParent: Command): void {
  boardsParent
    .command('list [collection]')
    .description('List all boards, optionally filtered by collection (id or exact name)')
    .option('--collection <collection>', 'Filter boards by collection id or exact name (filtered on the wire)')
    .option(
      '--include <options>',
      'Comma-separated data to include: stats, velocity',
    )
    .option('--json', 'Output as JSON')
    .action(async (collectionId: string | undefined, options) => {
      // Resolve --verbose from the root program (parent of parent)
      const verbose = boardsParent.parent?.opts()?.verbose ?? false;
      try {

        const include = options.include
          ? options.include.split(',').map((s: string) => s.trim()).filter(Boolean)
          : undefined;

        if (include) {
          const invalid = include.filter((i: string) => !VALID_LIST_INCLUDES.includes(i));
          if (invalid.length > 0) {
            console.error(`✗ Invalid --include values: ${invalid.join(', ')}. Valid options: stats, velocity`);
            process.exit(1);
          }
        }

        const client = await createFavroClient();
        const api = new BoardsAPI(client);

        // Positional and --collection are the same filter; both take an id or an
        // exact name and both narrow on the wire.
        const collection: string | undefined = collectionId ?? options.collection;

        let boards: ExtendedBoard[];

        if (collection) {
          boards = await api.listBoardsByCollection(collection, include);
        } else {
          boards = (await api.listBoards(100)).map(b => {
            const ext: ExtendedBoard = { ...b };
            if (include?.includes('stats')) ext.stats = aggregateBoardStats(ext);
            if (include?.includes('velocity')) ext.velocity = calculateVelocity();
            return ext;
          });
        }

        if (options.json) {
          console.log(JSON.stringify(boards, null, 2));
        } else {
          console.log(`Found ${boards.length} board(s):`);
          if (include?.includes('stats') || include?.includes('velocity')) {
            formatBoardsExtendedTable(boards);
          } else {
            formatBoardsTable(boards);
          }
        }
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}

export default registerBoardsListCommand;
