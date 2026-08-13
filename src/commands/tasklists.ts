/**
 * Tasklists Commands
 *
 * favro tasklists list <card>
 * favro tasklists get <taskListId>
 * favro tasklists create <card> --name "Checklist"
 * favro tasklists update <taskListId> --name "New name"
 * favro tasklists delete <taskListId>
 */
import { Command } from 'commander';
import { TaskList } from '../lib/tasklists-api';
import { RefusalError } from '../lib/refusal';
import { boardOfCard, checkResolvedScope, confirmAction, dryRunLog } from '../lib/safety';
import { Ctx, run } from '../lib/run';

/** The flag row the task-list writes share. */
interface TaskListWriteFlags {
  name?: string;
  position?: string;
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
}

/**
 * Board for a task list — two hops (task list → card → board). The card hop is
 * the shared `boardOfCard`, which owns the wrap-report-fail-closed policy; only
 * the extra hop lives here, wrapped for the same reason.
 *
 * Takes the whole `Ctx` since #119 rather than a bare client: the task-list read
 * is `ctx.api.tasklists` now, and the card hop still needs `ctx.client`.
 */
async function boardOfTaskList(taskListId: string, ctx: Ctx): Promise<string> {
  try {
    const list = await ctx.api.tasklists.getTaskList(taskListId);
    return await boardOfCard(ctx.client, list.cardCommonId);
  } catch {
    return '';
  }
}

export function registerTaskListsCommands(program: Command): void {
  const cmd = program.command('tasklists').description('Manage checklist groups (task lists) on cards');

  cmd
    .command('list <card>')
    .description('List all task lists on a card')
    .option('--limit <n>', 'Cap how many rows are printed; sets "truncated"')
    .action(run(async (ctx: Ctx, cardCommonId: string, options: { limit?: string }) => ({
      // The fetch runs to completion; `--limit` cuts the PRINT (#99).
      rows: await ctx.api.tasklists.listTaskLists(cardCommonId),
      limit: options.limit,
      human: (lists: TaskList[]) => {
        console.log(`Found ${lists.length} task list(s) on card ${cardCommonId}:`);
        console.table(lists.map(l => ({
          ID: l.taskListId,
          Name: l.name,
          Position: l.position ?? '—',
        })));
      },
    })));

  cmd
    .command('get <taskListId>')
    .description('Get a task list by ID')
    .action(run(async (ctx: Ctx, taskListId: string) => ({
      item: await ctx.api.tasklists.getTaskList(taskListId),
      human: (list: TaskList) =>
        [
          `Task List: ${list.name} (${list.taskListId})`,
          `Card: ${list.cardCommonId}`,
          ...(list.position !== undefined ? [`Position: ${list.position}`] : []),
        ].join('\n'),
    })));

  cmd
    .command('create <card>')
    .description('Create a new task list on a card')
    .requiredOption('--name <name>', 'Task list name')
    .option('--position <number>', 'Position (0-based)')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(run(async (ctx: Ctx, cardCommonId: string, options: TaskListWriteFlags) => {
      await checkResolvedScope(ctx.client, () => boardOfCard(ctx.client, cardCommonId), options.force);

      if (options.dryRun) {
        dryRunLog('creating', 'task list', `"${options.name}" on card ${cardCommonId}`);
        return;
      }

      if (!(await confirmAction(`Create task list "${options.name}" on card ${cardCommonId}?`, { yes: options.yes }))) {
        return;
      }

      const pos = options.position !== undefined ? parseInt(options.position, 10) : undefined;

      return {
        item: await ctx.api.tasklists.createTaskList(cardCommonId, options.name!, pos),
        human: (list: TaskList) => `✓ Task list created: ${list.taskListId} (${list.name})`,
      };
    }));

  cmd
    .command('update <taskListId>')
    .description('Update a task list (rename or reposition)')
    .option('--name <name>', 'New task list name')
    .option('--position <number>', 'New position (0-based)')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(run(async (ctx: Ctx, taskListId: string, options: TaskListWriteFlags) => {
      const updateData: { name?: string; position?: number } = {};
      if (options.name) updateData.name = options.name;
      if (options.position !== undefined) updateData.position = parseInt(options.position, 10);

      if (Object.keys(updateData).length === 0) {
        throw new RefusalError('Error: Provide at least one field: --name or --position');
      }

      await checkResolvedScope(ctx.client, () => boardOfTaskList(taskListId, ctx), options.force);

      if (options.dryRun) {
        dryRunLog('updating', 'task list', taskListId, updateData);
        return;
      }

      if (!(await confirmAction(`Update task list ${taskListId}?`, { yes: options.yes }))) {
        return;
      }

      return {
        item: await ctx.api.tasklists.updateTaskList(taskListId, updateData),
        human: (list: TaskList) => `✓ Task list updated: ${list.taskListId} (${list.name})`,
      };
    }));

  cmd
    .command('delete <taskListId>')
    .description('Delete a task list')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(run(async (ctx: Ctx, taskListId: string, options: TaskListWriteFlags) => {
      await checkResolvedScope(ctx.client, () => boardOfTaskList(taskListId, ctx), options.force);

      if (options.dryRun) {
        dryRunLog('deleting', 'task list', taskListId);
        return;
      }

      if (!(await confirmAction(`Delete task list ${taskListId}? This cannot be undone.`, { yes: options.yes }))) {
        return;
      }

      await ctx.api.tasklists.deleteTaskList(taskListId);

      return { item: { deleted: true, taskListId }, human: () => `✓ Task list deleted: ${taskListId}` };
    }));
}
