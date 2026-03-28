/**
 * Boards Get Command
 * CLA-1784 FAVRO-022: Advanced Boards Endpoints
 *
 * favro boards get <id> [--include custom-fields,cards,members,stats,velocity]
 */
import { Command } from 'commander';
import BoardsAPI, { ExtendedBoard } from '../lib/boards-api';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';

const VALID_INCLUDES = ['custom-fields', 'cards', 'members', 'stats', 'velocity'];

function formatBoardDetails(board: ExtendedBoard): void {
  console.log(`Board: ${board.name} (${board.boardId})`);
  if (board.type) {
    console.log(`Type: ${board.type}`);
  }
  if (board.description) {
    console.log(`Description: ${board.description}`);
  }
  if (board.collectionId) {
    console.log(`Collection: ${board.collectionId}`);
  }
  if (board.cardCount !== undefined) {
    console.log(`Cards: ${board.cardCount}`);
  }
  if (board.columns !== undefined) {
    console.log(`Columns: ${board.columns}`);
  }
  console.log(`Created: ${board.createdAt?.slice(0, 10) ?? '—'}`);
  console.log(`Updated: ${board.updatedAt?.slice(0, 10) ?? '—'}`);

  if (board.members && board.members.length > 0) {
    console.log('\nMembers:');
    const rows = board.members.map(m => ({
      ID: m.userId,
      Name: m.name,
      Email: m.email ?? '—',
      Role: m.role ?? '—',
    }));
    console.table(rows);
  }

  if (board.customFields && board.customFields.length > 0) {
    console.log('\nCustom Fields:');
    const rows = board.customFields.map(f => ({
      ID: f.fieldId,
      Name: f.name,
      Type: f.type,
    }));
    console.table(rows);
  }

  if (board.stats) {
    console.log('\nStats:');
    console.log(`  Total cards:   ${board.stats.totalCards}`);
    console.log(`  Open cards:    ${board.stats.openCards}`);
    console.log(`  Done cards:    ${board.stats.doneCards}`);
    console.log(`  Overdue cards: ${board.stats.overdueCards}`);
  }

  if (board.velocity && board.velocity.length > 0) {
    console.log('\nVelocity (weekly):');
    const rows = board.velocity.map(v => ({
      Period: v.period,
      Completed: v.completed,
      Added: v.added,
      'Net Change': v.netChange,
    }));
    console.table(rows);
  }
}

export function registerBoardsGetCommand(boardsParent: Command): void {
  boardsParent
    .command('get <id>')
    .description('Get a board by ID with optional extended data')
    .option(
      '--include <options>',
      `Comma-separated data to include: ${VALID_INCLUDES.join(', ')}`,
    )
    .option('--json', 'Output as JSON')
    .action(async (id: string, options) => {
      const verbose = boardsParent.parent?.opts()?.verbose ?? false;
      try {

        const include = options.include
          ? options.include.split(',').map((s: string) => s.trim()).filter(Boolean)
          : undefined;

        if (include) {
          const invalid = include.filter((i: string) => !VALID_INCLUDES.includes(i));
          if (invalid.length > 0) {
            console.error(`✗ Invalid include option(s): ${invalid.join(', ')}`);
            console.error(`  Valid options: ${VALID_INCLUDES.join(', ')}`);
            process.exit(1);
          }
        }

        const client = await createFavroClient();
        const api = new BoardsAPI(client);

        const board = await api.getBoardWithIncludes(id, include);

        if (options.json) {
          console.log(JSON.stringify(board, null, 2));
        } else {
          formatBoardDetails(board);
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

export default registerBoardsGetCommand;
