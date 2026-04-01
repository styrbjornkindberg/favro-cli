/**
 * Tasklists Commands
 *
 * favro tasklists list <cardCommonId>
 * favro tasklists get <taskListId>
 * favro tasklists create <cardCommonId> --name "Checklist"
 * favro tasklists update <taskListId> --name "New name"
 * favro tasklists delete <taskListId>
 */
import { Command } from 'commander';
import TaskListsAPI from '../lib/tasklists-api';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';
import { confirmAction, dryRunLog } from '../lib/safety';

export function registerTaskListsCommands(program: Command): void {
  const cmd = program.command('tasklists').description('Manage checklist groups (task lists) on cards');

  cmd
    .command('list <cardCommonId>')
    .description('List all task lists on a card')
    .option('--json', 'Output as JSON')
    .action(async (cardCommonId: string, options) => {
      const verbose = cmd.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const api = new TaskListsAPI(client);
        const lists = await api.listTaskLists(cardCommonId);

        if (options.json) {
          console.log(JSON.stringify(lists, null, 2));
        } else {
          console.log(`Found ${lists.length} task list(s) on card ${cardCommonId}:`);
          const rows = lists.map(l => ({
            ID: l.taskListId,
            Name: l.name,
            Position: l.position ?? '—',
          }));
          console.table(rows);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  cmd
    .command('get <taskListId>')
    .description('Get a task list by ID')
    .option('--json', 'Output as JSON')
    .action(async (taskListId: string, options) => {
      const verbose = cmd.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const api = new TaskListsAPI(client);
        const list = await api.getTaskList(taskListId);

        if (options.json) {
          console.log(JSON.stringify(list, null, 2));
        } else {
          console.log(`Task List: ${list.name} (${list.taskListId})`);
          console.log(`Card: ${list.cardCommonId}`);
          if (list.position !== undefined) console.log(`Position: ${list.position}`);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  cmd
    .command('create <cardCommonId>')
    .description('Create a new task list on a card')
    .requiredOption('--name <name>', 'Task list name')
    .option('--position <number>', 'Position (0-based)')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (cardCommonId: string, options) => {
      const verbose = cmd.opts()?.verbose ?? false;
      try {
        if (options.dryRun) {
          dryRunLog('creating', 'task list', `"${options.name}" on card ${cardCommonId}`);
          return;
        }

        if (!(await confirmAction(`Create task list "${options.name}" on card ${cardCommonId}?`, { yes: options.yes }))) {
          return;
        }

        const client = await createFavroClient();
        const api = new TaskListsAPI(client);
        const pos = options.position !== undefined ? parseInt(options.position, 10) : undefined;
        const list = await api.createTaskList(cardCommonId, options.name, pos);

        if (options.json) {
          console.log(JSON.stringify(list, null, 2));
        } else {
          console.log(`✓ Task list created: ${list.taskListId} (${list.name})`);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  cmd
    .command('update <taskListId>')
    .description('Update a task list (rename or reposition)')
    .option('--name <name>', 'New task list name')
    .option('--position <number>', 'New position (0-based)')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (taskListId: string, options) => {
      const verbose = cmd.opts()?.verbose ?? false;
      try {
        const updateData: { name?: string; position?: number } = {};
        if (options.name) updateData.name = options.name;
        if (options.position !== undefined) updateData.position = parseInt(options.position, 10);

        if (Object.keys(updateData).length === 0) {
          console.error('Error: Provide at least one field: --name or --position');
          process.exit(1);
        }

        if (options.dryRun) {
          dryRunLog('updating', 'task list', taskListId, updateData);
          return;
        }

        if (!(await confirmAction(`Update task list ${taskListId}?`, { yes: options.yes }))) {
          return;
        }

        const client = await createFavroClient();
        const api = new TaskListsAPI(client);
        const list = await api.updateTaskList(taskListId, updateData);

        if (options.json) {
          console.log(JSON.stringify(list, null, 2));
        } else {
          console.log(`✓ Task list updated: ${list.taskListId} (${list.name})`);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  cmd
    .command('delete <taskListId>')
    .description('Delete a task list')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (taskListId: string, options) => {
      const verbose = cmd.opts()?.verbose ?? false;
      try {
        if (options.dryRun) {
          dryRunLog('deleting', 'task list', taskListId);
          return;
        }

        if (!(await confirmAction(`Delete task list ${taskListId}? This cannot be undone.`, { yes: options.yes }))) {
          return;
        }

        const client = await createFavroClient();
        const api = new TaskListsAPI(client);
        await api.deleteTaskList(taskListId);

        console.log(`✓ Task list deleted: ${taskListId}`);
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}
