/**
 * Columns Commands
 * CLA-1800 FAVRO-XXX: Columns Endpoints
 *
 * favro columns list <boardId>
 * favro columns create <boardId> --name "New State"
 * favro columns update <columnId> --name "Updated State"
 */
import { Command } from 'commander';
import { Column } from '../lib/columns-api';
import { RefusalError } from '../lib/refusal';
import { checkScope, confirmAction, dryRunLog } from '../lib/safety';
import { Ctx, run } from '../lib/run';

/** The flag row both column writes declare. */
interface ColumnWriteFlags {
  name?: string;
  position?: string;
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
}

export function registerColumnsCommands(program: Command): void {
  const columnsCommand = program.command('columns').description('Manage board columns/workflow states');

  columnsCommand
    .command('list <boardId>')
    .description('List all columns on a board')
    .option('--limit <n>', 'Cap how many rows are printed; sets "truncated"')
    .action(run(async (ctx: Ctx, boardId: string, options: { limit?: string }) => ({
      // The fetch runs to completion; `--limit` cuts the PRINT (#99), and the
      // cut is the runner's now.
      rows: await ctx.api.columns.listColumns(boardId),
      limit: options.limit,
      human: (columns: Column[]) => {
        console.log(`Found ${columns.length} column(s) on board ${boardId}:`);
        // cardCount / timeSum / estimationSum ride along on the same
        // response — rendering them means a per-column count costs no call.
        // All three were measured present on `GET /columns` on 2026-08-12, so an
        // absent one is an anomaly rather than the norm — which is exactly why it
        // reads `—` and not `0`. This is the command `boards get --include stats`
        // now points readers at when it cannot count cards itself, so a fabricated
        // zero here would reinstate, in the remedy, the defect the remedy exists
        // for. `—` is the same sentinel the boards table uses for an absent count.
        // The MACHINE path is untouched: an absent field stays absent there.
        console.table(columns.map(c => ({
          Position: c.position,
          ID: c.columnId,
          Name: c.name,
          Cards: c.cardCount ?? '—',
          Time: c.timeSum ?? '—',
          Estimate: c.estimationSum ?? '—',
        })));
      },
    })));

  columnsCommand
    .command('create <boardId>')
    .description('Create a new column on a board')
    .requiredOption('--name <name>', 'Column name')
    .option('--position <position>', 'Column position (0-indexed)')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass bounds checking')
    .action(run(async (ctx: Ctx, boardId: string, options: ColumnWriteFlags) => {
      await checkScope(boardId, ctx.client, ctx.config, options.force);

      const position = options.position !== undefined ? parseInt(options.position, 10) : undefined;

      if (options.dryRun) {
        dryRunLog('create', 'column', options.name!);
        return;
      }

      if (!(await confirmAction(`Create column "${options.name}" on board ${boardId}?`, { yes: options.yes }))) {
        return { item: { created: false, aborted: true }, human: () => 'Aborted.' };
      }

      return {
        item: await ctx.api.columns.createColumn(boardId, options.name!, position),
        human: (column: Column) => `✓ Column created: ${column.columnId} (${column.name})`,
      };
    }));

  columnsCommand
    .command('update <columnId>')
    .description('Update an existing column')
    .option('--name <name>', 'New column name')
    .option('--position <position>', 'New column position (0-indexed)')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass bounds checking')
    .action(run(async (ctx: Ctx, columnId: string, options: ColumnWriteFlags) => {
      if (!options.name && options.position === undefined) {
        throw new RefusalError('specify --name or --position to update.');
      }

      // Fetch column to check scope via its board
      const colMetadata = await ctx.api.columns.getColumn(columnId);
      await checkScope(colMetadata?.boardId ?? '', ctx.client, ctx.config, options.force);

      const position = options.position !== undefined ? parseInt(options.position, 10) : undefined;

      if (options.dryRun) {
        dryRunLog('update', 'column', columnId);
        return;
      }

      if (!(await confirmAction(`Update column ${columnId}?`, { yes: options.yes }))) {
        return { item: { updated: false, aborted: true }, human: () => 'Aborted.' };
      }

      const data: Record<string, unknown> = {};
      if (options.name) data.name = options.name;
      if (position !== undefined) data.position = position;

      return {
        item: await ctx.api.columns.updateColumn(columnId, data),
        human: (column: Column) => `✓ Column updated: ${column.columnId}`,
      };
    }));
}
