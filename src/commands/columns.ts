/**
 * Columns Commands
 * CLA-1800 FAVRO-XXX: Columns Endpoints
 *
 * favro columns list <boardId>
 * favro columns create <boardId> --name "New State"
 * favro columns update <columnId> --name "Updated State"
 */
import { Command } from 'commander';
import ColumnsAPI from '../lib/columns-api';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';
import { checkScope, confirmAction, dryRunLog } from '../lib/safety';
import { readConfig } from '../lib/config';

export function registerColumnsCommands(program: Command): void {
  const columnsCommand = program.command('columns').description('Manage board columns/workflow states');

  columnsCommand
    .command('list <boardId>')
    .description('List all columns on a board')
    .option('--json', 'Output as JSON')
    .action(async (boardId: string, options) => {
      const verbose = columnsCommand.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const api = new ColumnsAPI(client);
        const columns = await api.listColumns(boardId);

        if (options.json) {
          console.log(JSON.stringify(columns, null, 2));
        } else {
          console.log(`Found ${columns.length} column(s) on board ${boardId}:`);
          const rows = columns.map(c => ({
            Position: c.position,
            ID: c.columnId,
            Name: c.name,
          }));
          console.table(rows);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  columnsCommand
    .command('create <boardId>')
    .description('Create a new column on a board')
    .requiredOption('--name <name>', 'Column name')
    .option('--position <position>', 'Column position (0-indexed)')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass bounds checking')
    .action(async (boardId: string, options) => {
      const verbose = columnsCommand.opts()?.verbose ?? false;
      try {
        const config = await readConfig();
        const client = await createFavroClient();
        
        await checkScope(boardId, client, config, options.force);

        const position = options.position !== undefined ? parseInt(options.position, 10) : undefined;
        
        if (options.dryRun) {
          dryRunLog('creating', 'column', `"${options.name}" on board ${boardId}`);
          process.exit(0);
        }

        if (!(await confirmAction(`Create column "${options.name}" on board ${boardId}?`, { yes: options.yes }))) {
          process.exit(0);
        }

        const api = new ColumnsAPI(client);
        const column = await api.createColumn(boardId, options.name, position);

        if (options.json) {
          console.log(JSON.stringify(column, null, 2));
        } else {
          console.log(`✓ Column created: ${column.columnId} (${column.name})`);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  columnsCommand
    .command('update <columnId>')
    .description('Update an existing column')
    .option('--name <name>', 'New column name')
    .option('--position <position>', 'New column position (0-indexed)')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass bounds checking')
    .action(async (columnId: string, options) => {
      const verbose = columnsCommand.opts()?.verbose ?? false;
      try {
        if (!options.name && options.position === undefined) {
          console.error('Error: specify --name or --position to update.');
          process.exit(1);
        }

        const client = await createFavroClient();
        const api = new ColumnsAPI(client);

        // Fetch column to check scope via its board
        const colMetadata = await api.getColumn(columnId);
        if (colMetadata) {
            const config = await readConfig();
            await checkScope(colMetadata.boardId, client, config, options.force);
        }

        const position = options.position !== undefined ? parseInt(options.position, 10) : undefined;
        
        if (options.dryRun) {
          dryRunLog('updating', 'column', columnId);
          process.exit(0);
        }

        if (!(await confirmAction(`Update column ${columnId}?`, { yes: options.yes }))) {
          process.exit(0);
        }

        const data: any = {};
        if (options.name) data.name = options.name;
        if (position !== undefined) data.position = position;

        const column = await api.updateColumn(columnId, data);

        if (options.json) {
          console.log(JSON.stringify(column, null, 2));
        } else {
          console.log(`✓ Column updated: ${column.columnId}`);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}
