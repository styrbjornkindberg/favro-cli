/**
 * Boards List Command
 * FAVRO-010: Boards List Command with collection filter and table output
 * CLA-1784 FAVRO-022: Enhanced with collection-id arg and --include stats,velocity
 */
import { Command } from 'commander';
import { Board, ExtendedBoard, MeasuredCount, withBoardIncludes } from '../lib/boards-api';
import { Ctx, run } from '../lib/run';

/**
 * A count nothing measured prints as `unknown`, never as a number. `boards-api.ts`
 * explains which facets have no source and why; this is the render half of it.
 */
const shown = (value: MeasuredCount): string | number => value ?? 'unknown';

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
      row['Open'] = shown(board.stats.openCards);
      row['Done'] = shown(board.stats.doneCards);
    }
    if (board.velocity && board.velocity.length > 0) {
      const latest = board.velocity[board.velocity.length - 1];
      row['Velocity'] = shown(latest.completed);
    }
    return row;
  });

  console.table(rows);

  // One note under the table, not one per row: the reason is a property of the
  // endpoint, so every board on the page carries the same string. Dropping the
  // columns instead would be its own defect — the reader asked for them.
  const note = boards.find(b => b.unmeasured)?.unmeasured;
  if (note) {
    console.log(`Note: ${note}`);
  }
}

const VALID_LIST_INCLUDES = ['stats', 'velocity'];

interface ListOptions {
  collection?: string;
  include?: string;
  limit?: string;
}

/**
 * Exported so a test can call it with a fake `Ctx` and read the `Result` back —
 * no stdout capture, no `http-client` mock. That is the seam ADR-0002 is for,
 * and this is the batch's worked example of it (#114).
 */
export async function listBoardsHandler(
  ctx: Ctx,
  collectionId: string | undefined,
  options: ListOptions,
) {
  const include = options.include
    ? options.include.split(',').map((s: string) => s.trim()).filter(Boolean)
    : undefined;

  if (include) {
    const invalid = include.filter((i: string) => !VALID_LIST_INCLUDES.includes(i));
    if (invalid.length > 0) {
      throw new Error(`Invalid --include values: ${invalid.join(', ')}. Valid options: stats, velocity`);
    }
  }

  // Positional and --collection are the same filter; both take an id or an
  // exact name and both narrow on the wire.
  const collection: string | undefined = collectionId ?? options.collection;

  const boards: ExtendedBoard[] = collection
    ? await ctx.api.boards.listBoardsByCollection(collection, include)
    : (await ctx.api.boards.listBoards(100)).map(b => withBoardIncludes({ ...b }, include));

  // A list read: the runner writes the envelope, compact, and applies the cap.
  // `boards` has no bulk field to omit, so the cost here is row count alone —
  // which is exactly what `--limit` answers, and 322 rows is the measured worst
  // case (#99).
  return {
    rows: boards,
    limit: options.limit,
    human: (rows: ExtendedBoard[]) => {
      console.log(`Found ${rows.length} board(s):`);
      if (include?.includes('stats') || include?.includes('velocity')) {
        formatBoardsExtendedTable(rows);
      } else {
        formatBoardsTable(rows);
      }
    },
  };
}

export function registerBoardsListCommand(boardsParent: Command): void {
  boardsParent
    .command('list [collection]')
    .description('List all boards, optionally filtered by collection (id or exact name)')
    .option('--collection <collection>', 'Filter boards by collection id or exact name (filtered on the wire)')
    .option(
      '--include <options>',
      'Comma-separated data to include: stats, velocity',
    )
    .option('--limit <n>', 'Cap how many rows are printed; sets "truncated"')
    .action(run(listBoardsHandler));
}

export default registerBoardsListCommand;
