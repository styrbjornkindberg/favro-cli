/**
 * Boards List Command
 * FAVRO-010: Boards List Command with collection filter and table output
 * CLA-1784 FAVRO-022: Enhanced with collection-id arg and --include stats,velocity
 */
import { Command } from 'commander';
import BoardsAPI, { Board, Collection, ExtendedBoard, aggregateBoardStats, calculateVelocity } from '../lib/boards-api';
import FavroHttpClient from '../lib/http-client';
import { resolveApiKey } from '../lib/config';
import { logError, missingApiKeyError } from '../lib/error-handler';

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

/**
 * Filter boards by collection name (case-insensitive substring match).
 * Warns if multiple collections match.
 * Returns empty array if no match found.
 */
export function filterBoardsByCollection(boards: Board[], collections: Collection[], collectionName: string): Board[] {
  const lc = collectionName.trim().toLowerCase();
  const matches = collections.filter(c => c.name.toLowerCase().includes(lc));

  if (matches.length === 0) {
    return [];
  }

  if (matches.length > 1) {
    console.warn(`⚠️ Multiple collections match "${collectionName}": ${matches.map(c => c.name).join(', ')}`);
    console.log(`Using first match: "${matches[0].name}"\n`);
  }

  const matched = matches[0];
  return boards.filter(b => b.collectionId === matched.collectionId);
}

export function registerBoardsListCommand(boardsParent: Command): void {
  boardsParent
    .command('list [collection-id]')
    .description('List all boards, optionally filtered by collection ID')
    .option('--collection <name>', 'Filter boards by collection name (use instead of collection-id arg)')
    .option(
      '--include <options>',
      'Comma-separated data to include: stats, velocity',
    )
    .option('--json', 'Output as JSON')
    .action(async (collectionId: string | undefined, options) => {
      // Resolve --verbose from the root program (parent of parent)
      const verbose = boardsParent.parent?.opts()?.verbose ?? false;
      try {
        const token = await resolveApiKey();
        if (!token) {
          console.error(`Error: ${missingApiKeyError()}`);
          process.exit(1);
        }

        const include = options.include
          ? options.include.split(',').map((s: string) => s.trim()).filter(Boolean)
          : undefined;

        const client = new FavroHttpClient({ auth: { token } });
        const api = new BoardsAPI(client);

        let boards: ExtendedBoard[];

        if (collectionId) {
          // Use collection-id positional argument for advanced listing
          boards = await api.listBoardsByCollection(collectionId, include);
        } else {
          // Legacy path: list all boards, optionally filter by collection name
          const rawBoards = await api.listBoards(100);

          if (options.collection) {
            const collections = await api.listCollections(100);
            const filtered = filterBoardsByCollection(rawBoards, collections, options.collection);
            if (filtered.length === 0) {
              const names = collections.map(c => `"${c.name}"`).join(', ');
              console.error(`✗ No boards found in collection "${options.collection}".`);
              if (names) console.error(`  Available collections: ${names}`);
              process.exit(1);
            }
            boards = filtered.map(b => {
              const ext: ExtendedBoard = { ...b };
              if (include?.includes('stats')) ext.stats = aggregateBoardStats(ext);
              if (include?.includes('velocity')) ext.velocity = calculateVelocity();
              return ext;
            });
          } else {
            boards = rawBoards.map(b => {
              const ext: ExtendedBoard = { ...b };
              if (include?.includes('stats')) ext.stats = aggregateBoardStats(ext);
              if (include?.includes('velocity')) ext.velocity = calculateVelocity();
              return ext;
            });
          }
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
