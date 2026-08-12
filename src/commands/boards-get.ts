/**
 * Boards Get Command
 * CLA-1784 FAVRO-022: Advanced Boards Endpoints
 *
 * favro boards get <id> [--include custom-fields,cards,members,stats,velocity]
 */
import { Command } from 'commander';
import { ExtendedBoard, shown } from '../lib/boards-api';
import { run } from '../lib/run';

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
    console.log(`  Total cards:   ${shown(board.stats.totalCards)}`);
    console.log(`  Open cards:    ${shown(board.stats.openCards)}`);
    console.log(`  Done cards:    ${shown(board.stats.doneCards)}`);
    console.log(`  Overdue cards: ${shown(board.stats.overdueCards)}`);
  }

  if (board.velocity && board.velocity.length > 0) {
    console.log('\nVelocity (weekly):');
    const rows = board.velocity.map(v => ({
      Period: v.period,
      Completed: shown(v.completed),
      Added: shown(v.added),
      'Net Change': shown(v.netChange),
    }));
    console.table(rows);
  }

  // One note for both sections. It is set exactly when a facet above came back
  // unknown, so the section is never printed as a wall of `unknown` with no
  // explanation of what to run instead (ADR-0002).
  if (board.unmeasured) {
    console.log(`\nNote: ${board.unmeasured}`);
  }
}

export function registerBoardsGetCommand(boardsParent: Command): void {
  boardsParent
    .command('get <board>')
    .description('Get a board by id or exact name (trimmed, case-insensitive) with optional extended data')
    .option(
      '--include <options>',
      `Comma-separated data to include: ${VALID_INCLUDES.join(', ')}`,
    )
    // No bare "not found" arm: BoardsAPI already classified the failure and
    // resolution refusals carry their own candidate list, so the runner's error
    // boundary is the whole of it.
    .action(run(async (ctx, id: string, options: { include?: string }) => {
      const include = options.include
        ? options.include.split(',').map((s: string) => s.trim()).filter(Boolean)
        : undefined;

      if (include) {
        const invalid = include.filter((i: string) => !VALID_INCLUDES.includes(i));
        if (invalid.length > 0) {
          throw new Error(
            `Invalid include option(s): ${invalid.join(', ')}\n` +
            `  Valid options: ${VALID_INCLUDES.join(', ')}`,
          );
        }
      }

      return { item: await ctx.api.boards.getBoardWithIncludes(id, include), human: formatBoardDetails };
    }));
}

export default registerBoardsGetCommand;
