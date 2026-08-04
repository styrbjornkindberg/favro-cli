/**
 * Boards Update Command
 * CLA-1784 FAVRO-022: Advanced Boards Endpoints
 *
 * favro boards update <id> [--name "NEW"] [--description "DESC"]
 */
import { Command } from 'commander';
import { Board } from '../lib/boards-api';
import { checkScope, confirmAction } from '../lib/safety';
import { run } from '../lib/run';

interface UpdateOptions {
  name?: string;
  description?: string;
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
}

export function registerBoardsUpdateCommand(boardsParent: Command): void {
  boardsParent
    .command('update <id>')
    .description('Update an existing board')
    .option('--name <name>', 'New board name')
    .option('--description <text>', 'New board description')
    .option('--dry-run', 'Preview the update. Reads the board first to check the scope lock')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(run(async (ctx, id: string, options: UpdateOptions) => {
      const name = options.name?.trim();
      if (options.name && !name) {
        throw new Error('Board name cannot be empty or whitespace-only');
      }
      const description = options.description?.trim();

      if (!name && !description) {
        throw new Error('No update fields provided. Use --name or --description.');
      }

      const updateData: { name?: string; description?: string } = {};
      if (name) updateData.name = name;
      if (description) updateData.description = description;

      // The lock runs before the preview, gated on a configured lock — see
      // `boards-delete.ts` for why the gate is required rather than tidy. Placed
      // AFTER the argument validation above so an empty `--name` still answers
      // `Board name cannot be empty…` credential-free, which is the property
      // ADR-0002's #135 amendment names ("flag validation reaches the user
      // credential-free"); hoisting the guard over it would trade one wrong answer
      // for another.
      if (ctx.config?.scopeCollectionId) {
        await checkScope(id, ctx.client, ctx.config, options.force);
      }

      if (options.dryRun) {
        console.log(`[dry-run] Would update board ${id} with:`, JSON.stringify(updateData));
        return;
      }

      if (!(await confirmAction(`Update board ${id}?`, { yes: options.yes }))) {
        console.log('Aborted.');
        return;
      }

      // A 404 here names the BOARD; "Not Found" off the wire does not say which.
      const board = await ctx.api.boards.updateBoard(id, updateData).catch((error: any) => {
        if (error?.response?.status === 404) throw new Error(`Board not found: ${id}`);
        throw error;
      });

      return {
        item: board,
        human: (updated: Board) => {
          console.log(`✓ Board updated: ${updated.boardId}`);
          console.log(`  Name: ${updated.name}`);
          if (updated.description) {
            console.log(`  Description: ${updated.description}`);
          }
          console.log(`  Updated: ${updated.updatedAt?.slice(0, 10) ?? '—'}`);
        },
      };
    }));
}

export default registerBoardsUpdateCommand;
