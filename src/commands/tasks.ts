/**
 * Tasks Commands
 * CLA-1803 FAVRO-XXX: Tasks Endpoints
 *
 * favro tasks list <card>
 * favro tasks add <card> "Create new DB schema"
 */
import { Command } from 'commander';
import TasksAPI from '../lib/tasks-api';
import TaskListsAPI from '../lib/tasklists-api';
import CardsAPI from '../lib/cards-api';
import { createFavroClient } from '../lib/client-factory';
import { readConfig } from '../lib/config';
import { logError } from '../lib/error-handler';
import { boardOfCard, checkResolvedScope, confirmAction, dryRunLog } from '../lib/safety';
import { capRows, noteTruncation, writeEnvelope } from '../lib/read-shape';

export function registerTasksCommands(program: Command): void {
  const tasksCommand = program.command('tasks').description('Manage granular checklists inside a single card');

  tasksCommand
    .command('list <card>')
    .description('List all tasks (checklist items) on a card')
    .option('--limit <n>', 'Cap how many rows are printed; sets "truncated"')
    .option('--json', 'Output as JSON')
    .action(async (cardCommonId: string, options) => {
      const verbose = tasksCommand.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const api = new TasksAPI(client);
        const tasks = await api.listTasks(cardCommonId);
        // The fetch already ran to completion; `--limit` cuts the PRINT (#99).
        const envelope = capRows(tasks, options.limit);

        if (options.json) {
          writeEnvelope(envelope, Boolean(program.opts()?.pretty));
        } else {
          console.log(`Found ${envelope.rows.length} task(s) on card ${cardCommonId}:`);
          const rows = envelope.rows.map(t => ({
            Status: t.completed ? '[x]' : '[ ]',
            Name: t.name,
            ID: t.taskId,
          }));
          console.table(rows);
          noteTruncation(envelope, tasks.length);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  tasksCommand
    .command('add <card> <name>')
    .description('Create a new task on a card')
    .option('--tasklist <taskListId>', 'Target task list ID (auto-selects first if omitted)')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(async (cardCommonId: string, name: string, options) => {
      const verbose = tasksCommand.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        await checkResolvedScope(client, () => boardOfCard(client, cardCommonId), options.force);

        if (options.dryRun) {
          dryRunLog('adding', 'task', `"${name}" to card ${cardCommonId}`);
          process.exit(0);
        }

        if (!(await confirmAction(`Add task "${name}" to card ${cardCommonId}?`, { yes: options.yes }))) {
          process.exit(0);
        }

        const api = new TasksAPI(client);
        const taskListsApi = new TaskListsAPI(client);

        let taskListId = options.tasklist;
        if (!taskListId) {
          // Auto-select first task list, or create a default one
          const lists = await taskListsApi.listTaskLists(cardCommonId);
          if (lists.length > 0) {
            taskListId = lists[0].taskListId;
          } else {
            const newList = await taskListsApi.createTaskList(cardCommonId, 'Checklist');
            taskListId = newList.taskListId;
          }
        }

        const task = await api.createTask(cardCommonId, name, taskListId);

        if (options.json) {
          console.log(JSON.stringify(task, null, 2));
        } else {
          console.log(`✓ Task created: ${task.taskId} (${task.name})`);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  tasksCommand
    .command('update <taskId>')
    .description('Update a task (rename, reposition, toggle completion)')
    .option('--name <name>', 'New task name')
    .option('--completed', 'Mark as completed')
    .option('--not-completed', 'Mark as not completed')
    .option('--position <number>', 'New position (0-based)')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    // A taskId names no card, and so no board. `TasksAPI` has no `getTask` and
    // Favro's `GET /tasks/:taskId` is UNMEASURED — this repo does not guess at
    // wire behaviour, so the card comes from the caller instead. Omitted, the
    // board resolves to '' and the shared check refuses under a lock: the write
    // is uncheckable, not exempt. Without a lock it stays a no-op.
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
    .action(async (taskId: string, options) => {
      const verbose = tasksCommand.opts()?.verbose ?? false;
      try {
        const updateData: { name?: string; completed?: boolean; position?: number } = {};
        if (options.name) updateData.name = options.name;
        if (options.completed) updateData.completed = true;
        if (options.notCompleted) updateData.completed = false;
        if (options.position !== undefined) updateData.position = parseInt(options.position, 10);

        if (Object.keys(updateData).length === 0) {
          console.error('Error: Provide at least one field: --name, --completed, --not-completed, or --position');
          process.exit(1);
        }

        const client = await createFavroClient();
        await checkResolvedScope(client, () => boardOfCard(client, options.card), options.force);

        if (options.dryRun) {
          dryRunLog('updating', 'task', taskId, updateData);
          return;
        }

        if (!(await confirmAction(`Update task ${taskId}?`, { yes: options.yes }))) {
          return;
        }

        const api = new TasksAPI(client);
        const task = await api.updateTask(taskId, updateData);

        if (options.json) {
          console.log(JSON.stringify(task, null, 2));
        } else {
          console.log(`✓ Task updated: ${task.taskId} (${task.name})`);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  tasksCommand
    .command('complete <taskId>')
    .description('Mark a task as completed')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .option('--card <card>', 'Card the task belongs to — required under a scope lock, since a taskId names no board')
    .action(async (taskId: string, options) => {
      const verbose = tasksCommand.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        await checkResolvedScope(client, () => boardOfCard(client, options.card), options.force);

        if (options.dryRun) {
          dryRunLog('completing', 'task', taskId);
          process.exit(0);
        }

        if (!(await confirmAction(`Complete task ${taskId}?`, { yes: options.yes }))) {
          process.exit(0);
        }

        const api = new TasksAPI(client);
        const task = await api.updateTask(taskId, true);

        if (options.json) {
          console.log(JSON.stringify(task, null, 2));
        } else {
          console.log(`✓ Task completed: ${task.taskId}`);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  tasksCommand
    .command('delete <taskId>')
    .description('Delete a task from a card')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .option('--card <card>', 'Card the task belongs to — required under a scope lock, since a taskId names no board')
    .action(async (taskId: string, options) => {
      const verbose = tasksCommand.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        await checkResolvedScope(client, () => boardOfCard(client, options.card), options.force);

        if (options.dryRun) {
          dryRunLog('deleting', 'task', taskId);
          return;
        }

        if (!(await confirmAction(`Delete task ${taskId}? This cannot be undone.`, { yes: options.yes }))) {
          return;
        }

        const api = new TasksAPI(client);
        await api.deleteTask(taskId);

        console.log(`✓ Task deleted: ${taskId}`);
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}
