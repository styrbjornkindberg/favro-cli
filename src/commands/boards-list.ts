/**
 * Boards List Command
 * FAVRO-010: Boards List Command with collection filter and table output
 */
import { Command } from 'commander';
import BoardsAPI, { Board, Collection } from '../lib/boards-api';
import FavroHttpClient from '../lib/http-client';
import { resolveApiKey } from '../lib/config';

export function formatBoardsTable(boards: Board[]): void {
  if (boards.length === 0) {
    console.log('No boards found.');
    return;
  }

  const rows = boards.map(board => ({
    ID: board.boardId,
    Name: board.name.length > 35 ? board.name.slice(0, 32) + '...' : board.name,
    Cards: board.cardCount ?? '—',
    Columns: board.columns ?? '—',
    Updated: board.updatedAt ? board.updatedAt.slice(0, 10) : '—',
  }));

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
    .command('list')
    .description('List all boards in the default or specified collection')
    .option('--collection <name>', 'Filter boards by collection name')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const token = await resolveApiKey();
        if (!token) {
          console.error('✗ API key not configured. Run `favro auth login` or set FAVRO_API_KEY.');
          process.exit(1);
        }

        const client = new FavroHttpClient({ auth: { token } });
        const api = new BoardsAPI(client);

        let boards = await api.listBoards(100);

        if (options.collection) {
          const collections = await api.listCollections(100);
          const filtered = filterBoardsByCollection(boards, collections, options.collection);
          if (filtered.length === 0) {
            const names = collections.map(c => `"${c.name}"`).join(', ');
            console.error(`✗ No boards found in collection "${options.collection}".`);
            if (names) console.error(`  Available collections: ${names}`);
            process.exit(1);
          }
          boards = filtered;
        }

        if (options.json) {
          console.log(JSON.stringify(boards, null, 2));
        } else {
          console.log(`Found ${boards.length} board(s):`);
          formatBoardsTable(boards);
        }
      } catch (error) {
        console.error(`✗ Error: ${error instanceof Error ? error.message : error}`);
        process.exit(1);
      }
    });
}

export default registerBoardsListCommand;
