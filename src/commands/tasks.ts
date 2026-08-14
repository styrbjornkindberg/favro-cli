/**
 * Tasks Commands
 * CLA-1803 FAVRO-XXX: Tasks Endpoints
 *
 * favro tasks list <card>
 * favro tasks add <card> "Create new DB schema"
 */
import { Command } from 'commander';
import { Task } from '../lib/tasks-api';
import type FavroHttpClient from '../lib/http-client';
import { readConfig } from '../lib/config';
import { RefusalError } from '../lib/refusal';
import { boardOfCard, checkResolvedScope, confirmAction, dryRunLog, ScopeError } from '../lib/safety';
import { Ctx, run } from '../lib/run';

/** The flag row the task writes share. */
interface TaskWriteFlags {
  name?: string;
  completed?: boolean;
  notCompleted?: boolean;
  position?: string;
  tasklist?: string;
  card?: string;
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
}

/**
 * The shared scope check for the three writes named only by a `taskId`, plus the
 * one remedy only these three know (#126).
 *
 * `assertScope`'s boardless refusal offers two causes and one remedy: the card
 * could not be read, or it has no board instance, so run `favro cards get`. That
 * is right for every other caller, and NEITHER cause is true here when `--card`
 * was omitted — `boardOfCard('')` returns `''` before it spends a request, so no
 * card was read and none was found forkless. The remedy is wrong too: the only id
 * the caller has is a taskId, and `favro cards get` cannot take one. What they
 * need is `--card`, which the generic wording never mentions.
 *
 * So the WORDING is replaced for that one case, and nothing else is. This is not
 * a second refusal path. It cannot refuse a write the shared check would allow —
 * with no lock configured `checkResolvedScope` returns and there is no throw to
 * catch, so the omitted flag stays a no-op exactly as before. It cannot allow one
 * the shared check would refuse — the only statement here is `throw`, and the
 * decision, the `ScopeError` type (so `retryable: false`, #120), the fail-closed
 * `''`, the `--force`-does-not-rescue rule and the exit code all still come from
 * `assertScope`.
 *
 * Gated on `!card`, not on the refusal's empty `boardId`, because `!card` is what
 * makes the new wording TRUE. A caller who passes `--card` at an unreadable or
 * board-less card lands on the same empty `boardId` and keeps the generic message
 * verbatim: there both of its causes are live, its "reported separately" promise
 * is kept by `boardOfCard`, and `cards get` is the right next command. So the
 * out-of-lock refusal — which needs `--card` to have resolved at all — is
 * untouched by construction.
 */
async function checkTaskScope(
  client: FavroHttpClient,
  card: string | undefined,
  force: boolean | undefined,
): Promise<void> {
  try {
    await checkResolvedScope(client, () => boardOfCard(client, card ?? ''), force);
  } catch (error) {
    if (card || !(error instanceof ScopeError)) throw error;

    const config = await readConfig();
    const locked = config?.scopeCollectionName ?? config?.scopeCollectionId ?? error.scopeCollectionId;
    throw new ScopeError(
      `Scope violation: this write names no card, so the scope lock ("${locked}") has no board to check.\n` +
        `  Pass --card <cardCommonId> — the card the task belongs to — and the lock checks its board.\n` +
        `  It cannot be inferred: the id given is a taskId, and Favro's 'GET /tasks/:taskId' is\n` +
        `  UNMEASURED, so this CLI has no verified way to read a task's card (#126).\n` +
        `  --force does not stand in for it: force means "this board is outside the lock, proceed",\n` +
        `  and with no card named there is no board to say that about.`,
      error.boardId,
      error.scopeCollectionId,
    );
  }
}

