/**
 * Boards Delete Command
 *
 * favro boards delete <id> [--yes] [--force]
 */
import { Command } from 'commander';
import { checkScope, confirmAction } from '../lib/safety';
import { run } from '../lib/run';

interface DeleteOptions {
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
}

export function registerBoardsDeleteCommand(boardsParent: Command): void {
  boardsParent
    .command('delete <id>')
    .description('Delete a board (destructive — cannot be undone)')
    .option('--dry-run', 'Preview the delete. Reads the board first to check the scope lock')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(run(async (ctx, id: string, options: DeleteOptions) => {
      // The lock runs BEFORE the preview (#152). It used to run after, so a board
      // outside the locked collection previewed cheerfully at exit 0 and the real
      // run refused — a preview promising an action the guardrail will not allow,
      // which is worse than no preview at all. #103/#104 settled this order for
      // `members add` and the `batch` writes; these four never implemented it.
      //
      // GATED ON A CONFIGURED LOCK, and that is not a micro-optimisation. `ctx.client`
      // is an ARGUMENT here, so it is evaluated before `checkScope` can decide it has
      // nothing to do — and under #135 a `--dry-run` context resolves `ctx.client`
      // through a getter that RE-THROWS the missing-credential refusal on first touch.
      // Ungated, this would charge a credential check to a user with no lock at all,
      // for a verdict there is no lock to produce: ADR-0002's measured example
      // (`FAVRO_API_KEY= favro boards delete board-1 --dry-run` → exit 0) would become
      // false, and #102/#104's "no behaviour change when no lock is configured" with
      // it. Under a lock the preview genuinely reaches for the wire and pays for it,
      // which is exactly what #135's rule asks. Same shape as `checkResolvedScope`,
      // which exists for this evaluation-order reason and cannot be reused here: its
      // `client` parameter is eager too.
      if (ctx.config?.scopeCollectionId) {
        await checkScope(id, ctx.client, ctx.config, options.force);
      }

      if (options.dryRun) {
        console.log(`[dry-run] Would delete board ${id}`);
        return;
      }

      if (!(await confirmAction(`Delete board ${id}? This cannot be undone.`, { yes: options.yes }))) {
        console.log('Aborted.');
        return;
      }

      await ctx.api.boards.deleteBoard(id).catch((error: any) => {
        if (error?.response?.status === 404) {
          throw new Error(`Board not found: ${id}. Use 'favro boards list' to see available boards.`);
        }
        throw error;
      });

      // The delete had no machine path at all before, so this invents one
      // rather than replacing one. It has to: with JSON the default, the
      // streaming arm would put `✓ Board deleted: …` on an agent's stdout and
      // make the group's contract inconsistent on day one — `boards update`
      // parses, `boards delete` throws. The human line is unchanged.
      return {
        item: { deleted: true, boardId: id },
        human: () => console.log(`✓ Board deleted: ${id}`),
      };
    }));
}

export default registerBoardsDeleteCommand;