export function registerTasksCommands(program: Command): void {
  const tasksCommand = program.command('tasks').description('Manage granular checklists inside a single card');

  tasksCommand
    .command('list <card>')
    .description('List all tasks (checklist items) on a card')
    .option('--limit <n>', 'Cap how many rows are printed; sets "truncated"')
    .action(run(async (ctx: Ctx, cardCommonId: string, options: { limit?: string }) => ({
      // The fetch runs to completion; `--limit` cuts the PRINT (#99).
      rows: await ctx.api.tasks.listTasks(cardCommonId),
      limit: options.limit,
      human: (tasks: Task[]) => {
        console.log(`Found ${tasks.length} task(s) on card ${cardCommonId}:`);
        console.table(tasks.map(t => ({
          Status: t.completed ? '[x]' : '[ ]',
          Name: t.name,
          ID: t.taskId,
        })));
      },
    })));

  tasksCommand
    .command('add <card> <name>')
    .description('Create a new task on a card')
    .option('--tasklist <taskListId>', 'Target task list ID (auto-selects first if omitted)')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(run(async (ctx: Ctx, cardCommonId: string, name: string, options: TaskWriteFlags) => {
      await checkResolvedScope(ctx.client, () => boardOfCard(ctx.client, cardCommonId), options.force);

      if (options.dryRun) {
        dryRunLog('add', 'task', name);
        return;
      }

      if (!(await confirmAction(`Add task "${name}" to card ${cardCommonId}?`, { yes: options.yes }))) {
        return;
      }

      let taskListId = options.tasklist;
      if (!taskListId) {
        // Auto-select first task list, or create a default one
        const lists = await ctx.api.tasklists.listTaskLists(cardCommonId);
        if (lists.length > 0) {
          taskListId = lists[0].taskListId;
        } else {
          const newList = await ctx.api.tasklists.createTaskList(cardCommonId, 'Checklist');
          taskListId = newList.taskListId;
        }
      }

      return {
        item: await ctx.api.tasks.createTask(cardCommonId, name, taskListId),
        human: (task: Task) => `✓ Task created: ${task.taskId} (${task.name})`,
      };
    }));

  tasksCommand
    .command('update <taskId>')
    .description('Update a task (rename, reposition, toggle completion)')
    .option('--name <name>', 'New task name')
    .option('--completed', 'Mark as completed')
    .option('--not-completed', 'Mark as not completed')
    .option('--position <number>', 'New position (0-based)')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    // A taskId names no card, and so no board. `TasksAPI` has no `getTask` and
    // Favro's `GET /tasks/:taskId` is UNMEASURED — this repo does not guess at
    // wire behaviour, so the card comes from the caller instead. Omitted, the
    // board resolves to '' and the shared check refuses under a lock: the write
    // is uncheckable, not exempt. Without a lock it stays a no-op. `checkTaskScope`
    // is that shared check; it only rewords the refusal to name this flag (#126).
    //
    // KNOWN CEILING (#104): the taskId is never verified to belong to the card
    // named by `--card`, because verifying it is exactly the read that does not
    // exist. So a caller can point `--card` at an in-scope card and mutate a
    // task on another — a bypass no louder than `--force`, and unlike `--force`
    // it prints no warning. This is weaker than every other site's check, which
    // resolves the board FROM the thing being written. Upgrade path: measure
    // `GET /tasks/:taskId`; if it carries `cardCommonId`, delete this flag and
    // resolve like everywhere else.
    .option('--card <card>', 'Card the task belongs to — required under a scope lock, since a taskId names no board')
    .action(run(async (ctx: Ctx, taskId: string, options: TaskWriteFlags) => {
      const updateData: { name?: string; completed?: boolean; position?: number } = {};
      if (options.name) updateData.name = options.name;
      if (options.completed) updateData.completed = true;
      if (options.notCompleted) updateData.completed = false;
      if (options.position !== undefined) updateData.position = parseInt(options.position, 10);

      if (Object.keys(updateData).length === 0) {
        throw new RefusalError('Provide at least one field: --name, --completed, --not-completed, or --position');
      }

      await checkTaskScope(ctx.client, options.card, options.force);

      if (options.dryRun) {
        dryRunLog('update', 'task', taskId, updateData);
        return;
      }

      if (!(await confirmAction(`Update task ${taskId}?`, { yes: options.yes }))) {
        return;
      }

      return {
        item: await ctx.api.tasks.updateTask(taskId, updateData),
        human: (task: Task) => `✓ Task updated: ${task.taskId} (${task.name})`,
      };
    }));

  tasksCommand
    .command('complete <taskId>')
    .description('Mark a task as completed')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .option('--card <card>', 'Card the task belongs to — required under a scope lock, since a taskId names no board')
    .action(run(async (ctx: Ctx, taskId: string, options: TaskWriteFlags) => {
      await checkTaskScope(ctx.client, options.card, options.force);

      if (options.dryRun) {
        dryRunLog('complete', 'task', taskId);
        return;
      }

      if (!(await confirmAction(`Complete task ${taskId}?`, { yes: options.yes }))) {
        return;
      }

      return {
        item: await ctx.api.tasks.updateTask(taskId, true),
        human: (task: Task) => `✓ Task completed: ${task.taskId}`,
      };
    }));

  tasksCommand
    .command('delete <taskId>')
    .description('Delete a task from a card')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .option('--card <card>', 'Card the task belongs to — required under a scope lock, since a taskId names no board')
    .action(run(async (ctx: Ctx, taskId: string, options: TaskWriteFlags) => {
      await checkTaskScope(ctx.client, options.card, options.force);

      if (options.dryRun) {
        dryRunLog('delete', 'task', taskId);
        return;
      }

      if (!(await confirmAction(`Delete task ${taskId}? This cannot be undone.`, { yes: options.yes }))) {
        return;
      }

      await ctx.api.tasks.deleteTask(taskId);

      return { item: { deleted: true, taskId }, human: () => `✓ Task deleted: ${taskId}` };
    }));
}
